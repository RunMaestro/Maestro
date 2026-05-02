import { ipcMain } from 'electron';
import Store from 'electron-store';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentConfigsData } from '../../stores/types';
import {
	AgentDetector,
	AGENT_DEFINITIONS,
	getAgentCapabilities,
	parseOpenCodeConfig,
	extractModelsFromConfig,
	getOpenCodeConfigPaths,
	getOpenCodeCommandDirs,
} from '../../agents';
import {
	DEFAULT_AGENT_DISPATCH_PROFILE,
	DEFAULT_AGENT_DISPATCH_SETTINGS,
	type AgentDispatchProfile,
	type AgentDispatchSettings,
} from '../../../shared/agent-dispatch-types';
import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import { getWhichCommand } from '../../../shared/platformDetection';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { buildSshCommand, RemoteCommandOptions } from '../../utils/ssh-command-builder';
import { stripAnsi } from '../../utils/stripAnsi';
import { SshRemoteConfig } from '../../../shared/types';
import { MaestroSettings } from './persistence';
import { captureException } from '../../utils/sentry';

const LOG_CONTEXT = '[AgentDetector]';
const CONFIG_LOG_CONTEXT = '[AgentConfig]';
const DISPATCH_SETTINGS_KEY = 'dispatchSettings';
const DISPATCH_PROFILE_KEY = 'dispatchProfile';

// Helper to create handler options with consistent context
const handlerOpts = (
	operation: string,
	context = LOG_CONTEXT
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context,
	operation,
});

// Copilot CLI built-in slash commands (always available in interactive mode)
const COPILOT_BUILTIN_COMMANDS = [
	'help',
	'clear',
	'compact',
	'context',
	'model',
	'usage',
	'session',
	'share',
	'mcp',
	'fleet',
	'tasks',
	'delegate',
	'review',
];

/**
 * Discover GitHub Copilot CLI slash commands.
 *
 * Unlike Claude Code (which emits commands via its init JSON event), Copilot
 * commands are interactive-only and cannot be discovered by spawning the CLI
 * in batch mode.  We return a static list of well-documented built-in commands.
 */
function discoverCopilotSlashCommands(): { name: string; description: string }[] {
	logger.info(`Discovered ${COPILOT_BUILTIN_COMMANDS.length} Copilot slash commands`, LOG_CONTEXT);
	return COPILOT_BUILTIN_COMMANDS.map((cmd) => ({ name: cmd, description: '' }));
}

/**
 * Discover OpenCode slash commands by reading from disk.
 *
 * OpenCode commands come from these sources (checked in priority order):
 * 1. Project-local custom commands: .opencode/commands/*.md
 * 2. User-global custom commands: ~/.opencode/commands/*.md
 * 3. XDG custom commands: $XDG_CONFIG_HOME/opencode/commands/*.md
 * 4. Config-based commands from opencode.json "command" property, resolved
 *    platform-aware: OPENCODE_CONFIG env var (if set), then project-local,
 *    then platform-specific locations (POSIX: ~/.opencode/, ~/.config/opencode/;
 *    Windows: %LOCALAPPDATA%/opencode/)
 *
 * Built-in commands (init, review, undo, redo, share, help, models) are excluded
 * because they only work in OpenCode's interactive TUI mode — they have no prompt
 * .md file and cannot be executed via batch mode (`opencode run`).
 *
 * Unlike Claude Code (which emits commands via init event), OpenCode commands
 * are statically defined on disk and can be discovered without spawning the agent.
 */
interface DiscoveredCommand {
	name: string;
	prompt?: string; // .md file content for custom commands; absent for built-ins
	description?: string; // frontmatter description for Claude Code skills; absent otherwise
}

/**
 * Read descriptions for Claude Code skills from disk.
 *
 * Claude Code emits skill names via its init message but without descriptions,
 * so we read the frontmatter from each skill's SKILL.md (with skill.md fallback
 * for legacy layouts). Project-local skills take precedence over user-level skills.
 *
 * Returns a map of skill directory name → description. Names with no description
 * frontmatter are omitted rather than returned as empty strings, so the renderer
 * can fall back to its built-in description table.
 */
async function readClaudeSkillDescriptions(cwd: string): Promise<Map<string, string>> {
	const descriptions = new Map<string, string>();
	const homeDir = os.homedir();
	const skillDirs = [
		path.join(cwd, '.claude', 'skills'), // project-local (wins)
		path.join(homeDir, '.claude', 'skills'), // user-level
	];

	// Extract the YAML frontmatter block from a file so we don't pick up a
	// body line that happens to start with "description:". Matches the
	// bounded parser used by scanSkillsDir in claude.ts.
	const extractFrontmatter = (content: string): string | null => {
		const trimmed = content.trimStart();
		if (!trimmed.startsWith('---')) return null;
		const endIndex = trimmed.indexOf('\n---', 3);
		if (endIndex === -1) return null;
		return trimmed.slice(3, endIndex);
	};

	for (const dir of skillDirs) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (error) {
			// Missing skills directory is the norm — skip. Anything else
			// (permission errors, IO errors) should surface to Sentry.
			if (isMissingEntryError(error)) continue;
			throw error;
		}
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (descriptions.has(entry.name)) continue; // project-local already set
			for (const candidate of ['SKILL.md', 'skill.md']) {
				let content: string;
				try {
					content = await fs.promises.readFile(path.join(dir, entry.name, candidate), 'utf-8');
				} catch (error) {
					if (isMissingEntryError(error)) continue;
					throw error;
				}
				const frontmatter = extractFrontmatter(content);
				if (frontmatter) {
					const match = frontmatter.match(/^description:\s*(.+)$/m);
					if (match) {
						descriptions.set(entry.name, match[1].trim().replace(/^["']|["']$/g, ''));
					}
				}
				break;
			}
		}
	}

	return descriptions;
}

function isMissingEntryError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

async function discoverOpenCodeSlashCommands(cwd: string): Promise<DiscoveredCommand[]> {
	const commands = new Map<string, DiscoveredCommand>();

	// Strip YAML frontmatter (---\n...\n---) from command file content,
	// returning only the body text that serves as the prompt.
	const stripFrontmatter = (content: string): string => {
		const trimmed = content.trimStart();
		if (!trimmed.startsWith('---')) return content;
		const endIndex = trimmed.indexOf('\n---', 3);
		if (endIndex === -1) return content;
		return trimmed.slice(endIndex + 4).trim();
	};

	// Helper: read .md files from a commands directory (name + content)
	const addCommandsFromDir = async (dir: string) => {
		let files: string[];
		try {
			files = await fs.promises.readdir(dir);
		} catch (error: any) {
			if (error?.code === 'ENOENT') {
				logger.debug(`OpenCode commands directory not found: ${dir}`, LOG_CONTEXT);
				return;
			}
			throw error;
		}
		for (const file of files) {
			if (!file.endsWith('.md')) continue;
			const name = file.replace(/\.md$/, '');
			if (commands.has(name)) continue; // project-local wins over global
			try {
				const raw = await fs.promises.readFile(path.join(dir, file), 'utf-8');
				const prompt = stripFrontmatter(raw);
				commands.set(name, { name, prompt: prompt || undefined });
			} catch (error: any) {
				if (error?.code !== 'ENOENT') throw error;
			}
		}
	};

	// Helper: read command definitions from an opencode.json config file
	const addCommandsFromConfig = async (configPath: string) => {
		let content: string;
		try {
			content = await fs.promises.readFile(configPath, 'utf-8');
		} catch (error: any) {
			if (error?.code === 'ENOENT') {
				logger.debug(`OpenCode config not found: ${configPath}`, LOG_CONTEXT);
				return;
			}
			throw error;
		}
		const config = parseOpenCodeConfig(content);
		if (!config) {
			logger.warn(`OpenCode config has invalid JSON, skipping: ${configPath}`, LOG_CONTEXT);
			return;
		}
		if (config.command && typeof config.command === 'object' && !Array.isArray(config.command)) {
			for (const [name, value] of Object.entries(config.command)) {
				if (commands.has(name)) continue;
				const prompt =
					typeof value === 'string'
						? value
						: typeof (value as any)?.prompt === 'string'
							? (value as any).prompt
							: undefined;
				commands.set(name, { name, prompt });
			}
		}
	};

	// Probe command directories and config files using shared path resolution
	for (const dir of getOpenCodeCommandDirs(cwd)) {
		await addCommandsFromDir(dir);
	}

	for (const configPath of getOpenCodeConfigPaths(cwd)) {
		await addCommandsFromConfig(configPath);
	}

	const commandList = Array.from(commands.values());
	logger.info(`Discovered ${commandList.length} OpenCode slash commands`, LOG_CONTEXT);
	return commandList;
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
 * - resumeArgs, modelArgs, workingDirArgs, imageArgs, imagePromptBuilder, promptArgs on the agent config
 */
function stripAgentFunctions(agent: any) {
	if (!agent) return null;

	// Destructure to remove function properties from agent config
	const {
		resumeArgs: _resumeArgs,
		modelArgs: _modelArgs,
		workingDirArgs: _workingDirArgs,
		imageArgs: _imageArgs,
		imagePromptBuilder: _imagePromptBuilder,
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
 * Uses POSIX 'command -v' over SSH to check for agent binaries.
 * Includes a timeout to handle unreachable hosts gracefully.
 */
async function detectAgentsRemote(sshRemote: SshRemoteConfig): Promise<any[]> {
	const agents = [];
	const SSH_TIMEOUT_MS = 10000; // 10 second timeout per agent check

	// Track if we've had any successful connection to detect unreachable hosts
	let connectionSucceeded = false;
	let connectionError: string | undefined;

	for (const agentDef of AGENT_DEFINITIONS) {
		// Build SSH command to check for the binary using POSIX 'command -v'.
		// Preferred over 'which' because it's a shell builtin (no PATH lookup needed),
		// avoids /usr/bin/which on hosts without it, and behaves consistently across
		// bash/dash/zsh. The command runs inside /bin/bash via buildSshCommand().
		const remoteOptions: RemoteCommandOptions = {
			command: 'command',
			args: ['-v', agentDef.binaryName],
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

// Remote model discovery cache
const remoteModelCache = new Map<string, { models: string[]; timestamp: number }>();
const REMOTE_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const SSH_MODEL_TIMEOUT_MS = 10000;

/**
 * Read OpenCode config files from a remote SSH host and extract model IDs.
 *
 * Probes the same config paths OpenCode uses on POSIX systems:
 *   ~/.opencode/opencode.json, ~/.opencode.json, ~/.config/opencode/opencode.json
 *
 * Uses a single SSH command with a shell script that cats each file, avoiding
 * multiple round-trips. Returns unique model IDs in provider/model format.
 */
async function discoverModelsFromRemoteConfigs(sshRemote: SshRemoteConfig): Promise<string[]> {
	// Shell script that probes each config path and prints its content with delimiters.
	// We use a delimiter so we can split multiple config files from a single stdout.
	const configPaths = [
		'~/.opencode/opencode.json',
		'~/.opencode.json',
		'${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json',
	];

	// Build a script that cats each config file if it exists
	const catScript = configPaths
		.map(
			(p) =>
				`if [ -f ${p} ]; then echo "___OPENCODE_CONFIG_START___"; cat ${p}; echo "___OPENCODE_CONFIG_END___"; fi`
		)
		.join('; ');

	const remoteOptions: RemoteCommandOptions = {
		command: 'sh',
		args: ['-c', catScript],
		env: sshRemote.remoteEnv,
	};

	try {
		const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
		const resultPromise = execFileNoThrow(sshCommand.command, sshCommand.args);
		const timeoutPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
			(_, reject) => {
				setTimeout(() => reject(new Error('SSH config read timed out')), SSH_MODEL_TIMEOUT_MS);
			}
		);

		const result = await Promise.race([resultPromise, timeoutPromise]);

		if (result.exitCode !== 0 || !result.stdout.includes('___OPENCODE_CONFIG_START___')) {
			return [];
		}

		// Parse delimited config blocks from stdout
		const seen = new Set<string>();
		const models: string[] = [];
		const blocks = result.stdout.split('___OPENCODE_CONFIG_START___').slice(1);

		for (const block of blocks) {
			const endIdx = block.indexOf('___OPENCODE_CONFIG_END___');
			const jsonStr = endIdx >= 0 ? block.slice(0, endIdx).trim() : block.trim();
			if (!jsonStr) continue;

			const config = parseOpenCodeConfig(jsonStr);
			if (!config) continue;

			for (const modelId of extractModelsFromConfig(config)) {
				if (!seen.has(modelId)) {
					seen.add(modelId);
					models.push(modelId);
				}
			}
		}

		if (models.length > 0) {
			logger.info(
				`Extracted ${models.length} models from remote OpenCode configs on ${sshRemote.host}`,
				LOG_CONTEXT,
				{ models }
			);
		}

		return models;
	} catch (error) {
		if (error instanceof Error && error.message.includes('timed out')) {
			logger.warn(`Timed out reading remote OpenCode configs on ${sshRemote.host}`, LOG_CONTEXT);
			return [];
		}
		// Non-fatal: config reading failure shouldn't block CLI-based discovery
		logger.warn(`Failed to read remote OpenCode configs on ${sshRemote.host}`, LOG_CONTEXT, {
			error,
		});
		return [];
	}
}

/**
 * Discover available models for an agent on a remote SSH host.
 * Uses the agent's `models` subcommand over SSH, supplemented by models
 * from remote opencode.json config files for OpenCode agents.
 * Returns an empty array on timeout, non-zero exit, or unknown agent.
 * Throws on unexpected errors (e.g., SSH config issues, parsing bugs).
 */
async function discoverModelsRemote(
	agentId: string,
	sshRemote: SshRemoteConfig,
	forceRefresh: boolean
): Promise<string[]> {
	const cacheKey = `${agentId}:${sshRemote.id}`;

	// Check cache unless force refresh
	if (!forceRefresh) {
		const cached = remoteModelCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < REMOTE_MODEL_CACHE_TTL_MS) {
			logger.info(`Using cached remote models for ${agentId} on ${sshRemote.host}`, LOG_CONTEXT);
			return cached.models;
		}
	}

	// Look up the agent's binary name
	const agentDef = AGENT_DEFINITIONS.find((a) => a.id === agentId);
	if (!agentDef) {
		logger.warn(`Unknown agent for remote model discovery: ${agentId}`, LOG_CONTEXT);
		return [];
	}

	const remoteOptions: RemoteCommandOptions = {
		command: agentDef.binaryName,
		args: ['models'],
		env: sshRemote.remoteEnv,
	};

	try {
		const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
		logger.info(
			`Discovering models for "${agentDef.name}" on remote ${sshRemote.host}`,
			LOG_CONTEXT
		);

		// Execute with timeout matching detectAgentsRemote pattern
		const resultPromise = execFileNoThrow(sshCommand.command, sshCommand.args);
		const timeoutPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
			(_, reject) => {
				setTimeout(
					() =>
						reject(
							new Error(`SSH model discovery timed out after ${SSH_MODEL_TIMEOUT_MS / 1000}s`)
						),
					SSH_MODEL_TIMEOUT_MS
				);
			}
		);

		const result = await Promise.race([resultPromise, timeoutPromise]);

		if (result.exitCode !== 0) {
			logger.warn(
				`Remote model discovery for "${agentDef.name}" exited with code ${result.exitCode}`,
				LOG_CONTEXT,
				{ stderr: result.stderr }
			);
			return [];
		}

		const seen = new Set<string>();
		const models: string[] = [];

		// Source 1: CLI-discovered models
		const cliModels = stripAnsi(result.stdout)
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		for (const m of cliModels) {
			if (!seen.has(m)) {
				seen.add(m);
				models.push(m);
			}
		}

		// Source 2: Remote opencode.json config files (OpenCode only)
		if (agentId === 'opencode') {
			const configModels = await discoverModelsFromRemoteConfigs(sshRemote);
			for (const m of configModels) {
				if (!seen.has(m)) {
					seen.add(m);
					models.push(m);
				}
			}
		}

		logger.info(
			`Discovered ${models.length} models for "${agentDef.name}" on remote ${sshRemote.host}`,
			LOG_CONTEXT
		);

		// Cache the result
		remoteModelCache.set(cacheKey, { models, timestamp: Date.now() });

		return models;
	} catch (error) {
		// Timeout is an expected SSH failure — return empty gracefully
		if (error instanceof Error && error.message.includes('SSH model discovery timed out')) {
			logger.warn(
				`Timed out discovering models for "${agentDef.name}" on ${sshRemote.host}`,
				LOG_CONTEXT
			);
			return [];
		}
		// Unexpected errors should propagate to withIpcErrorLogging / Sentry
		throw error;
	}
}

/**
 * Register all Agent-related IPC handlers.
 *
 * These handlers provide agent detection and configuration management:
 * - Agent detection: detect, refresh, get
 * - Configuration: getConfig, setConfig, getConfigValue, setConfigValue
 * - Custom paths: setCustomPath, getCustomPath, getAllCustomPaths
 */
/**
 * Discover OpenCode slash commands from a remote SSH host.
 *
 * Reads .opencode/commands/*.md files and opencode.json command definitions
 * from the remote host using a single SSH invocation with execFileNoThrow.
 */
async function discoverOpenCodeSlashCommandsRemote(
	sshRemote: SshRemoteConfig,
	cwd: string
): Promise<DiscoveredCommand[]> {
	// Shell script probes command directories and config files on the remote host.
	// All paths are static (no user-controlled interpolation).
	const commandDirs = [
		`${cwd}/.opencode/commands`,
		'~/.opencode/commands',
		'${XDG_CONFIG_HOME:-$HOME/.config}/opencode/commands',
	];
	const configPaths = [
		`${cwd}/opencode.json`,
		'~/.opencode/opencode.json',
		'~/.opencode.json',
		'${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json',
	];

	const dirScript = commandDirs
		.map(
			(dir) =>
				`if [ -d ${dir} ]; then for f in ${dir}/*.md; do [ -f "$f" ] && echo "___CMD_FILE_START___ $(basename "$f")" && cat "$f" && echo "___CMD_FILE_END___"; done; fi`
		)
		.join('; ');

	const configScript = configPaths
		.map(
			(p) =>
				`if [ -f ${p} ]; then echo "___OPENCODE_CONFIG_START___"; cat ${p}; echo "___OPENCODE_CONFIG_END___"; fi`
		)
		.join('; ');

	const fullScript = `${dirScript}; ${configScript}`;

	const remoteOptions: RemoteCommandOptions = {
		command: 'sh',
		args: ['-c', fullScript],
		env: sshRemote.remoteEnv,
	};

	try {
		const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
		const resultPromise = execFileNoThrow(sshCommand.command, sshCommand.args);
		const timeoutPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
			(_, reject) => {
				setTimeout(
					() => reject(new Error('SSH slash command discovery timed out')),
					SSH_MODEL_TIMEOUT_MS
				);
			}
		);

		const result = await Promise.race([resultPromise, timeoutPromise]);
		if (result.exitCode !== 0 && !result.stdout) {
			logger.warn(`Remote slash command discovery failed on ${sshRemote.host}`, LOG_CONTEXT, {
				exitCode: result.exitCode,
				stderr: result.stderr?.substring(0, 500),
			});
			return [];
		}

		const commands = new Map<string, DiscoveredCommand>();
		const output = result.stdout;

		// Parse .md command files
		const cmdFileRegex = /___CMD_FILE_START___ (.+?)\n([\s\S]*?)___CMD_FILE_END___/g;
		let match: RegExpExecArray | null;
		while ((match = cmdFileRegex.exec(output)) !== null) {
			const filename = match[1].trim();
			const content = match[2].trim();
			const name = filename.replace(/\.md$/, '');
			if (!commands.has(name)) {
				// Strip YAML frontmatter
				let prompt = content;
				const trimmed = prompt.trimStart();
				if (trimmed.startsWith('---')) {
					const endIndex = trimmed.indexOf('\n---', 3);
					if (endIndex !== -1) {
						prompt = trimmed.slice(endIndex + 4).trim();
					}
				}
				commands.set(name, { name, prompt: prompt || undefined });
			}
		}

		// Parse config file command definitions
		const configBlocks = output.split('___OPENCODE_CONFIG_START___').slice(1);
		for (const block of configBlocks) {
			const endIdx = block.indexOf('___OPENCODE_CONFIG_END___');
			const jsonStr = endIdx >= 0 ? block.slice(0, endIdx).trim() : block.trim();
			if (!jsonStr) continue;

			const config = parseOpenCodeConfig(jsonStr);
			if (!config?.command || typeof config.command !== 'object') continue;

			for (const [name, value] of Object.entries(config.command)) {
				if (commands.has(name)) continue;
				const prompt =
					typeof value === 'string'
						? value
						: typeof (value as any)?.prompt === 'string'
							? (value as any).prompt
							: undefined;
				commands.set(name, { name, prompt });
			}
		}

		const commandList = Array.from(commands.values());
		logger.info(
			`Discovered ${commandList.length} OpenCode slash commands on remote ${sshRemote.host}`,
			LOG_CONTEXT
		);
		return commandList;
	} catch (error) {
		if (error instanceof Error && error.message.includes('timed out')) {
			logger.warn(`Timed out discovering slash commands on ${sshRemote.host}`, LOG_CONTEXT);
			return [];
		}
		logger.warn(`Failed to discover slash commands on ${sshRemote.host}`, LOG_CONTEXT, { error });
		return [];
	}
}

export function registerAgentsHandlers(deps: AgentsHandlerDependencies): void {
	const { getAgentDetector, agentConfigsStore, settingsStore } = deps;
	const requireSettingsStore = () =>
		requireDependency(() => settingsStore ?? null, 'Settings store');

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
				const command = getWhichCommand();

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

				// Build SSH command to check for the binary using POSIX 'command -v'.
				// See detectAgentsRemote() for rationale.
				const remoteOptions: RemoteCommandOptions = {
					command: 'command',
					args: ['-v', agentDef.binaryName],
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

	ipcMain.handle(
		'agents:getDispatchSettings',
		withIpcErrorLogging(handlerOpts('getDispatchSettings', CONFIG_LOG_CONTEXT), async () => {
			const store = requireSettingsStore();
			return store.get(
				DISPATCH_SETTINGS_KEY,
				DEFAULT_AGENT_DISPATCH_SETTINGS
			) as AgentDispatchSettings;
		})
	);

	ipcMain.handle(
		'agents:setDispatchSettings',
		withIpcErrorLogging(
			handlerOpts('setDispatchSettings', CONFIG_LOG_CONTEXT),
			async (settings: AgentDispatchSettings) => {
				requireSettingsStore().set(DISPATCH_SETTINGS_KEY, settings);
				return true;
			}
		)
	);

	ipcMain.handle(
		'agents:getDispatchProfiles',
		withIpcErrorLogging(handlerOpts('getDispatchProfiles', CONFIG_LOG_CONTEXT), async () => {
			const sessions = ((requireSettingsStore().get('sessions', []) as Array<{
				id?: string;
				dispatchProfile?: AgentDispatchProfile;
			}>) ?? []) as Array<{ id?: string; dispatchProfile?: AgentDispatchProfile }>;
			const profiles: Record<string, AgentDispatchProfile> = {};
			for (const session of sessions) {
				if (!session.id) continue;
				profiles[session.id] = session.dispatchProfile ?? DEFAULT_AGENT_DISPATCH_PROFILE;
			}
			return profiles;
		})
	);

	ipcMain.handle(
		'agents:getDispatchProfile',
		withIpcErrorLogging(
			handlerOpts('getDispatchProfile', CONFIG_LOG_CONTEXT),
			async (agentId: string) => {
				const sessions = ((requireSettingsStore().get('sessions', []) as Array<{
					id?: string;
					dispatchProfile?: AgentDispatchProfile;
				}>) ?? []) as Array<{ id?: string; dispatchProfile?: AgentDispatchProfile }>;
				return (
					sessions.find((session) => session.id === agentId)?.dispatchProfile ??
					DEFAULT_AGENT_DISPATCH_PROFILE
				);
			}
		)
	);

	ipcMain.handle(
		'agents:setDispatchProfile',
		withIpcErrorLogging(
			handlerOpts('setDispatchProfile', CONFIG_LOG_CONTEXT),
			async (agentId: string, profile: AgentDispatchProfile) => {
				const store = requireSettingsStore();
				const sessions = ((store.get('sessions', []) as Array<Record<string, unknown>>) ??
					[]) as Array<Record<string, unknown>>;
				const updated = sessions.map((session) =>
					session.id === agentId ? { ...session, [DISPATCH_PROFILE_KEY]: profile } : session
				);
				store.set('sessions', updated);
				return true;
			}
		)
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
	// Supports SSH remote discovery via optional sshRemoteId parameter
	ipcMain.handle(
		'agents:getModels',
		withIpcErrorLogging(
			handlerOpts('getModels'),
			async (agentId: string, forceRefresh?: boolean, sshRemoteId?: string) => {
				logger.info(`Discovering models for agent: ${agentId}`, LOG_CONTEXT, {
					forceRefresh,
					sshRemoteId,
				});

				// If SSH remote ID provided, discover models on remote host
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					return discoverModelsRemote(agentId, sshConfig, forceRefresh ?? false);
				}

				// Local discovery
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
				const models = await agentDetector.discoverModels(agentId, forceRefresh ?? false);
				return models;
			}
		)
	);

	// Discover available values for a dynamic select config option
	ipcMain.handle(
		'agents:getConfigOptions',
		withIpcErrorLogging(
			handlerOpts('getConfigOptions'),
			async (agentId: string, optionKey: string, forceRefresh?: boolean) => {
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
				return agentDetector.discoverConfigOptions(agentId, optionKey, forceRefresh ?? false);
			}
		)
	);

	// Discover available slash commands for an agent by spawning it briefly
	// This allows the UI to show available commands before the user sends their first message
	ipcMain.handle(
		'agents:discoverSlashCommands',
		withIpcErrorLogging(
			handlerOpts('discoverSlashCommands'),
			async (agentId: string, cwd: string, customPath?: string, sshRemoteId?: string) => {
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
				logger.info(`Discovering slash commands for agent: ${agentId} in ${cwd}`, LOG_CONTEXT);

				// SSH remote: discover OpenCode commands from remote host
				if (agentId === 'opencode' && sshRemoteId) {
					const sshRemote = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshRemote) {
						logger.warn(
							`SSH remote ${sshRemoteId} not found for slash command discovery`,
							LOG_CONTEXT
						);
						return null;
					}
					return discoverOpenCodeSlashCommandsRemote(sshRemote, cwd);
				}

				const agent = await agentDetector.getAgent(agentId);
				if (!agent?.available) {
					logger.warn(`Agent ${agentId} not available for slash command discovery`, LOG_CONTEXT);
					return null;
				}

				// Agent-specific discovery paths
				if (agentId === 'opencode') {
					return discoverOpenCodeSlashCommands(cwd);
				}

				if (agentId === 'copilot-cli') {
					return discoverCopilotSlashCommands();
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
								// Description enrichment is best-effort: a permission/IO
								// error on the skills dir shouldn't lose the user's
								// entire slash-command list. Capture the exception for
								// Sentry and fall back to names-only.
								let skillDescriptions = new Map<string, string>();
								try {
									skillDescriptions = await readClaudeSkillDescriptions(cwd);
								} catch (err) {
									void captureException(err);
									logger.warn(
										`Skill description enrichment failed; returning slash commands without descriptions`,
										LOG_CONTEXT,
										{ error: String(err) }
									);
								}
								return (msg.slash_commands as string[]).map((name: string) => {
									const lookupKey = name.startsWith('/') ? name.slice(1) : name;
									const description = skillDescriptions.get(lookupKey);
									return description ? { name, description } : { name };
								});
							}
						} catch {
							// Not valid JSON, skip
						}
					}

					logger.warn(`No init message found in slash command discovery output`, LOG_CONTEXT);
					return null;
				} catch (error) {
					void captureException(error);
					logger.error(`Error discovering slash commands for ${agentId}`, LOG_CONTEXT, {
						error: String(error),
					});
					return null;
				}
			}
		)
	);
}
