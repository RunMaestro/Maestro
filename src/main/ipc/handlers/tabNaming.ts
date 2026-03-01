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
import { buildSshCommand } from '../../utils/ssh-command-builder';
import { tabNamingPrompt } from '../../../prompts';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { MaestroSettings } from './persistence';

const LOG_CONTEXT = '[TabNaming]';

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
					if (
						typeof (config as any).sessionCustomModel === 'string' &&
						(config as any).sessionCustomModel.trim()
					) {
						resolvedModelId = (config as any).sessionCustomModel.trim();
					} else if (
						agentConfigValues &&
						typeof agentConfigValues.model === 'string' &&
						agentConfigValues.model.trim() &&
						agentConfigValues.model.includes('/')
					) {
						resolvedModelId = agentConfigValues.model.trim();
					} else if (
						(agent as any).defaultModel &&
						typeof (agent as any).defaultModel === 'string'
					) {
						resolvedModelId = (agent as any).defaultModel as string;
					}

					// Sanitize resolved model id (remove trailing slashes)
					if (resolvedModelId) {
						resolvedModelId = resolvedModelId.replace(/\/+$/, '').trim();
						if (resolvedModelId === '') resolvedModelId = undefined;
					}

					// Debug: log resolved model for tab naming
					try {
						// eslint-disable-next-line no-console
						console.debug('[TabNaming] Resolved model', {
							sessionId,
							agentType: config.agentType,
							agentConfigModel: agentConfigValues.model,
							resolvedModelId,
						});
					} catch (err) {
						// swallow
					}

					let finalArgs = buildAgentArgs(agent, {
						baseArgs,
						prompt: fullPrompt,
						cwd: config.cwd,
						readOnlyMode: true, // Always read-only since we're not modifying anything
						modelId: resolvedModelId,
					});

					// Apply config overrides from store (other overrides such as customArgs/env)
					const configResolution = applyAgentConfigOverrides(agent, finalArgs, {
						agentConfigValues,
						sessionCustomModel: resolvedModelId,
					});
					finalArgs = configResolution.args;

					// Debug: log how model was resolved for tab naming requests so we can
					// verify whether session/agent overrides are applied as expected.
					try {
						// eslint-disable-next-line no-console
						console.debug('[TabNaming] Config resolution', {
							sessionId,
							agentType: config.agentType,
							modelSource: configResolution.modelSource,
							agentConfigModel: agentConfigValues?.model,
							finalArgsPreview: finalArgs.slice(0, 40),
						});
					} catch (err) {
						// swallow logging errors
					}

					// Sanitize model flags: avoid passing a --model value that is empty
					// or looks like a namespace with a trailing slash (e.g. "github-copilot/")
					// which some agent CLIs treat as invalid and error out.
					try {
						const sanitizedArgs: string[] = [];
						for (let i = 0; i < finalArgs.length; i++) {
							const a = finalArgs[i];
							if (a === '--model') {
								const next = finalArgs[i + 1];
								if (!next || typeof next !== 'string' || next.trim() === '' || /\/$/.test(next)) {
									// skip both the flag and the invalid value
									i++; // advance past the invalid value
									// eslint-disable-next-line no-console
									console.debug('[TabNaming] Removed invalid --model flag for tab naming', {
										sessionId,
										removedValue: next,
									});
									continue;
								}
							}
							sanitizedArgs.push(a);
						}
						finalArgs = sanitizedArgs;
					} catch (err) {
						// ignore sanitization failures
					}

					// Determine command and working directory
					let command = agent.path || agent.command;
					let cwd = config.cwd;
					// Start with resolved env vars from config resolution, allow mutation below
					let customEnvVars: Record<string, string> | undefined =
						configResolution.effectiveCustomEnvVars
							? { ...configResolution.effectiveCustomEnvVars }
							: undefined;

					// Handle SSH remote execution if configured
					// IMPORTANT: For SSH, we must send the prompt via stdin to avoid shell escaping issues.
					// The prompt contains special characters that break when passed through multiple layers
					// of shell escaping (local spawn -> SSH -> remote zsh -> bash -c).
					let shouldSendPromptViaStdin = false;
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

							// For agents that support stream-json input, use stdin for the prompt
							// This completely avoids shell escaping issues with multi-layer SSH commands
							const agentSupportsStreamJson = agent.capabilities?.supportsStreamJsonInput ?? false;
							if (agentSupportsStreamJson) {
								// Add --input-format stream-json to args so agent reads from stdin
								const hasStreamJsonInput =
									finalArgs.includes('--input-format') && finalArgs.includes('stream-json');
								if (!hasStreamJsonInput) {
									finalArgs = [...finalArgs, '--input-format', 'stream-json'];
								}
								shouldSendPromptViaStdin = true;
								logger.debug(
									'Using stdin for tab naming prompt in SSH remote execution',
									LOG_CONTEXT,
									{
										sessionId,
										promptLength: fullPrompt.length,
										agentSupportsStreamJson,
									}
								);
							}

							const sshCommand = await buildSshCommand(sshResult.config, {
								command: remoteCommand,
								args: finalArgs,
								cwd: remoteCwd,
								env: customEnvVars,
								useStdin: shouldSendPromptViaStdin,
							});
							command = sshCommand.command;
							finalArgs = sshCommand.args;
							// Local cwd is not used for SSH commands - the command runs on remote
							cwd = process.cwd();
						}
					}

					// Final safety sanitization: ensure args are all plain strings
					try {
						const nonStringItems = finalArgs.filter((a) => typeof a !== 'string');
						if (nonStringItems.length > 0) {
							// eslint-disable-next-line no-console
							console.debug('[TabNaming] Removing non-string args before spawn', {
								sessionId,
								removed: nonStringItems.map((i) => ({ typeof: typeof i, preview: String(i) })),
							});
							finalArgs = finalArgs.filter((a) => typeof a === 'string');
						}

						// Extract model arg value for debugging (if present)
						const modelIndex = finalArgs.indexOf('--model');
						if (modelIndex !== -1 && finalArgs.length > modelIndex + 1) {
							const modelVal = finalArgs[modelIndex + 1];
							// eslint-disable-next-line no-console
							console.debug('[TabNaming] Final --model value', {
								sessionId,
								value: modelVal,
								type: typeof modelVal,
							});
						}
					} catch (err) {
						// swallow safety log errors
					}

					// Quote model values that contain slashes so they survive shell-based
					// spawns (PowerShell can interpret unquoted tokens containing slashes).
					try {
						// Deduplicate --model flags and ensure exactly one is present before the prompt separator
						try {
							const sepIndex =
								finalArgs.indexOf('--') >= 0 ? finalArgs.indexOf('--') : finalArgs.length;
							let lastModelVal: string | undefined;
							for (let i = 0; i < sepIndex; i++) {
								if (finalArgs[i] === '--model' && finalArgs.length > i + 1) {
									const cand = finalArgs[i + 1];
									if (typeof cand === 'string' && cand.trim()) {
										lastModelVal = cand;
									}
								}
							}

							if (lastModelVal !== undefined) {
								const newArgs: string[] = [];
								for (let i = 0; i < sepIndex; i++) {
									if (finalArgs[i] === '--model') {
										i++; // skip value
										continue;
									}
									newArgs.push(finalArgs[i]);
								}
								// Insert the single canonical model flag
								newArgs.push('--model', lastModelVal);
								// Append remaining args (including '--' and prompt)
								finalArgs = [...newArgs, ...finalArgs.slice(sepIndex)];
								// eslint-disable-next-line no-console
								console.debug('[TabNaming] Deduplicated --model flags', {
									sessionId,
									canonical: lastModelVal,
								});
							}
						} catch (err) {
							// ignore dedupe failures
						}
						// Convert separate --model <value> pairs into a single --model=<value>
						// token so shells don't split values. Then enforce a single canonical
						// CLI model token derived from our resolvedModelId (if available).
						const rebuilt: string[] = [];
						for (let i = 0; i < finalArgs.length; i++) {
							const a = finalArgs[i];
							if (a === '--model' && i + 1 < finalArgs.length) {
								const raw = finalArgs[i + 1];
								const val =
									typeof raw === 'string' ? raw.replace(/^['\"]|['\"]$/g, '') : String(raw);
								rebuilt.push(`--model=${val}`);
								i++; // skip the value
							} else {
								rebuilt.push(a);
							}
						}
						finalArgs = rebuilt;

						// Remove any existing model tokens (either --model=... or -m/value)
						const withoutModel: string[] = [];
						for (let i = 0; i < finalArgs.length; i++) {
							const a = finalArgs[i];
							if (typeof a === 'string' && a.startsWith('--model')) {
								// skip
								continue;
							}
							if (a === '-m' && i + 1 < finalArgs.length) {
								i++; // skip short form value
								continue;
							}
							withoutModel.push(a);
						}

						// If we have a resolvedModelId (from session/agent/default), prefer inserting
						// it explicitly as a CLI flag to avoid relying on OpenCode config/env.
						if (resolvedModelId && typeof resolvedModelId === 'string') {
							// If resolvedModelId doesn't look like provider/model, prefer agent.defaultModel
							if (
								!resolvedModelId.includes('/') &&
								(agent as any).defaultModel &&
								typeof (agent as any).defaultModel === 'string' &&
								(agent as any).defaultModel.includes('/')
							) {
								resolvedModelId = (agent as any).defaultModel as string;
							}

							if (resolvedModelId && resolvedModelId.includes('/')) {
								const modelToken = `--model=${resolvedModelId}`;
								// Insert before the argument separator `--` if present
								const sep = withoutModel.indexOf('--');
								if (sep === -1) {
									withoutModel.push(modelToken);
								} else {
									withoutModel.splice(sep, 0, modelToken);
								}
								// eslint-disable-next-line no-console
								console.debug('[TabNaming] Injected canonical --model for spawn', {
									sessionId,
									model: resolvedModelId,
								});
							}
						}

						finalArgs = withoutModel;
					} catch (err) {
						// swallow
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
								// eslint-disable-next-line no-console
								console.debug('[TabNaming] Raw output before extraction', {
									sessionId,
									agentType: config.agentType,
									agentConfigModel: agentConfigValues?.model,
									resolvedModelId,
									finalArgsPreview: finalArgs.slice(0, 40),
									promptPreview: fullPrompt
										? `${String(fullPrompt).slice(0, 200)}${String(fullPrompt).length > 200 ? '...' : ''}`
										: undefined,
									rawOutputPreview: `${String(output).slice(0, 200)}${String(output).length > 200 ? '...' : ''}`,
									rawOutputLength: String(output).length,
								});
								// Detect obviously generic outputs to surface in logs
								const genericRegex =
									/^("|')?\s*(coding task|task tab name|task tab|coding task tab|task name)\b/i;
								if (genericRegex.test(String(output))) {
									// eslint-disable-next-line no-console
									console.warn(
										'[TabNaming] Agent returned a generic tab name candidate; consider adjusting prompt or model',
										{
											sessionId,
											detected: String(output).trim().slice(0, 80),
										}
									);
								}
							} catch (err) {
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
						// When using SSH with stdin, pass the flag so ChildProcessSpawner
						// sends the prompt via stdin instead of command line args
						try {
							// Debug: log full finalArgs array and types just before spawn
							// (kept in console.debug for diagnosis only)
							// eslint-disable-next-line no-console
							console.debug('[TabNaming] About to spawn with final args', {
								sessionId,
								command,
								cwd,
								sendPromptViaStdin: shouldSendPromptViaStdin,
								finalArgsDetail: finalArgs.map((a) => ({ value: a, type: typeof a })),
							});
						} catch (err) {
							// ignore logging failures
						}

						processManager.spawn({
							sessionId,
							toolType: config.agentType,
							cwd,
							command,
							args: finalArgs,
							prompt: fullPrompt,
							customEnvVars,
							sendPromptViaStdin: shouldSendPromptViaStdin,
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
		// Filter out empty lines and lines that look like instructions/examples
		// Allow quoted single-line outputs (agents often return the name in quotes)
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
