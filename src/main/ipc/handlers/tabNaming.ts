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
import { cheapTurnSettings } from '../../../shared/modelTiers';
import type { AgentError, ToolType } from '../../../shared/types';
import {
	parseAgentErrorEffortRejection,
	parseEffortRejection,
	type EffortRejection,
} from '../../../shared/effortRejection';
import { getSshRemoteConfig, createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { ensureRemoteMaestroPProbed } from '../../agents/probeRemoteMaestroP';
import { buildSshCommand } from '../../utils/ssh-command-builder';
import { getPrompt } from '../../prompt-manager';
import { isWindows } from '../../../shared/platformDetection';
import { truncateAtWordBoundary } from '../../../shared/formatters';
import type { ProcessManager } from '../../process-manager';
import type { SafeSendFn } from '../../utils/safe-send';
import { runLocalTask, type LocalTaskResult } from '../../local-models/task-router';
import { resolveUtilityProvider } from '../../../shared/local-models/tasks';
import { clearLocalTaskNotice, reportLocalTaskUnavailable } from '../../local-models/task-notices';
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
	/**
	 * Broadcast channel for the Local Models `unavailable` notice. Absent for
	 * plugin title calls, which never use the Local Models assignment.
	 */
	safeSend?: SafeSendFn;
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
 * Spawn failures that mean "the configured agent binary is unusable on this
 * machine", not "Maestro has a bug": a missing/renamed CLI, a path pointing at
 * a non-executable (EFTYPE on Windows when the resolved target is a script or
 * a broken shim), or one the user can't execute. Tab naming is cosmetic and
 * degrades to leaving the tab unnamed, so these shouldn't page us. (MAESTRO-X4)
 */
const EXPECTED_SPAWN_ERROR_CODES = new Set(['ENOENT', 'EFTYPE', 'EACCES', 'EPERM', 'ENOEXEC']);

function isExpectedSpawnFailure(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' && EXPECTED_SPAWN_ERROR_CODES.has(code);
}

/**
 * Interval for checking partial output for a valid tab name.
 * Allows resolving as soon as the agent outputs the name,
 * without waiting for the full process to exit.
 */
const EARLY_EXTRACT_INTERVAL_MS = 2 * 1000;

/** Input for the shared tab and plugin title generator. */
export interface TabNamingConfig {
	userMessage: string;
	agentType: string;
	cwd: string;
	/**
	 * The agent the tab belongs to. Scopes the Local Models "unavailable"
	 * notice so it shows once per agent, not per tab.
	 */
	sessionId?: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	/** Active per-session auth overrides from the agent that owns this request. */
	sessionCustomEnvVars?: Record<string, string>;
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	/** Plugin calls pin the authorized agent; ordinary tab naming may use the utility agent. */
	useUtilityAgent?: boolean;
}

/** Shared isolated naming turn for UI tabs and brokered plugin titles.
 * Resolve an enabled SSH target once before awaiting provider detection and retain it
 * for probing and command construction. An unresolved target returns null; remote
 * settings changes must never send the remote message to a local provider.
 */
export async function generateTabName(
	deps: TabNamingHandlerDependencies,
	config: TabNamingConfig,
	signal?: AbortSignal,
	// Internal: set by this function's own retry (see the effort-rejection
	// branch in onExit) so the second attempt leaves the effort to the agent.
	skipCheapEffort = false
): Promise<string | null> {
	if (signal?.aborted) return null;
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore } = deps;

	// Local Models assignment first, for ordinary tab naming only. A plugin
	// title pins the authorized agent (`useUtilityAgent: false`), and a local
	// model is not that agent any more than the Utility Agent is. Only
	// `use-utility-agent` (the default) continues to the agent spawn below.
	if (config.useUtilityAgent !== false) {
		let assigned: AssignedNamingOutcome;
		try {
			assigned = await nameTabWithAssignedModel(
				config.userMessage,
				config.sessionId,
				deps.safeSend
			);
		} catch (error) {
			// The router throws only for an unclassified engine failure: a bug
			// worth reporting, but naming is cosmetic, so leave the tab.
			void captureException(error);
			logger.error('Tab naming on the assigned model failed', LOG_CONTEXT, {
				error: String(error),
			});
			return null;
		}
		if (assigned.handled) return assigned.name;
	}

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
		const sshRemote = config.sessionSshRemoteConfig?.enabled
			? getSshRemoteConfig(createSshRemoteStoreAdapter(settingsStore), {
					sessionSshConfig: config.sessionSshRemoteConfig,
				}).config
			: null;
		if (config.sessionSshRemoteConfig?.enabled && !sshRemote) {
			logger.warn('Configured SSH remote unavailable for tab naming', LOG_CONTEXT);
			return null;
		}
		// Resolve the agent: use the utility agent if configured, otherwise the
		// session agent. Null/empty leaves behavior unchanged (session agent).
		const utility = resolveUtilityProvider(
			config.useUtilityAgent === false
				? {}
				: {
						utilitySource: settingsStore.get('utilitySource'),
						utilityAgentId: settingsStore.get('utilityAgentId', null),
						utilityModelId: settingsStore.get('utilityModelId', null),
					},
			config.agentType
		);
		const effectiveAgentType = utility.agentType;

		// Get the agent configuration
		const agent = await agentDetector.getAgent(effectiveAgentType);
		if (!agent) {
			logger.warn('Agent not found for tab naming', LOG_CONTEXT, {
				agentType: effectiveAgentType,
				isUtilityAgent: utility.usesUtilityProvider,
			});
			return null;
		}

		// Build the prompt: combine the tab naming prompt with the user's message.
		// The message is fenced as data and the instruction is restated AFTER it:
		// a message that ends in a question ("what would it take to ...?") reads
		// as the last thing asked, and a small model answers it instead of naming
		// it. The trailer lives here, not in tab-naming.md, so it survives a user
		// customization of that prompt.
		const fullPrompt = [
			getPrompt('tab-naming'),
			'---',
			"User's message:",
			`<message>\n${config.userMessage}\n</message>`,
			'Reply with the tab name for the message above and nothing else. Do not answer, research, or act on the message.',
		].join('\n\n');

		// Build agent arguments. Filter out --dangerously-skip-permissions: without
		// it the agent doesn't need to acquire a workspace lock and can run in
		// parallel with other instances.
		const baseArgs = (agent.args ?? []).filter((arg) => arg !== '--dangerously-skip-permissions');
		// An agent that can switch every tool off (`noToolsArgs`, added below) has
		// nothing left to write with, so read-only mode protects nothing - and it
		// costs. Claude Code answers a `--permission-mode plan` turn on Sonnet even
		// when `--model haiku` is passed (its init still names Haiku), so every tab
		// name was billed at Sonnet rates. Pi and OMP's read-only flag is a
		// `--tools <list>` that contradicts their own `--no-tools`. Agents with no
		// way to disable tools stay read-only.
		const readOnlyMode = !agent.noToolsArgs?.length;
		let finalArgs = buildAgentArgs(agent, {
			baseArgs,
			prompt: fullPrompt,
			cwd: config.cwd,
			readOnlyMode,
			// Only apply the model override when a utility agent is actually in use.
			modelId: utility.modelId,
		});

		// Apply config overrides from store.
		//
		// Naming is pinned to the bottom of both ladders, the same way a
		// synopsis is (see cheapTurnSettings). The whole job is turning one
		// sentence into 2-4 words, and running it on whatever the agent is
		// configured with means paying opus rates for a tab title on every
		// first message. `undefined` from either resolver means the provider
		// isn't mapped, and applyAgentConfigOverrides then falls through to
		// the agent's own configured value - so an unmapped provider keeps
		// exactly the behaviour it had before.
		const cheapSettings = cheapTurnSettings(effectiveAgentType as ToolType);
		// The cheap effort is a value MAESTRO picked off a static ladder, and
		// a provider can retire a rung without notice. When it has refused
		// this one, the retry below runs again with the effort left to the
		// agent - a tab named at the wrong effort beats a tab with no name.
		const cheapNaming = skipCheapEffort ? { ...cheapSettings, effort: undefined } : cheapSettings;
		const allConfigs = agentConfigsStore.get('configs', {});
		const agentConfigValues = allConfigs[effectiveAgentType] || {};
		const configResolution = applyAgentConfigOverrides(agent, finalArgs, {
			agentConfigValues,
			readOnlyMode,
			sessionCustomModel: utility.modelId ?? cheapNaming.model,
			sessionCustomEffort: cheapNaming.effort,
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
		const globalShellEnvVars = settingsStore.get('shellEnvVars', {}) as Record<string, string>;
		// The session's env overrides belong to the SESSION's agent (its
		// API keys, its base URL). Layering them onto a different utility
		// agent points that agent at the wrong provider, so they are only
		// merged when the two are the same agent. `configResolution` is
		// already keyed by `effectiveAgentType` and always applies.
		let customEnvVars: Record<string, string> | undefined = {
			...(configResolution.effectiveCustomEnvVars ?? {}),
			...(effectiveAgentType === config.agentType ? (config.sessionCustomEnvVars ?? {}) : {}),
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
			const sshEnabled = !!sshRemote;
			const sshRemoteId = sshRemote?.id;

			// Mirror the chat spawn (process.ts) EXACTLY so the naming turn spends
			// the same provider the chat would. Over SSH that means probing whether
			// the remote actually has maestro-p on its PATH: without this, the
			// unconfigured-SSH default and the TUI->API backstop resolve blind, so
			// the naming spawn could drive the remote TUI while the chat correctly
			// fell back to API (or vice-versa) - the token-source mismatch we must
			// never produce. Local (non-SSH) spawns skip the probe entirely.
			let sshMaestroPAvailable: boolean | undefined;
			if (sshRemote) {
				sshMaestroPAvailable = await ensureRemoteMaestroPProbed(sshRemote);
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
		if (sshRemote) {
			// Use the agent's command (not path) for remote execution
			// since the path is local and remote host has its own binary location
			let remoteCommand = agent.command;
			const remoteCwd = config.sessionSshRemoteConfig?.workingDirOverride || config.cwd;

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
				logger.debug('Using stdin for tab naming prompt in SSH remote execution', LOG_CONTEXT, {
					sessionId,
					promptLength: fullPrompt.length,
					agentSupportsStreamJson,
				});
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

			const sshCommand = await buildSshCommand(sshRemote, {
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

		// No separate rule for a TUI (maestro-p) spawn: maestro-p answers in
		// stream-json like `claude --print`, and ProcessManager parses that
		// stream before it emits `data` - only the final `result` text arrives,
		// and non-JSON lines are dropped for any agent with an output parser.
		// Requiring raw JSON here (as #1110 once did) rejected every name a
		// TUI-mode agent generated, so its tabs were never auto-named.

		// Read once per request so early and final extraction cap alike.
		const shortenLongNames = settingsStore.get('shortenLongTabNames', false) === true;

		// Create a promise that resolves when we get the tab name
		if (signal?.aborted) return null;
		return new Promise<string | null>((resolve) => {
			let output = '';
			let rawOutput = '';
			let resolved = false;
			let effortRejection: EffortRejection | null = null;

			const cleanup = () => {
				clearTimeout(timeoutId);
				clearInterval(earlyExtractIntervalId);
				processManager.off('data', onData);
				processManager.off('raw-stdout', onRawStdout);
				processManager.off('exit', onExit);
				processManager.off('agent-error', onAgentError);
				signal?.removeEventListener('abort', onAbort);
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
				const earlyResult = extractTabNameFromOutput(effectiveAgentType, output, {
					rawOutput,
					shortenLongNames,
				});
				if (earlyResult.name) {
					resolveWith(earlyResult.name, 'resolved early from partial output');
				}
			}, EARLY_EXTRACT_INTERVAL_MS);

			// Listen for data from the process
			const onData = (dataSessionId: string, data: string) => {
				if (dataSessionId !== sessionId) return;
				output += data;
			};
			// The data event contains parsed text. Keep stdout so a final JSON
			// response can be distinguished from an unstructured terminal line.
			const onRawStdout = (dataSessionId: string, data: string) => {
				if (dataSessionId !== sessionId) return;
				rawOutput += data;
			};

			// A provider's refusal of the effort arrives as an agent error, not
			// as output: the turn never ran, so `output` stays empty and the
			// exit below would otherwise read as an anonymous failure.
			const onAgentError = (errorSessionId: string, agentError: AgentError) => {
				if (errorSessionId !== sessionId) return;
				effortRejection = parseAgentErrorEffortRejection(agentError) ?? effortRejection;
			};

			// Listen for process exit
			const onExit = (exitSessionId: string, code?: number) => {
				if (exitSessionId !== sessionId) return;

				if (resolved) {
					// Already resolved by early extraction, just clean up listeners
					processManager.off('data', onData);
					processManager.off('raw-stdout', onRawStdout);
					processManager.off('exit', onExit);
					processManager.off('agent-error', onAgentError);
					return;
				}

				// The provider refused the effort Maestro chose for this turn.
				// Run it once more at the agent's own effort instead of leaving
				// the tab unnamed. Only when THIS attempt sent the cheap effort,
				// so a refusal of the agent's own configured value cannot loop.
				const rejection = effortRejection ?? parseEffortRejection(output);
				if (rejection && cheapNaming.effort !== undefined) {
					resolved = true;
					cleanup();
					logger.warn(
						'Tab naming effort rejected by the provider; retrying at the agent default',
						LOG_CONTEXT,
						{ sessionId, effort: cheapNaming.effort, ...rejection }
					);
					resolve(generateTabName(deps, config, signal, true));
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

				const extraction = extractTabNameFromOutput(effectiveAgentType, output, {
					rawOutput,
					shortenLongNames,
				});
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
			const onAbort = () => resolveWith(null, 'cancelled');

			processManager.on('data', onData);
			processManager.on('raw-stdout', onRawStdout);
			processManager.on('exit', onExit);
			processManager.on('agent-error', onAgentError);
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}

			// On Windows (non-SSH), route the prompt via raw stdin to avoid
			// cmd.exe's ~8KB command-line limit (ENAMETOOLONG on spawn).
			// Tab naming concatenates a multi-KB system prompt with the user
			// message, so a long first message easily exceeds the limit.
			// Only for CLIs that actually read stdin - one that takes the
			// prompt positionally (omp) would run with no prompt and name
			// nothing.
			const sendPromptViaStdinRaw =
				isWindows() &&
				!config.sessionSshRemoteConfig?.enabled &&
				(agent.capabilities?.supportsPromptViaStdin ?? false);

			// Spawn the process
			// When using SSH with stdin, pass the flag so ChildProcessSpawner
			// sends the prompt via stdin instead of command line args
			//
			// child_process.spawn throws synchronously for a bad binary or an
			// over-long argv. This runs in the Promise executor, so an escaping
			// throw rejects the naming promise and surfaces as a hard IPC
			// failure - the outer try/catch can't see it, because the promise is
			// returned rather than awaited. Bail to null like every other
			// failure path here so a cosmetic feature can't break the send.
			try {
				processManager.spawn({
					sessionId,
					toolType: effectiveAgentType,
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
			} catch (error) {
				if (!isExpectedSpawnFailure(error)) {
					void captureException(error);
				}
				logger.warn('Tab naming spawn failed', LOG_CONTEXT, {
					sessionId,
					command,
					code: (error as NodeJS.ErrnoException).code,
					error: String(error),
				});
				resolveWith(null, 'spawn failed');
			}
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

export function registerTabNamingHandlers(deps: TabNamingHandlerDependencies): void {
	logger.info('Registering tab naming IPC handlers', LOG_CONTEXT);
	ipcMain.handle(
		'tabNaming:generateTabName',
		withIpcErrorLogging(handlerOpts('generateTabName'), (config: TabNamingConfig) =>
			generateTabName(deps, config)
		)
	);
}

/** Tokens a local naming turn may spend. `{"name": "..."}` is well under this. */
const LOCAL_TAB_NAME_MAX_TOKENS = 48;

/** The reply shape `tab-naming-local.md` asks for; the grammar keeps a small model on it. */
const LOCAL_TAB_NAME_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: { name: { type: 'string', maxLength: 40 } },
	required: ['name'],
	additionalProperties: false,
};

type AssignedNamingOutcome = { handled: false } | { handled: true; name: string | null };

/**
 * Name the tab with the `tab-naming` Local Models assignment, when it is a
 * local model or an endpoint.
 *
 * `use-utility-agent` is not handled here: the caller keeps its agent spawn,
 * which is the default, so nothing changes until the user assigns a model.
 * Every other verdict IS handled, and none of them falls back to an agent:
 *   - `off` skips naming. Naming is cosmetic, so a skipped turn just leaves the
 *     tab name as it is (the rename modal's "Auto" button included).
 *   - `unavailable` skips naming and tells the user once per agent why.
 *   - `cancelled` (the timeout below fired) skips naming; the next send retries.
 *
 * SSH: a local model runs on THIS machine even when the agent runs on a remote
 * host. That is fine here: the message text already crossed to this machine
 * (the renderer sent it), and naming reads nothing from the remote.
 */
async function nameTabWithAssignedModel(
	userMessage: string,
	sessionId: string | undefined,
	safeSend: SafeSendFn | undefined
): Promise<AssignedNamingOutcome> {
	const verdict = await runLocalTask('tab-naming', {
		system: getPrompt('tab-naming-local'),
		prompt: userMessage,
		maxTokens: LOCAL_TAB_NAME_MAX_TOKENS,
		jsonSchema: LOCAL_TAB_NAME_SCHEMA,
		signal: AbortSignal.timeout(TAB_NAMING_TIMEOUT_MS),
	});
	switch (verdict.status) {
		case 'use-utility-agent':
			return { handled: false };
		case 'off':
			return { handled: true, name: null };
		case 'cancelled':
			logger.warn('Tab naming on the assigned model timed out', LOG_CONTEXT, {
				source: verdict.source,
			});
			return { handled: true, name: null };
		case 'unavailable':
			reportLocalTaskUnavailable({ safeSend, taskId: 'tab-naming', verdict, sessionId });
			return { handled: true, name: null };
		case 'ok': {
			clearLocalTaskNotice('tab-naming', sessionId);
			// The same cleanup an agent's reply gets: the schema keeps the shape,
			// not the content, and a small model can still answer with noise.
			const extraction = extractTabName(localTabNameText(verdict));
			logger.info('Tab naming on the assigned model', LOG_CONTEXT, {
				source: verdict.source,
				durationMs: verdict.durationMs,
				tabName: extraction.name,
				reason: extraction.reason,
			});
			return { handled: true, name: extraction.name };
		}
	}
}

/** The `name` field when the reply parsed against the schema, else the raw text. */
function localTabNameText(verdict: Extract<LocalTaskResult, { status: 'ok' }>): string {
	const json = verdict.json;
	if (json && typeof json === 'object' && 'name' in json) {
		const name = (json as { name: unknown }).name;
		if (typeof name === 'string') return name;
	}
	return verdict.text;
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
 *      isn't stream-json, so extractAgentResponse() can't lift a clean
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
 * Word budget for a naming reply. A name is 2-4 words, and a chatty model
 * adds a one-line preamble ("Here is a suggested tab name."), so a real reply
 * stays well under this. A reply over it is the model ANSWERING the user's
 * message instead of naming it, and every short fragment in that answer is a
 * candidate the line filter would accept: a question about plugin stats was
 * once named "Respect opt-out", the title of bullet 5 in the answer. Reject
 * the whole reply; the send-side trigger retries naming on the next message.
 */
const MAX_NAMING_REPLY_WORDS = 30;

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
function extractAgentResponse(
	agentType: string,
	output: string
): { text: string; isFinal: boolean } | null {
	const parser = createOutputParser(agentType);
	if (!parser) return null;

	let sawJson = false;
	let isFinal = false;
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
		if (!event) continue;
		if (parser.isResultMessage(event)) {
			// Completion can be a textless marker after streamed answer chunks.
			isFinal = true;
			if (event.text) resultText = event.text;
		} else if (event.type === 'text' && !event.isReasoning && event.text) {
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
	return text.length > 0 ? { text, isFinal } : null;
}

/**
 * Extract a tab name from raw agent process output, normalizing structured
 * (stream-json) output via the agent's parser first and falling back to
 * plain-text extraction over the raw output.
 */
function extractTabNameFromOutput(
	agentType: string,
	output: string,
	{
		rawOutput = '',
		shortenLongNames = false,
	}: { rawOutput?: string; shortenLongNames?: boolean } = {}
): TabNameExtractionResult {
	const response = extractAgentResponse(agentType, rawOutput || output);
	return extractTabName(response?.text ?? output, {
		isFinal: response?.isFinal ?? false,
		shortenLongNames,
	});
}

/**
 * Longest line accepted as a name from output that is NOT a parser-confirmed
 * final response (raw terminal text, unfinished streams). Anything longer is
 * treated as prose, not a title.
 */
const TAB_NAME_RAW_MAX_LENGTH = 40;

/**
 * Length a final title is cut to when "Shorten long tab names" is on. The
 * same value as the raw ceiling, so a shortened name looks like any other.
 */
const TAB_NAME_SHORT_MAX_LENGTH = 40;

/**
 * Length a final title is cut to when the setting is off. The tab strip shows
 * the full name, so this is only a guard against a model answering with a
 * sentence instead of a title.
 */
const TAB_NAME_FULL_MAX_LENGTH = 80;

/**
 * Extract a clean tab name from agent output.
 * The output may contain ANSI codes, extra whitespace, or markdown formatting.
 * Returns a structured result with diagnostic reason for logging.
 */
function extractTabName(
	output: string,
	{
		isFinal = false,
		shortenLongNames = false,
	}: { isFinal?: boolean; shortenLongNames?: boolean } = {}
): TabNameExtractionResult {
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

	const wordCount = cleaned.split(/\s+/).length;
	if (wordCount > MAX_NAMING_REPLY_WORDS) {
		return {
			name: null,
			reason: `answered_instead_of_naming (${wordCount} words: ${cleaned.substring(0, 120)})`,
		};
	}

	// Split by newlines, periods, or arrow symbols and take meaningful lines
	const lines = cleaned.split(/[.\n→]/).filter((line) => {
		const trimmed = line.trim();
		// Filter out empty lines and lines that look like instructions/examples
		return (
			trimmed.length > 0 &&
			(isFinal || trimmed.length <= TAB_NAME_RAW_MAX_LENGTH) && // Only final responses may run long
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

	// A long final title is kept whole unless the user asked for short names.
	tabName = truncateAtWordBoundary(
		tabName,
		shortenLongNames ? TAB_NAME_SHORT_MAX_LENGTH : TAB_NAME_FULL_MAX_LENGTH,
		'...'
	);

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
