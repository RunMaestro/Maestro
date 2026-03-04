/**
 * Tab Naming IPC Handlers
 *
 * This module provides IPC handlers for automatic tab naming,
 * spawning an ephemeral agent session to generate a descriptive tab name
 * based on the user's first message.
 *
 * Usage:
 * - window.maestro.tabNaming.generateTabName(userMessage, agentType, cwd, sshRemoteConfig?)
 */

import { ipcMain } from 'electron';
import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { buildAgentArgs, applyAgentConfigOverrides } from '../../utils/agent-args';
import { getSshRemoteConfig, createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { buildSshCommandWithStdin } from '../../utils/ssh-command-builder';
import { tabNamingPrompt } from '../../../prompts';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { MaestroSettings } from './persistence';

const LOG_CONTEXT = '[TabNaming]';

// Safe debug wrapper to centralize console.debug error isolation
const safeDebug = (message: string, data?: any) => {
	try {
		console.debug(message, data);
	} catch {
		// swallow
	}
};

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation' | 'logSuccess'> => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess: false,
	...extra,
});

/**
 * Interface for agent configuration store data
 */
interface AgentConfigsData {
	configs: Record<string, Record<string, any>>;
}

/**
 * Dependencies required for tab naming handler registration
 */
export interface TabNamingHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
}

/**
 * Timeout for tab naming requests (30 seconds)
 * This is a short timeout since we want quick response
 */
const TAB_NAMING_TIMEOUT_MS = 30 * 1000;

/**
 * Register Tab Naming IPC handlers.
 *
 * These handlers support automatic tab naming:
 * - generateTabName: Generate a tab name from user's first message
 */
export function registerTabNamingHandlers(deps: TabNamingHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore } = deps;

	logger.info('Registering tab naming IPC handlers', LOG_CONTEXT);

	// Generate a tab name from user's first message
	ipcMain.handle(
		'tabNaming:generateTabName',
		withIpcErrorLogging(
			handlerOpts('generateTabName'),
			async (config: {
				userMessage: string;
				agentType: string;
				cwd: string;
				sessionCustomModel?: string;
				sessionSshRemoteConfig?: {
					enabled: boolean;
					remoteId: string | null;
					workingDirOverride?: string;
				};
			}): Promise<string | null> => {
				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				// Generate a unique session ID for this ephemeral request
				const sessionId = `tab-naming-${uuidv4()}`;

				logger.info('Starting tab naming request', LOG_CONTEXT, {
					sessionId,
					agentType: config.agentType,
					messageLength: config.userMessage.length,
				});

				try {
					// Get the agent configuration
					const agent = await agentDetector.getAgent(config.agentType);
					if (!agent) {
						logger.warn('Agent not found for tab naming', LOG_CONTEXT, {
							agentType: config.agentType,
						});
						return null;
					}

					// Build the prompt: combine the tab naming prompt with the user's message
					const fullPrompt = `${tabNamingPrompt}\n\n---\n\nUser's message:\n\n${config.userMessage}`;

					// Build agent arguments - read-only mode, runs in parallel
					// Filter out --dangerously-skip-permissions from base args since tab naming
					// runs in read-only/plan mode. Without skip-permissions, the agent doesn't
					// need to acquire a workspace lock and can run in parallel with other instances.
					const baseArgs = (agent.args ?? []).filter(
						(arg) => arg !== '--dangerously-skip-permissions'
					);

					// Fetch stored agent config values (user overrides) early so we can
					// prefer the configured model when building args for the tab naming call.
					const allConfigs = agentConfigsStore.get('configs', {});
					const agentConfigValues = allConfigs[config.agentType] || {};

					// Resolve model id with stricter rules:
					// Preference: session override -> agent-config model (only if it looks complete) -> agent.defaultModel
					// Only accept agent-config model when it contains a provider/model (contains a '/')
					let resolvedModelId: string | undefined;
					if (typeof config.sessionCustomModel === 'string' && config.sessionCustomModel.trim()) {
						resolvedModelId = config.sessionCustomModel.trim();
					} else if (
						agentConfigValues &&
						typeof agentConfigValues.model === 'string' &&
						agentConfigValues.model.trim() &&
						agentConfigValues.model.includes('/')
					) {
						resolvedModelId = agentConfigValues.model.trim();
					} else if (agent.defaultModel && typeof agent.defaultModel === 'string') {
						resolvedModelId = agent.defaultModel;
					}

					// Sanitize resolved model id (remove trailing slashes)
					if (resolvedModelId) {
						resolvedModelId = resolvedModelId.replace(/\/+$/, '').trim();
						if (resolvedModelId === '') resolvedModelId = undefined;
					}

					// Debug: log resolved model for tab naming
					safeDebug('[TabNaming] Resolved model', {
						sessionId,
						agentType: config.agentType,
						agentConfigModel: agentConfigValues.model,
						resolvedModelId,
					});

					let finalArgs = buildAgentArgs(agent, {
						baseArgs,
						prompt: fullPrompt,
						cwd: config.cwd,
						readOnlyMode: true, // Always read-only since we're not modifying anything
						// modelId intentionally omitted — applyAgentConfigOverrides is the single source of model injection
					});

					// Apply config overrides from store (customArgs/env only).
					// Do NOT pass sessionCustomModel here so modelSource reflects the true origin
					// (agent-config or default). resolvedModelId is applied explicitly below.
					const configResolution = applyAgentConfigOverrides(agent, finalArgs, {
						agentConfigValues,
					});
					finalArgs = configResolution.args;

					// Debug: log how model was resolved for tab naming requests so we can
					// verify whether session/agent overrides are applied as expected.
					safeDebug('[TabNaming] Config resolution', {
						sessionId,
						agentType: config.agentType,
						modelSource: configResolution.modelSource,
						agentConfigModel: agentConfigValues?.model,
						resolvedModelId,
					});

					// Canonicalize model flags: strip all existing --model/-m tokens before the
					// prompt separator, then re-inject the single canonical model flag using the
					// agent-specific flag style (e.g. Codex uses -m, Claude Code uses --model=).
					// This must run BEFORE SSH wrapping so the flag ends up inside the remote
					// agent invocation, not in the SSH wrapper arguments.
					const sepIndex =
						finalArgs.indexOf('--') >= 0 ? finalArgs.indexOf('--') : finalArgs.length;
					const prefix = finalArgs.slice(0, sepIndex);
					const suffix = finalArgs.slice(sepIndex);

					const filteredPrefix: string[] = [];
					for (let i = 0; i < prefix.length; i++) {
						const a = prefix[i];
						if (typeof a === 'string') {
							if (a.startsWith('--model=')) {
								continue; // drop explicit --model=value
							}
							if (a === '--model') {
								// Only consume the next token as a value if it exists and looks like a value (not a flag)
								if (i + 1 < prefix.length && typeof prefix[i + 1] === 'string' && !String(prefix[i + 1]).startsWith('-')) {
									i++;
								}
								continue;
							}
							if (a === '-m') {
								// Only consume the next token as a value if it exists and looks like a value (not a flag)
								if (i + 1 < prefix.length && typeof prefix[i + 1] === 'string' && !String(prefix[i + 1]).startsWith('-')) {
									i++;
								}
								continue;
							}
						}
						filteredPrefix.push(a);
					}

					// Re-inject using resolvedModelId directly — it already reflects session >
					// agent-config > agent-default precedence. Use agent.modelArgs() when available
					// so each agent gets its own flag style.
					if (resolvedModelId) {
						const modelArgTokens = agent.modelArgs
							? agent.modelArgs(resolvedModelId)
							: [`--model=${resolvedModelId}`];
						filteredPrefix.push(...modelArgTokens);
						safeDebug('[TabNaming] Injected canonical model flag for spawn', {
							sessionId,
							modelLength: resolvedModelId.length,
							tokenCount: modelArgTokens.length,
						});
					}

					finalArgs = [...filteredPrefix, ...suffix];

					// Determine command and working directory
					let command = agent.path || agent.command;
					let cwd = config.cwd;
					// Start with resolved env vars from config resolution, allow mutation below
					const customEnvVars: Record<string, string> | undefined =
						configResolution.effectiveCustomEnvVars
							? { ...configResolution.effectiveCustomEnvVars }
							: undefined;

					// Handle SSH remote execution if configured
					// Use stdin-based execution to completely bypass shell escaping issues.
					// The prompt contains special characters that break when passed through multiple
					// layers of shell escaping (local spawn -> SSH -> remote bash -c).
					let sshStdinScript: string | undefined;
					if (config.sessionSshRemoteConfig?.enabled && config.sessionSshRemoteConfig.remoteId) {
						const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
						const sshResult = getSshRemoteConfig(sshStoreAdapter, {
							sessionSshConfig: config.sessionSshRemoteConfig,
						});

						if (sshResult.config) {
							// Use the agent's command (not path) for remote execution
							// since the path is local and remote host has its own binary location
							const remoteCommand = agent.command;
							const remoteCwd = config.sessionSshRemoteConfig.workingDirOverride || config.cwd;

							const sshCommand = await buildSshCommandWithStdin(sshResult.config, {
								command: remoteCommand,
								args: finalArgs,
								cwd: remoteCwd,
								env: customEnvVars,
								// Pass the prompt via stdin so it's never parsed by any shell layer
								stdinInput: fullPrompt,
							});
							command = sshCommand.command;
							finalArgs = sshCommand.args;
							sshStdinScript = sshCommand.stdinScript;
							// Local cwd is not used for SSH commands - the command runs on remote
							cwd = process.cwd();
						}
					}

					// Final safety sanitization: ensure args are all plain strings
					const nonStringItems = finalArgs.filter((a) => typeof a !== 'string');
					if (nonStringItems.length > 0) {
						finalArgs = finalArgs.filter((a) => typeof a === 'string');
						safeDebug('[TabNaming] Removing non-string args before spawn', {
							sessionId,
							removedCount: nonStringItems.length,
						});
					}

					// Create a promise that resolves when we get the tab name
					return new Promise<string | null>((resolve) => {
						let output = '';
						let resolved = false;

						// Set timeout
						const timeoutId = setTimeout(() => {
							if (!resolved) {
								resolved = true;
								logger.warn('Tab naming request timed out', LOG_CONTEXT, { sessionId });
								processManager.kill(sessionId);
								resolve(null);
							}
						}, TAB_NAMING_TIMEOUT_MS);

						// Listen for data from the process
						const onData = (dataSessionId: string, data: string) => {
							if (dataSessionId !== sessionId) return;
							output += data;
						};

						// Listen for process exit
						const onExit = (exitSessionId: string, code?: number) => {
							if (exitSessionId !== sessionId) return;

							// Clean up
							clearTimeout(timeoutId);
							processManager.off('data', onData);
							processManager.off('exit', onExit);

							if (resolved) return;
							resolved = true;

							// Extract the tab name from the output
							// The agent should return just the tab name, but we clean up any extra whitespace/formatting
							// Log raw output and context to help diagnose generic/low-quality tab names
							try {
								safeDebug('[TabNaming] Raw output before extraction', {
									sessionId,
									agentType: config.agentType,
									agentConfigModel: agentConfigValues?.model,
									resolvedModelId,
									finalArgsCount: finalArgs.length,
									promptLength: String(fullPrompt).length,
									outputLength: String(output).length,
								});
								// Detect obviously generic outputs to surface in logs
								const genericRegex =
									/^("|')?\s*(coding task|task tab name|task tab|coding task tab|task name)\b/i;
								if (genericRegex.test(String(output))) {
									logger.warn(
										'[TabNaming] Agent returned a generic tab name candidate; consider adjusting prompt or model',
										LOG_CONTEXT,
										{
											sessionId,
											outputLength: String(output).length,
										}
									);
								}
							} catch {
								// swallow logging errors
							}

							const tabName = extractTabName(output);
							logger.info('Tab naming completed', LOG_CONTEXT, {
								sessionId,
								exitCode: code,
								outputLength: output.length,
								tabName,
							});
							resolve(tabName);
						};

						processManager.on('data', onData);
						processManager.on('exit', onExit);

						// Spawn the process
						// For SSH, sshStdinScript contains the full bash script + prompt
						// Debug: log full finalArgs array and types just before spawn
						// (kept in console.debug for diagnosis only)
						safeDebug('[TabNaming] About to spawn with final args', {
							sessionId,
							agentType: config.agentType,
							hasSshStdinScript: !!sshStdinScript,
							finalArgsCount: finalArgs.length,
						});

						processManager.spawn({
							sessionId,
							toolType: config.agentType,
							cwd,
							command,
							args: finalArgs,
							prompt: fullPrompt,
							customEnvVars,
							sshStdinScript,
						});
					});
				} catch (error) {
					logger.error('Tab naming request failed', LOG_CONTEXT, {
						sessionId,
						error: String(error),
					});
					// Clean up the process if it was started
					try {
						processManager.kill(sessionId);
					} catch {
						// Ignore cleanup errors
					}
					return null;
				}
			}
		)
	);
}

/**
 * Extract a clean tab name from agent output.
 * The output may contain ANSI codes, extra whitespace, or markdown formatting.
 */
function extractTabName(output: string): string | null {
	if (!output || !output.trim()) {
		return null;
	}

	// Remove ANSI escape codes
	let cleaned = output.replace(/\x1B\[[0-9;]*[mGKH]/g, '');

	// Remove any markdown formatting (bold, italic, code blocks, headers)
	cleaned = cleaned.replace(/#{1,6}\s*/g, ''); // Remove markdown headers
	cleaned = cleaned.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');

	// Remove common preamble phrases the agent might add
	cleaned = cleaned.replace(/^(here'?s?|the tab name is|tab name:|name:|→|output:)\s*/gi, '');

	// Remove any newlines and extra whitespace
	cleaned = cleaned.replace(/[\n\r]+/g, ' ').trim();

	// Split by newlines, periods, or arrow symbols and take meaningful lines
	const lines = cleaned.split(/[.\n→]/).filter((line) => {
		const trimmed = line.trim();
		// Filter out empty lines and lines that look like instructions/examples.
		// Lines that are fully wrapped in quotes (e.g. "Fix CI flaky tests") are valid
		// tab name candidates — keep them so the unquoting step below can clean them.
		// Only discard lines that START with a quote but are not fully wrapped (example inputs).
		const isWrappedQuoted = /^["'].+["']$/.test(trimmed);
		if ((trimmed.startsWith('"') || trimmed.startsWith("'")) && !isWrappedQuoted) return false;
		const unquoted = trimmed.replace(/^['"]+|['"]+$/g, '');
		return (
			unquoted.length > 0 &&
			unquoted.length <= 40 && // Tab names should be short
			!unquoted.toLowerCase().includes('example') &&
			!unquoted.toLowerCase().includes('message:') &&
			!unquoted.toLowerCase().includes('rules:')
		);
	});

	if (lines.length === 0) {
		return null;
	}

	// Use the last meaningful line (often the actual tab name)
	let tabName = lines[lines.length - 1].trim();

	// Remove any leading/trailing quotes
	tabName = tabName.replace(/^["']|["']$/g, '');

	// Remove trailing punctuation (periods, colons, etc.)
	tabName = tabName.replace(/[.:;,!?]+$/, '');

	// Ensure reasonable length (max 40 chars for tab names)
	if (tabName.length > 40) {
		tabName = tabName.substring(0, 37) + '...';
	}

	// If the result is empty or too short, return null
	if (tabName.length < 2) {
		return null;
	}

	return tabName;
}
