import { ipcMain } from 'electron';
import Store from 'electron-store';
import * as fs from 'fs';
import { AgentDetector, AGENT_DEFINITIONS } from '../../agent-detector';
import { getAgentCapabilities } from '../../agent-capabilities';
import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { buildSshCommand, RemoteCommandOptions } from '../../utils/ssh-command-builder';
import { stripAnsi } from '../../utils/stripAnsi';
import { SshRemoteConfig } from '../../../shared/types';
import { MaestroSettings } from './persistence';

const LOG_CONTEXT = '[AgentDetector]';
const CONFIG_LOG_CONTEXT = '[AgentConfig]';

// Helper to create handler options with consistent context
const handlerOpts = (
	operation: string,
	context = LOG_CONTEXT
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context,
	operation,
});

/**
 * Interface for agent configuration store data
 */
interface AgentConfigsData {
	configs: Record<string, Record<string, any>>;
}

/**
 * Dependencies required for agents handler registration
 */
export interface AgentsHandlerDependencies {
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	/** The settings store (MaestroSettings) - required for SSH remote lookup */
	settingsStore?: Store<MaestroSettings>;
}

/**
 * Get SSH remote configuration by ID from the settings store.
 * Returns undefined if not found or store not provided.
 * Note: Does not check the 'enabled' flag - if user explicitly selects a remote, we should try to use it.
 */
function getSshRemoteById(
	store: Store<MaestroSettings> | undefined,
	sshRemoteId: string
): SshRemoteConfig | undefined {
	if (!store) {
		logger.warn(`${LOG_CONTEXT} Settings store not available for SSH remote lookup`, LOG_CONTEXT);
		return undefined;
	}

	const sshRemotes = store.get('sshRemotes', []) as SshRemoteConfig[];
	const config = sshRemotes.find((r) => r.id === sshRemoteId);

	if (!config) {
		logger.warn(`${LOG_CONTEXT} SSH remote not found: ${sshRemoteId}`, LOG_CONTEXT);
		return undefined;
	}

	return config;
}

/**
 * Helper to strip non-serializable functions from agent configs.
 * Agent configs can have function properties that cannot be sent over IPC:
 * - argBuilder in configOptions
 * - resumeArgs, modelArgs, workingDirArgs, imageArgs, promptArgs on the agent config
 */
function stripAgentFunctions(agent: any) {
	if (!agent) return null;

	// Destructure to remove function properties from agent config
	const {
		resumeArgs: _resumeArgs,
		modelArgs: _modelArgs,
		workingDirArgs: _workingDirArgs,
		imageArgs: _imageArgs,
		promptArgs: _promptArgs,
		...serializableAgent
	} = agent;

	return {
		...serializableAgent,
		configOptions: agent.configOptions?.map((opt: any) => {
			const { argBuilder: _argBuilder, ...serializableOpt } = opt;
			return serializableOpt;
		}),
	};
}

/**
 * Detect agents on a remote SSH host.
 * Uses 'which' command over SSH to check for agent binaries.
 * Includes a timeout to handle unreachable hosts gracefully.
 */
async function detectAgentsRemote(sshRemote: SshRemoteConfig): Promise<any[]> {
	const agents = [];
	const SSH_TIMEOUT_MS = 10000; // 10 second timeout per agent check

	// Track if we've had any successful connection to detect unreachable hosts
	let connectionSucceeded = false;
	let connectionError: string | undefined;

	for (const agentDef of AGENT_DEFINITIONS) {
		// Build SSH command to check for the binary using 'which'
		const remoteOptions: RemoteCommandOptions = {
			command: 'which',
			args: [agentDef.binaryName],
		};

		try {
			const sshCommand = await buildSshCommand(sshRemote, remoteOptions);

			// Execute with timeout
			const resultPromise = execFileNoThrow(sshCommand.command, sshCommand.args);
			const timeoutPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
				(_, reject) => {
					setTimeout(
						() => reject(new Error(`SSH connection timed out after ${SSH_TIMEOUT_MS / 1000}s`)),
						SSH_TIMEOUT_MS
					);
				}
			);

			const result = await Promise.race([resultPromise, timeoutPromise]);

			// Check for SSH connection errors in stderr
			if (
				result.stderr &&
				(result.stderr.includes('Connection refused') ||
					result.stderr.includes('Connection timed out') ||
					result.stderr.includes('No route to host') ||
					result.stderr.includes('Could not resolve hostname') ||
					result.stderr.includes('Permission denied'))
			) {
				connectionError = result.stderr.trim().split('\n')[0];
				logger.warn(`SSH connection error for ${sshRemote.host}: ${connectionError}`, LOG_CONTEXT);
			} else if (result.exitCode === 0 || result.exitCode === 1) {
				// Exit code 0 = found, 1 = not found (both indicate successful connection)
				connectionSucceeded = true;
			}

			// Strip ANSI/OSC escape sequences from output (shell integration sequences from interactive shells)
			const cleanedOutput = stripAnsi(result.stdout);
			const available = result.exitCode === 0 && cleanedOutput.trim().length > 0;
			const path = available ? cleanedOutput.trim().split('\n')[0] : undefined;

			if (available) {
				logger.info(`Agent "${agentDef.name}" found on remote at: ${path}`, LOG_CONTEXT);
			} else {
				logger.debug(`Agent "${agentDef.name}" not found on remote`, LOG_CONTEXT);
			}

			agents.push({
				...agentDef,
				available,
				path,
				capabilities: getAgentCapabilities(agentDef.id),
				error: connectionError,
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			connectionError = errorMessage;
			logger.warn(
				`Failed to check agent "${agentDef.name}" on remote: ${errorMessage}`,
				LOG_CONTEXT
			);
			agents.push({
				...agentDef,
				available: false,
				capabilities: getAgentCapabilities(agentDef.id),
				error: `Failed to connect: ${errorMessage}`,
			});
		}
	}

	// If no connection succeeded and we have an error, log a summary
	if (!connectionSucceeded && connectionError) {
		logger.error(
			`Failed to connect to SSH remote ${sshRemote.host}: ${connectionError}`,
			LOG_CONTEXT
		);
	}

	return agents;
}

/**
 * Register all Agent-related IPC handlers.
 *
 * These handlers provide agent detection and configuration management:
 * - Agent detection: detect, refresh, get
 * - Configuration: getConfig, setConfig, getConfigValue, setConfigValue
 * - Custom paths: setCustomPath, getCustomPath, getAllCustomPaths
 */
export function registerAgentsHandlers(deps: AgentsHandlerDependencies): void {
	const { getAgentDetector, agentConfigsStore, settingsStore } = deps;

	// Detect all available agents (supports SSH remote detection via optional sshRemoteId)
	ipcMain.handle(
		'agents:detect',
		withIpcErrorLogging(handlerOpts('detect'), async (sshRemoteId?: string) => {
			// If SSH remote ID provided, detect agents on remote host
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
				if (!sshConfig) {
					// Return all agents as unavailable with error info instead of throwing
					logger.warn(
						`SSH remote not found or disabled: ${sshRemoteId}, returning unavailable agents`,
						LOG_CONTEXT
					);
					return AGENT_DEFINITIONS.map((agentDef) =>
						stripAgentFunctions({
							...agentDef,
							available: false,
							path: undefined,
							capabilities: getAgentCapabilities(agentDef.id),
							error: `SSH remote configuration not found: ${sshRemoteId}`,
						})
					);
				}
				logger.info(`Detecting agents on remote host: ${sshConfig.host}`, LOG_CONTEXT);
				const agents = await detectAgentsRemote(sshConfig);
				logger.info(
					`Detected ${agents.filter((a: any) => a.available).length} agents on remote`,
					LOG_CONTEXT,
					{
						agents: agents.map((a: any) => a.id),
					}
				);
				return agents.map(stripAgentFunctions);
			}

			// Local detection
			const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
			logger.info('Detecting available agents', LOG_CONTEXT);
			const agents = await agentDetector.detectAgents();
			logger.info(`Detected ${agents.length} agents`, LOG_CONTEXT, {
				agents: agents.map((a) => a.id),
			});
			// Strip argBuilder functions before sending over IPC
			return agents.map(stripAgentFunctions);
		})
	);

	// Refresh agent detection with debug info (clears cache and returns detailed error info)
	ipcMain.handle(
		'agents:refresh',
		withIpcErrorLogging(handlerOpts('refresh'), async (agentId?: string) => {
			const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

			// Clear the cache to force re-detection
			agentDetector.clearCache();

			// Get environment info for debugging
			const envPath = process.env.PATH || '';
			const homeDir = process.env.HOME || '';

			// Detect all agents fresh
			const agents = await agentDetector.detectAgents();

			// If a specific agent was requested, return detailed debug info
			if (agentId) {
				const agent = agents.find((a) => a.id === agentId);
				const command = process.platform === 'win32' ? 'where' : 'which';

				// Try to find the binary manually to get error info
				const debugInfo = {
					agentId,
					available: agent?.available || false,
					path: agent?.path || null,
					binaryName: agent?.binaryName || agentId,
					envPath,
					homeDir,
					platform: process.platform,
					whichCommand: command,
					error: null as string | null,
				};

				if (!agent?.available) {
					// Try running which/where to get error output
					const result = await execFileNoThrow(command, [agent?.binaryName || agentId]);
					debugInfo.error =
						result.exitCode !== 0
							? `${command} ${agent?.binaryName || agentId} failed (exit code ${result.exitCode}): ${result.stderr || 'Binary not found in PATH'}`
							: null;
				}

				logger.info(`Agent refresh debug info for ${agentId}`, LOG_CONTEXT, debugInfo);
				return { agents: agents.map(stripAgentFunctions), debugInfo };
			}

			logger.info(`Refreshed agent detection`, LOG_CONTEXT, {
				agents: agents.map((a) => ({ id: a.id, available: a.available, path: a.path })),
			});
			return { agents: agents.map(stripAgentFunctions), debugInfo: null };
		})
	);

	// Get a specific agent by ID (supports SSH remote detection via optional sshRemoteId)
	ipcMain.handle(
		'agents:get',
		withIpcErrorLogging(handlerOpts('get'), async (agentId: string, sshRemoteId?: string) => {
			logger.debug(`Getting agent: ${agentId}`, LOG_CONTEXT, { sshRemoteId });

			// If SSH remote ID provided, detect agent on remote host
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
				if (!sshConfig) {
					logger.warn(`SSH remote not found or disabled: ${sshRemoteId}`, LOG_CONTEXT);
					// Return the agent definition with unavailable status
					const agentDef = AGENT_DEFINITIONS.find((a) => a.id === agentId);
					if (!agentDef) {
						throw new Error(`Unknown agent: ${agentId}`);
					}
					return stripAgentFunctions({
						...agentDef,
						available: false,
						path: undefined,
						capabilities: getAgentCapabilities(agentDef.id),
						error: `SSH remote configuration not found: ${sshRemoteId}`,
					});
				}

				logger.info(`Getting agent ${agentId} on remote host: ${sshConfig.host}`, LOG_CONTEXT);

				// Find the agent definition
				const agentDef = AGENT_DEFINITIONS.find((a) => a.id === agentId);
				if (!agentDef) {
					throw new Error(`Unknown agent: ${agentId}`);
				}

				// Build SSH command to check for the binary using 'which'
				const remoteOptions: RemoteCommandOptions = {
					command: 'which',
					args: [agentDef.binaryName],
				};

				try {
					const sshCommand = await buildSshCommand(sshConfig, remoteOptions);
					logger.info(`Executing SSH detection command for '${agentDef.binaryName}'`, LOG_CONTEXT, {
						command: sshCommand.command,
						args: sshCommand.args,
					});

					// Execute with timeout
					const SSH_TIMEOUT_MS = 10000;
					const resultPromise = execFileNoThrow(sshCommand.command, sshCommand.args);
					const timeoutPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
						(_, reject) => {
							setTimeout(
								() => reject(new Error(`SSH connection timed out after ${SSH_TIMEOUT_MS / 1000}s`)),
								SSH_TIMEOUT_MS
							);
						}
					);

					const result = await Promise.race([resultPromise, timeoutPromise]);

					logger.info(`SSH command result for '${agentDef.binaryName}'`, LOG_CONTEXT, {
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
					});

					// Check for SSH connection errors
					let connectionError: string | undefined;
					if (
						result.stderr &&
						(result.stderr.includes('Connection refused') ||
							result.stderr.includes('Connection timed out') ||
							result.stderr.includes('No route to host') ||
							result.stderr.includes('Could not resolve hostname') ||
							result.stderr.includes('Permission denied'))
					) {
						connectionError = result.stderr.trim().split('\n')[0];
						logger.warn(
							`SSH connection error for ${sshConfig.host}: ${connectionError}`,
							LOG_CONTEXT
						);
					}

					// Strip ANSI/OSC escape sequences from output
					const cleanedOutput = stripAnsi(result.stdout);
					const available = result.exitCode === 0 && cleanedOutput.trim().length > 0;
					const path = available ? cleanedOutput.trim().split('\n')[0] : undefined;

					if (available) {
						logger.info(`Agent "${agentDef.name}" found on remote at: ${path}`, LOG_CONTEXT);
					} else {
						logger.debug(`Agent "${agentDef.name}" not found on remote`, LOG_CONTEXT);
					}

					return stripAgentFunctions({
						...agentDef,
						available,
						path,
						capabilities: getAgentCapabilities(agentDef.id),
						error: connectionError,
					});
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					logger.warn(
						`Failed to check agent "${agentDef.name}" on remote: ${errorMessage}`,
						LOG_CONTEXT
					);
					return stripAgentFunctions({
						...agentDef,
						available: false,
						capabilities: getAgentCapabilities(agentDef.id),
						error: `Failed to connect: ${errorMessage}`,
					});
				}
			}

			// Local detection
			const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
			const agent = await agentDetector.getAgent(agentId);

			// Debug logging for agent availability
			logger.debug(`Agent retrieved: ${agentId}`, LOG_CONTEXT, {
				available: agent?.available,
				hasPath: !!agent?.path,
				path: agent?.path,
				command: agent?.command,
				hasCustomPath: !!agent?.customPath,
				customPath: agent?.customPath,
			});

			// Strip argBuilder functions before sending over IPC
			return stripAgentFunctions(agent);
		})
	);

	// Get capabilities for a specific agent
	ipcMain.handle(
		'agents:getCapabilities',
		withIpcErrorLogging(handlerOpts('getCapabilities'), async (agentId: string) => {
			logger.debug(`Getting capabilities for agent: ${agentId}`, LOG_CONTEXT);
			return getAgentCapabilities(agentId);
		})
	);

	// Get all configuration for an agent
	// Merges stored config with defaults from agent's configOptions
	ipcMain.handle(
		'agents:getConfig',
		withIpcErrorLogging(handlerOpts('getConfig', CONFIG_LOG_CONTEXT), async (agentId: string) => {
			const allConfigs = agentConfigsStore.get('configs', {});
			const storedConfig = allConfigs[agentId] || {};

			// Get defaults from agent definition's configOptions
			const agentDef = AGENT_DEFINITIONS.find((a) => a.id === agentId);
			const defaults: Record<string, unknown> = {};
			if (agentDef?.configOptions) {
				for (const option of agentDef.configOptions) {
					if (option.default !== undefined) {
						defaults[option.key] = option.default;
					}
				}
			}

			// Merge: stored config takes precedence over defaults
			return { ...defaults, ...storedConfig };
		})
	);

	// Set all configuration for an agent
	ipcMain.handle(
		'agents:setConfig',
		withIpcErrorLogging(
			handlerOpts('setConfig', CONFIG_LOG_CONTEXT),
			async (agentId: string, config: Record<string, unknown>) => {
				const allConfigs = agentConfigsStore.get('configs', {});
				allConfigs[agentId] = config;
				agentConfigsStore.set('configs', allConfigs);
				logger.info(`Updated config for agent: ${agentId}`, CONFIG_LOG_CONTEXT, config);
				return true;
			}
		)
	);

	// Get a specific configuration value for an agent
	// Falls back to default from agent's configOptions if not stored
	ipcMain.handle(
		'agents:getConfigValue',
		withIpcErrorLogging(
			handlerOpts('getConfigValue', CONFIG_LOG_CONTEXT),
			async (agentId: string, key: string) => {
				const allConfigs = agentConfigsStore.get('configs', {});
				const agentConfig = allConfigs[agentId] || {};

				// Return stored value if present
				if (agentConfig[key] !== undefined) {
					return agentConfig[key];
				}

				// Fall back to default from agent definition
				const agentDef = AGENT_DEFINITIONS.find((a) => a.id === agentId);
				const option = agentDef?.configOptions?.find((o) => o.key === key);
				return option?.default;
			}
		)
	);

	// Set a specific configuration value for an agent
	ipcMain.handle(
		'agents:setConfigValue',
		withIpcErrorLogging(
			handlerOpts('setConfigValue', CONFIG_LOG_CONTEXT),
			async (agentId: string, key: string, value: unknown) => {
				const allConfigs = agentConfigsStore.get('configs', {});
				if (!allConfigs[agentId]) {
					allConfigs[agentId] = {};
				}
				allConfigs[agentId][key] = value;
				agentConfigsStore.set('configs', allConfigs);
				logger.debug(`Updated config ${key} for agent ${agentId}`, CONFIG_LOG_CONTEXT, { value });
				return true;
			}
		)
	);

	// Set custom path for an agent - used when agent is not in standard PATH locations
	ipcMain.handle(
		'agents:setCustomPath',
		withIpcErrorLogging(
			handlerOpts('setCustomPath', CONFIG_LOG_CONTEXT),
			async (agentId: string, customPath: string | null) => {
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				const allConfigs = agentConfigsStore.get('configs', {});
				if (!allConfigs[agentId]) {
					allConfigs[agentId] = {};
				}

				if (customPath) {
					allConfigs[agentId].customPath = customPath;
					logger.info(`Set custom path for agent ${agentId}: ${customPath}`, CONFIG_LOG_CONTEXT);
				} else {
					delete allConfigs[agentId].customPath;
					logger.info(`Cleared custom path for agent ${agentId}`, CONFIG_LOG_CONTEXT);
				}

				agentConfigsStore.set('configs', allConfigs);

				// Update agent detector with all custom paths
				const allCustomPaths: Record<string, string> = {};
				for (const [id, config] of Object.entries(allConfigs)) {
					if (config && typeof config === 'object' && 'customPath' in config && config.customPath) {
						allCustomPaths[id] = config.customPath as string;
					}
				}
				agentDetector.setCustomPaths(allCustomPaths);

				return true;
			}
		)
	);

	// Get custom path for an agent
	ipcMain.handle(
		'agents:getCustomPath',
		withIpcErrorLogging(
			handlerOpts('getCustomPath', CONFIG_LOG_CONTEXT),
			async (agentId: string) => {
				const allConfigs = agentConfigsStore.get('configs', {});
				return allConfigs[agentId]?.customPath || null;
			}
		)
	);

	// Get all custom paths for agents
	ipcMain.handle(
		'agents:getAllCustomPaths',
		withIpcErrorLogging(handlerOpts('getAllCustomPaths', CONFIG_LOG_CONTEXT), async () => {
			const allConfigs = agentConfigsStore.get('configs', {});
			const customPaths: Record<string, string> = {};
			for (const [agentId, config] of Object.entries(allConfigs)) {
				if (config && typeof config === 'object' && 'customPath' in config && config.customPath) {
					customPaths[agentId] = config.customPath as string;
				}
			}
			return customPaths;
		})
	);

	// Set custom CLI arguments for an agent - arbitrary args appended to all agent invocations
	ipcMain.handle(
		'agents:setCustomArgs',
		withIpcErrorLogging(
			handlerOpts('setCustomArgs', CONFIG_LOG_CONTEXT),
			async (agentId: string, customArgs: string | null) => {
				const allConfigs = agentConfigsStore.get('configs', {});
				if (!allConfigs[agentId]) {
					allConfigs[agentId] = {};
				}

				if (customArgs && customArgs.trim()) {
					allConfigs[agentId].customArgs = customArgs.trim();
					logger.info(`Set custom args for agent ${agentId}: ${customArgs}`, CONFIG_LOG_CONTEXT);
				} else {
					delete allConfigs[agentId].customArgs;
					logger.info(`Cleared custom args for agent ${agentId}`, CONFIG_LOG_CONTEXT);
				}

				agentConfigsStore.set('configs', allConfigs);
				return true;
			}
		)
	);

	// Get custom CLI arguments for an agent
	ipcMain.handle(
		'agents:getCustomArgs',
		withIpcErrorLogging(
			handlerOpts('getCustomArgs', CONFIG_LOG_CONTEXT),
			async (agentId: string) => {
				const allConfigs = agentConfigsStore.get('configs', {});
				return allConfigs[agentId]?.customArgs || null;
			}
		)
	);

	// Get all custom CLI arguments for agents
	ipcMain.handle(
		'agents:getAllCustomArgs',
		withIpcErrorLogging(handlerOpts('getAllCustomArgs', CONFIG_LOG_CONTEXT), async () => {
			const allConfigs = agentConfigsStore.get('configs', {});
			const customArgs: Record<string, string> = {};
			for (const [agentId, config] of Object.entries(allConfigs)) {
				if (config && typeof config === 'object' && 'customArgs' in config && config.customArgs) {
					customArgs[agentId] = config.customArgs as string;
				}
			}
			return customArgs;
		})
	);

	// Set custom environment variables for an agent - passed to all agent invocations
	ipcMain.handle(
		'agents:setCustomEnvVars',
		withIpcErrorLogging(
			handlerOpts('setCustomEnvVars', CONFIG_LOG_CONTEXT),
			async (agentId: string, customEnvVars: Record<string, string> | null) => {
				const allConfigs = agentConfigsStore.get('configs', {});
				if (!allConfigs[agentId]) {
					allConfigs[agentId] = {};
				}

				if (customEnvVars && Object.keys(customEnvVars).length > 0) {
					allConfigs[agentId].customEnvVars = customEnvVars;
					logger.info(`Set custom env vars for agent ${agentId}`, CONFIG_LOG_CONTEXT, {
						keys: Object.keys(customEnvVars),
					});
				} else {
					delete allConfigs[agentId].customEnvVars;
					logger.info(`Cleared custom env vars for agent ${agentId}`, CONFIG_LOG_CONTEXT);
				}

				agentConfigsStore.set('configs', allConfigs);
				return true;
			}
		)
	);

	// Get custom environment variables for an agent
	ipcMain.handle(
		'agents:getCustomEnvVars',
		withIpcErrorLogging(
			handlerOpts('getCustomEnvVars', CONFIG_LOG_CONTEXT),
			async (agentId: string) => {
				const allConfigs = agentConfigsStore.get('configs', {});
				return allConfigs[agentId]?.customEnvVars || null;
			}
		)
	);

	// Get all custom environment variables for agents
	ipcMain.handle(
		'agents:getAllCustomEnvVars',
		withIpcErrorLogging(handlerOpts('getAllCustomEnvVars', CONFIG_LOG_CONTEXT), async () => {
			const allConfigs = agentConfigsStore.get('configs', {});
			const customEnvVars: Record<string, Record<string, string>> = {};
			for (const [agentId, config] of Object.entries(allConfigs)) {
				if (
					config &&
					typeof config === 'object' &&
					'customEnvVars' in config &&
					config.customEnvVars
				) {
					customEnvVars[agentId] = config.customEnvVars as Record<string, string>;
				}
			}
			return customEnvVars;
		})
	);

	// Discover available models for an agent that supports model selection
	ipcMain.handle(
		'agents:getModels',
		withIpcErrorLogging(
			handlerOpts('getModels'),
			async (agentId: string, forceRefresh?: boolean) => {
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
				logger.info(`Discovering models for agent: ${agentId}`, LOG_CONTEXT, { forceRefresh });
				const models = await agentDetector.discoverModels(agentId, forceRefresh ?? false);
				return models;
			}
		)
	);

	// Discover available slash commands for an agent by spawning it briefly
	// This allows the UI to show available commands before the user sends their first message
	ipcMain.handle(
		'agents:discoverSlashCommands',
		withIpcErrorLogging(
			handlerOpts('discoverSlashCommands'),
			async (agentId: string, cwd: string, customPath?: string) => {
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
				logger.info(`Discovering slash commands for agent: ${agentId} in ${cwd}`, LOG_CONTEXT);

				const agent = await agentDetector.getAgent(agentId);
				if (!agent?.available) {
					logger.warn(`Agent ${agentId} not available for slash command discovery`, LOG_CONTEXT);
					return null;
				}

				// Only Claude Code supports slash command discovery via init message
				if (agentId !== 'claude-code') {
					logger.debug(`Agent ${agentId} does not support slash command discovery`, LOG_CONTEXT);
					return null;
				}

				try {
					// Use custom path if provided, otherwise use detected path
					const commandPath = customPath || agent.path || agent.command;

					// Check if the command path exists before attempting to spawn
					if (!fs.existsSync(commandPath)) {
						logger.warn(
							`Command path does not exist for slash command discovery: ${commandPath}`,
							LOG_CONTEXT
						);
						return null;
					}

					// Spawn Claude with /help which immediately exits and costs no tokens
					// The init message contains all available slash commands
					const args = [
						'--print',
						'--verbose',
						'--output-format',
						'stream-json',
						'--dangerously-skip-permissions',
						'--',
						'/help',
					];

					logger.debug(
						`Spawning for slash command discovery: ${commandPath} ${args.join(' ')}`,
						LOG_CONTEXT
					);

					const result = await execFileNoThrow(commandPath, args, cwd);

					if (result.exitCode !== 0 && !result.stdout) {
						logger.warn(
							`Slash command discovery failed with exit code ${result.exitCode}`,
							LOG_CONTEXT,
							{
								stderr: result.stderr?.substring(0, 500),
							}
						);
						return null;
					}

					// Parse the first JSON line to get the init message
					const lines = result.stdout.split('\n');
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const msg = JSON.parse(line);
							if (msg.type === 'system' && msg.subtype === 'init' && msg.slash_commands) {
								logger.info(
									`Discovered ${msg.slash_commands.length} slash commands for ${agentId}`,
									LOG_CONTEXT
								);
								return msg.slash_commands as string[];
							}
						} catch {
							// Not valid JSON, skip
						}
					}

					logger.warn(`No init message found in slash command discovery output`, LOG_CONTEXT);
					return null;
				} catch (error) {
					logger.error(`Error discovering slash commands for ${agentId}`, LOG_CONTEXT, {
						error: String(error),
					});
					return null;
				}
			}
		)
	);
}
