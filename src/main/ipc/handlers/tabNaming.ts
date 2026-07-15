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
import type { AgentConfigsData } from '../../stores/types';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { buildAgentArgs, applyAgentConfigOverrides } from '../../utils/agent-args';
import { createOutputParser } from '../../parsers/parser-factory';
import {
	resolveClaudeSpawnMode,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	type ClaudeSpawnDecision,
} from '../../agents/resolveClaudeSpawnMode';
import { getClaudeTokenMode } from '../../../shared/claudeTokenMode';
import { getSshRemoteConfig, createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { ensureRemoteMaestroPProbed } from '../../agents/probeRemoteMaestroP';
import { buildSshCommand } from '../../utils/ssh-command-builder';
import { getPrompt } from '../../prompt-manager';
import { isWindows } from '../../../shared/platformDetection';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { MaestroSettings } from './persistence';
import { captureException } from '../../utils/sentry';

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

// AgentConfigsData imported from stores/types

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
 * Timeout for tab naming requests (120 seconds)
 * Tab naming inherits the agent's own model (we never pin a fast one), so a
 * heavyweight default like opus can take well over the old 45s budget on a cold
 * run. The early-extract loop still resolves the instant a name appears, so this
 * ceiling only bites the genuinely slow case - we'd rather wait and get a real
 * name than time out and leave the tab unnamed.
 */
const TAB_NAMING_TIMEOUT_MS = 120 * 1000;

/**
 * Interval for checking partial output for a valid tab name.
 * Allows resolving as soon as the agent outputs the name,
 * without waiting for the full process to exit.
 */
const EARLY_EXTRACT_INTERVAL_MS = 2 * 1000;

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
				// Session-level custom env vars from the triggering agent, forwarded so
				// the naming spawn inherits the SAME provider auth as the chat. The chat
				// spawn merges global shell env (Settings) -> agent-level -> session-level;
				// dropping this layer here was why naming could fail "Not logged in" while
				// the chat (which carries CLAUDE_CONFIG_DIR / ANTHROPIC_API_KEY) worked.
				sessionCustomEnvVars?: Record<string, string>;
				// Claude token-source selection for the triggering agent, forwarded
				// from the renderer's session (tab naming has no sessionId to look up
				// the persisted session by, so the caller passes these inline). When
				// absent, getClaudeTokenMode() collapses to 'api'.
				enableMaestroP?: boolean;
				maestroPMode?: 'interactive' | 'dynamic';
				maestroPPath?: string;
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
					const fullPrompt = `${getPrompt('tab-naming')}\n\n---\n\nUser's message:\n\n${config.userMessage}`;

					// Build agent arguments - read-only mode, runs in parallel
					// Filter out --dangerously-skip-permissions from base args since tab naming
					// runs in read-only/plan mode. Without skip-permissions, the agent doesn't
					// need to acquire a workspace lock and can run in parallel with other instances.
					const baseArgs = (agent.args ?? []).filter(
						(arg) => arg !== '--dangerously-skip-permissions'
					);
					let finalArgs = buildAgentArgs(agent, {
						baseArgs,
						prompt: fullPrompt,
						cwd: config.cwd,
						readOnlyMode: true, // Always read-only since we're not modifying anything
					});

					// Apply config overrides from store
					const allConfigs = agentConfigsStore.get('configs', {});
					const agentConfigValues = allConfigs[config.agentType] || {};
					const configResolution = applyAgentConfigOverrides(agent, finalArgs, {
						agentConfigValues,
					});
					finalArgs = configResolution.args;

					// Disable all tools for tab naming. A tab name is a pure text transform
					// of the user's first message - the agent must NOT investigate the
					// codebase. Without this, a task-like first message (e.g. "investigate
					// the ingestion lag and propose fixes") makes the model run a full
					// agentic session (Bash/Read/Grep) instead of emitting a name: it never
					// returns a result inside the timeout, so extraction fails with
					// empty_output. `noToolsArgs` (claude: `--tools ""`) forces a one-shot
					// text reply. Agents without the field are left untouched.
					if (agent.noToolsArgs?.length) {
						finalArgs = [...finalArgs, ...agent.noToolsArgs];
					}

					// Determine command and working directory
					let command = agent.path || agent.command;
					let cwd = config.cwd;
					// Match the chat spawn's env layering so naming uses the SAME provider
					// auth. The chat merges global shell env (Settings) -> agent-level ->
					// session-level (see process.ts). globalShellEnvVars is threaded
					// separately as `shellEnvVars` into processManager.spawn (the lowest
					// layer, applied by buildChildProcessEnv); customEnvVars carries the
					// agent-level overrides merged with the session-level overrides.
					const globalShellEnvVars = settingsStore.get('shellEnvVars', {}) as Record<
						string,
						string
					>;
					let customEnvVars: Record<string, string> | undefined = {
						...(configResolution.effectiveCustomEnvVars ?? {}),
						...(config.sessionCustomEnvVars ?? {}),
					};

					// Resolve the triggering agent's Claude token source ONCE, up front,
					// so BOTH the SSH-remote path (maestro-p on the remote host) and the
					// local path (maestro-p via process.execPath) realize the same
					// decision. Tab naming spawns claude directly (it does NOT route
					// through process:spawn where the resolver normally lives), so without
					// this it would always run `claude --print`.
					//
					// SSH now HONORS the selection instead of forcing API: API ->
					// `claude --print`, TUI -> remote maestro-p driving the remote claude
					// TUI on the Max plan. (`dynamic` over SSH has no remote quota signal,
					// so the resolver collapses it back to API.) For LOCAL spawns the
					// resolver already falls back to `claude --print` when no maestro-p
					// binary is found; the remote path trusts maestro-p on the remote PATH.
					//
					// NOTE: interactive tab-naming (local OR remote) drives the maestro-p
					// TUI and therefore spends Max-plan quota on a short, low-value turn.
					// That's the correct behavior when the user picked TUI/Dynamic.
					let claudeSpawnDecision: ClaudeSpawnDecision | null = null;
					if (agent.id === 'claude-code') {
						const sshEnabled = !!config.sessionSshRemoteConfig?.enabled;
						const sshRemoteId = config.sessionSshRemoteConfig?.remoteId ?? undefined;

						// Mirror the chat spawn (process.ts) EXACTLY so the naming turn spends
						// the same provider the chat would. Over SSH that means probing whether
						// the remote actually has maestro-p on its PATH: without this, the
						// unconfigured-SSH default and the TUI->API backstop resolve blind, so
						// the naming spawn could drive the remote TUI while the chat correctly
						// fell back to API (or vice-versa) - the token-source mismatch we must
						// never produce. Local (non-SSH) spawns skip the probe entirely.
						let sshMaestroPAvailable: boolean | undefined;
						if (sshEnabled && sshRemoteId) {
							const sshRemote = getSshRemoteConfig(createSshRemoteStoreAdapter(settingsStore), {
								sessionSshConfig: config.sessionSshRemoteConfig,
							}).config;
							if (sshRemote) {
								sshMaestroPAvailable = await ensureRemoteMaestroPProbed(sshRemote);
							}
						}

						const tokenMode = getClaudeTokenMode(
							{
								enableMaestroP: config.enableMaestroP,
								maestroPMode: config.maestroPMode,
							},
							// Match the agent's own spawn: an unconfigured SSH agent defaults to
							// the remote TUI, unless the probe shows the remote can't run it.
							{ sshEnabled, sshMaestroPAvailable }
						);
						claudeSpawnDecision = resolveClaudeSpawnMode({
							agent,
							tokenMode,
							sshEnabled,
							// Lets the resolver fall a remote TUI spawn back to API when the
							// remote has no maestro-p on its PATH (avoids exit 127) - same as chat.
							sshRemoteId,
							command,
							sessionCustomEnvVars: customEnvVars,
							maestroPPath: config.maestroPPath,
							now: new Date(),
						});
					}

					// Handle SSH remote execution if configured
					// IMPORTANT: For SSH, we must send the prompt via stdin to avoid shell escaping issues.
					// The prompt contains special characters that break when passed through multiple layers
					// of shell escaping (local spawn -> SSH -> remote zsh -> bash -c).
					let shouldSendPromptViaStdin = false;
					let promptAlreadyInArgs = false;
					if (config.sessionSshRemoteConfig?.enabled && config.sessionSshRemoteConfig.remoteId) {
						const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
						const sshResult = getSshRemoteConfig(sshStoreAdapter, {
							sessionSshConfig: config.sessionSshRemoteConfig,
						});

						if (sshResult.config) {
							// Use the agent's command (not path) for remote execution
							// since the path is local and remote host has its own binary location
							let remoteCommand = agent.command;
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
							} else {
								// Non-stream-json agents (copilot-cli, factory-droid, etc.) need the
								// prompt embedded inside the bash -c '<...>' wrapper. If we let
								// ChildProcessSpawner append `-p <prompt>` after buildSshCommand wraps
								// the agent invocation, those args land OUTSIDE the wrapper and get
								// swallowed as positional params to the remote bash, never reaching
								// the agent. Build the prompt into args here so it's quoted as part
								// of the wrapped command.
								if (agent.promptArgs) {
									finalArgs = [...finalArgs, ...agent.promptArgs(fullPrompt)];
								} else if (agent.noPromptSeparator) {
									finalArgs = [...finalArgs, fullPrompt];
								} else {
									finalArgs = [...finalArgs, '--', fullPrompt];
								}
								promptAlreadyInArgs = true;
								logger.debug('Embedded tab naming prompt inside SSH wrapper args', LOG_CONTEXT, {
									sessionId,
									promptLength: fullPrompt.length,
								});
							}

							// Claude TUI/dynamic over SSH runs maestro-p on the REMOTE host
							// (must be on its PATH) to drive the remote claude TUI on the Max
							// subscription. Returns null for the API path and non-claude
							// agents, leaving the spawn on the plain claude binary. The
							// interactive flags are prepended ahead of the existing arg list
							// (incl. `--input-format stream-json`): maestro-p strips the
							// headless-only flags, parses the stream-json prompt from stdin,
							// and drives the TUI. We do NOT pre-probe the remote FS for
							// maestro-p; if it's absent this throwaway naming turn just fails
							// and the tab keeps its default name.
							const remoteInteractive = claudeSpawnDecision
								? buildRemoteInteractiveSpawn({
										decision: claudeSpawnDecision,
										interactiveModeArgs: agent.interactiveModeArgs,
										remoteClaudeBin: claudeSpawnDecision.claudeRealBinPath,
									})
								: null;
							if (remoteInteractive) {
								remoteCommand = remoteInteractive.command;
								finalArgs = [...remoteInteractive.prependArgs, ...finalArgs];
								customEnvVars = { ...(customEnvVars ?? {}), ...remoteInteractive.env };
								logger.debug('Tab naming resolved to remote maestro-p TUI over SSH', LOG_CONTEXT, {
									sessionId,
								});
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

					// Realize a LOCAL interactive (maestro-p) decision by wrapping the
					// spawn with maestro-p via `process.execPath`. The SSH-remote case was
					// already handled above (remote maestro-p), and its decision carries a
					// null `maestroPBinPath`, so this guard naturally skips it. API and
					// non-claude spawns pass through unchanged on `claude --print`.
					if (claudeSpawnDecision?.mode === 'interactive' && claudeSpawnDecision.maestroPBinPath) {
						const applied = applyClaudeSpawnDecision({
							decision: claudeSpawnDecision,
							interactiveModeArgs: agent.interactiveModeArgs,
							command,
							args: finalArgs,
							customEnvVars,
						});
						command = applied.command;
						finalArgs = applied.args;
						customEnvVars = applied.customEnvVars;
						logger.debug('Tab naming resolved to interactive maestro-p TUI', LOG_CONTEXT, {
							sessionId,
							maestroPBin: claudeSpawnDecision.maestroPBinPath,
						});
					}

					// Create a promise that resolves when we get the tab name
					return new Promise<string | null>((resolve) => {
						let output = '';
						let resolved = false;

						const cleanup = () => {
							clearTimeout(timeoutId);
							clearInterval(earlyExtractIntervalId);
							processManager.off('data', onData);
							processManager.off('exit', onExit);
						};

						const resolveWith = (tabName: string | null, reason: string) => {
							if (resolved) return;
							resolved = true;
							cleanup();
							logger.info(`Tab naming ${reason}`, LOG_CONTEXT, {
								sessionId,
								outputLength: output.length,
								tabName,
							});
							// Kill the process if it's still running (fire-and-forget)
							try {
								processManager.kill(sessionId);
							} catch {
								// Process may have already exited
							}
							resolve(tabName);
						};

						// Set timeout
						const timeoutId = setTimeout(() => {
							logger.warn('Tab naming request timed out', LOG_CONTEXT, {
								sessionId,
								outputLength: output.length,
								outputSnippet: output.substring(0, 500) || '(no output received)',
							});
							resolveWith(null, 'timed out');
						}, TAB_NAMING_TIMEOUT_MS);

						// Periodically try to extract a tab name from partial output.
						// This lets us resolve as soon as the agent outputs the name,
						// without waiting for the full process to exit.
						const earlyExtractIntervalId = setInterval(() => {
							if (resolved || !output.trim()) return;
							const earlyResult = extractTabNameFromOutput(config.agentType, output);
							if (earlyResult.name) {
								resolveWith(earlyResult.name, 'resolved early from partial output');
							}
						}, EARLY_EXTRACT_INTERVAL_MS);

						// Listen for data from the process
						const onData = (dataSessionId: string, data: string) => {
							if (dataSessionId !== sessionId) return;
							output += data;
						};

						// Listen for process exit
						const onExit = (exitSessionId: string, code?: number) => {
							if (exitSessionId !== sessionId) return;

							if (resolved) {
								// Already resolved by early extraction, just clean up listeners
								processManager.off('data', onData);
								processManager.off('exit', onExit);
								return;
							}

							// A non-zero exit means the spawn itself failed (model unavailable,
							// auth expired, rate limit, network blip). Whatever the CLI printed
							// is an error banner, NOT a name - mining it produces garbage like
							// "com/news/fable-mythos-access" from an "X is unavailable. Learn
							// more: https://.../news/..." message. Bail to null instead of
							// extracting. The send-side trigger retries on the next message.
							if (code !== undefined && code !== 0) {
								logger.warn('Tab naming process exited with non-zero code', LOG_CONTEXT, {
									sessionId,
									exitCode: code,
									outputLength: output.length,
									outputSnippet: output.substring(0, 200),
								});
								resolveWith(null, `failed (exit code ${code})`);
								return;
							}

							const extraction = extractTabNameFromOutput(config.agentType, output);
							if (!extraction.name) {
								logger.warn('Tab naming extraction failed', LOG_CONTEXT, {
									sessionId,
									reason: extraction.reason,
									exitCode: code,
									outputLength: output.length,
									outputSnippet: output.substring(0, 500),
								});
							}
							resolveWith(extraction.name, `completed (exit code ${code})`);
						};

						processManager.on('data', onData);
						processManager.on('exit', onExit);

						// On Windows (non-SSH), route the prompt via raw stdin to avoid
						// cmd.exe's ~8KB command-line limit (ENAMETOOLONG on spawn).
						// Tab naming concatenates a multi-KB system prompt with the user
						// message, so a long first message easily exceeds the limit.
						const sendPromptViaStdinRaw = isWindows() && !config.sessionSshRemoteConfig?.enabled;

						// Spawn the process
						// When using SSH with stdin, pass the flag so ChildProcessSpawner
						// sends the prompt via stdin instead of command line args
						processManager.spawn({
							sessionId,
							toolType: config.agentType,
							cwd,
							command,
							args: finalArgs,
							prompt: fullPrompt,
							// Global shell env vars (Settings -> Shell Configuration) are the
							// lowest env layer the chat applies; without them a subscription
							// auth carried via CLAUDE_CONFIG_DIR / ANTHROPIC_API_KEY never
							// reaches the naming spawn and claude exits "Not logged in".
							shellEnvVars: globalShellEnvVars,
							customEnvVars,
							promptArgs: agent.promptArgs,
							noPromptSeparator: agent.noPromptSeparator,
							sendPromptViaStdin: shouldSendPromptViaStdin,
							sendPromptViaStdinRaw,
							promptAlreadyInArgs,
						});
					});
				} catch (error) {
					void captureException(error);
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
 * Structural noise that must never survive into a tab name.
 *
 * Two real-world leaks this guards against:
 *   1. Tool-call scaffolding. When the naming spawn drives the maestro-p TUI
 *      (Claude token mode = TUI/dynamic), the `--tools ""` guard is stripped
 *      along with the other headless-only flags, so the model runs a real
 *      agentic turn and its raw terminal transcript leaks function-call markup
 *      like `<invoke name="...">` / `</parameter>` / `</invoke>`. That output
 *      isn't stream-json, so extractAgentResponseText() can't lift a clean
 *      result and we fall back to scraping the raw TUI buffer.
 *   2. Empty-turn placeholders. The TUI renders `(no content)` / `(no output)`
 *      for a turn with no text block.
 *
 * Both are short and word-like, so they sail past the length/keyword filters
 * and end up as the tab name (observed: "</parameter> </invoke> (no content)").
 * Any angle bracket is disqualifying - a 2-4 word tab name never contains one -
 * which catches every tool-call tag variant, not just the ones seen so far.
 * Rejecting a noisy candidate returns null; the send-side trigger retries
 * naming on the next message, so the tab self-heals instead of sticking garbage.
 */
const STRUCTURAL_NOISE_RE = /[<>]|\((?:no\s+content|no\s+output|empty)\)/i;

/**
 * Result from extractTabName with diagnostic info for logging.
 */
interface TabNameExtractionResult {
	/** The extracted tab name, or null if extraction failed */
	name: string | null;
	/** Human-readable reason for the outcome (useful for debugging failures) */
	reason: string;
}

/**
 * Pull the agent's actual response text out of its raw process output before
 * extracting a tab name.
 *
 * Tab naming inherits the agent's default args, which for Claude (and other
 * stream-json agents) include `--output-format stream-json`. That means the
 * generated name arrives buried inside JSON envelopes
 * (`{"type":"result","result":"My Tab Name"}`), and every line is far longer
 * than extractTabName's 40-char line filter - so plain-text extraction always
 * discards it and returns null. We reuse the agent's own output parser to
 * normalize the stream and lift out the final `result` text (or, mid-stream,
 * the accumulated assistant text) before the plain-text cleanup runs.
 *
 * Returns null when the output isn't structured JSON at all (e.g. the
 * maestro-p TUI emits plain terminal text), so the caller falls back to
 * running extractTabName over the raw output exactly as before.
 */
function extractAgentResponseText(agentType: string, output: string): string | null {
	const parser = createOutputParser(agentType);
	if (!parser) return null;

	let sawJson = false;
	let resultText = '';
	let assistantText = '';
	for (const line of output.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Non-JSON line (e.g. maestro-p TUI text) - not stream-json output.
			continue;
		}
		if (!parsed || typeof parsed !== 'object') continue;
		sawJson = true;
		const event = parser.parseJsonObject(parsed);
		if (!event?.text) continue;
		if (event.type === 'result') {
			// The final result carries the complete response; last one wins.
			resultText = event.text;
		} else if (event.type === 'text' && !event.isReasoning) {
			// Streaming assistant chunks - accumulate so early extraction can
			// resolve before the terminating result event arrives. Reasoning
			// deltas (grok `thought`, codex/copilot reasoning) are excluded:
			// they stream BEFORE the answer, so mining them would let early
			// extraction resolve with a thinking fragment ("This is a simple
			// task") instead of the generated name.
			assistantText += event.text;
		}
	}

	if (!sawJson) return null;
	const text = (resultText || assistantText).trim();
	return text.length > 0 ? text : null;
}

/**
 * Extract a tab name from raw agent process output, normalizing structured
 * (stream-json) output via the agent's parser first and falling back to
 * plain-text extraction over the raw output.
 */
function extractTabNameFromOutput(agentType: string, output: string): TabNameExtractionResult {
	const responseText = extractAgentResponseText(agentType, output);
	return extractTabName(responseText ?? output);
}

/**
 * Extract a clean tab name from agent output.
 * The output may contain ANSI codes, extra whitespace, or markdown formatting.
 * Returns a structured result with diagnostic reason for logging.
 */
function extractTabName(output: string): TabNameExtractionResult {
	if (!output || !output.trim()) {
		return { name: null, reason: 'empty_output' };
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
		return (
			trimmed.length > 0 &&
			trimmed.length <= 40 && // Tab names should be short
			!trimmed.toLowerCase().includes('example') &&
			!trimmed.toLowerCase().includes('message:') &&
			!trimmed.toLowerCase().includes('rules:') &&
			!trimmed.startsWith('"') && // Skip example inputs in quotes
			!STRUCTURAL_NOISE_RE.test(trimmed) // Skip leaked tool-call markup / TUI placeholders
		);
	});

	if (lines.length === 0) {
		return {
			name: null,
			reason: `no_valid_lines_after_filtering (cleaned: ${cleaned.substring(0, 120)})`,
		};
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
		return { name: null, reason: `too_short (length: ${tabName.length}, value: "${tabName}")` };
	}

	// Final guard: reject anything that still carries tool-call markup or a TUI
	// empty-turn placeholder after cleanup (belt-and-suspenders for the line
	// filter above). Better to return null and retry naming next send than to
	// stick garbage like "</parameter> </invoke> (no content)" on the tab.
	if (STRUCTURAL_NOISE_RE.test(tabName)) {
		return { name: null, reason: `structural_noise (value: "${tabName}")` };
	}

	return { name: tabName, reason: 'ok' };
}
