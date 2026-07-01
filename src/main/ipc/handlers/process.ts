import { ipcMain, BrowserWindow } from 'electron';
import Store from 'electron-store';
import type { AgentConfigsData } from '../../stores/types';
import * as os from 'os';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { ProcessManager } from '../../process-manager';
import { AgentDetector } from '../../agents';
import type { InteractiveReplayController } from '../../agents/claude-interactive-replay';
import { stripThinkingFromTranscript } from '../../agents/claude-transcript-sanitizer';
import type { ProcessConfig as ProcessSpawnConfig } from '../../process-manager/types';
import { logger } from '../../utils/logger';
import {
	resolveClaudeSpawnMode,
	buildRemoteInteractiveSpawn,
} from '../../agents/resolveClaudeSpawnMode';
import { getClaudeTokenMode } from '../../../shared/claudeTokenMode';
import { resolveConfigDirKey } from '../../stores/claudeUsageStore';
import { isWindows } from '../../../shared/platformDetection';
import { REGEX_AI_SUFFIX } from '../../constants';
import { getChildProcesses } from '../../process-manager/utils/childProcessInfo';
import { addBreadcrumb, captureException } from '../../utils/sentry';
import { isWebContentsAvailable } from '../../utils/safe-send';
import {
	buildAgentArgs,
	applyAgentConfigOverrides,
	getContextWindowValue,
} from '../../utils/agent-args';
import {
	withIpcErrorLogging,
	requireProcessManager,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { getSshRemoteConfig, createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { ensureRemoteMaestroPProbed } from '../../agents/probeRemoteMaestroP';
import { getPrompt } from '../../prompt-manager';
import { shellEscape } from '../../utils/shell-escape';
import { buildSshCommandWithStdin } from '../../utils/ssh-command-builder';
import { buildStreamJsonMessage } from '../../process-manager/utils/streamJsonBuilder';
import { getWindowsShellForAgentExecution } from '../../process-manager/utils/shellEscape';
import { buildExpandedEnv, encodeClaudeProjectPath } from '../../../shared/pathUtils';
import { resolveSshPath } from '../../utils/cliDetection';
import type { SshRemoteConfig } from '../../../shared/types';
import { powerManager } from '../../power-manager';
import { MaestroSettings } from './persistence';
import { getDefaultShell } from '../../stores/defaults';

const LOG_CONTEXT = '[ProcessManager]';

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
	...extra,
});

/**
 * Strip subscription-account thinking blocks from a Claude Code transcript before
 * an API-mode `--resume` re-sends them.
 *
 * Interactive (maestro-p) turns persist thinking as signature-only shells bound
 * to the Max-plan subscription account. Resuming them under the API token source
 * trips Anthropic's "thinking blocks cannot be modified" 400 and poisons the
 * conversation for every later `--resume`. Stripping is benign (thinking is
 * ephemeral reasoning) and the only thing that resumes cleanly across the mode
 * switch. Best-effort: a failure here just means the resume might still hit the
 * 400, so it must never abort the spawn.
 */
function sanitizeClaudeTranscriptBeforeApiResume(args: {
	configDirKey: string;
	cwd: string;
	agentSessionId: string;
	sessionId: string;
}): void {
	const { configDirKey, cwd, agentSessionId, sessionId } = args;
	try {
		const transcriptPath = path.join(
			configDirKey,
			'projects',
			encodeClaudeProjectPath(cwd),
			`${agentSessionId}.jsonl`
		);
		const result = stripThinkingFromTranscript(transcriptPath);
		if (result.sanitized) {
			logger.info('Sanitized transcript thinking blocks before API resume', LOG_CONTEXT, {
				sessionId,
				droppedRows: result.droppedRows,
				strippedBlocks: result.strippedBlocks,
			});
		}
	} catch (err) {
		logger.warn('Failed to sanitize transcript before API resume; continuing', LOG_CONTEXT, {
			sessionId,
			error: (err as Error).message,
		});
	}
}

// AgentConfigsData imported from stores/types

/**
 * Dependencies required for process handler registration
 */
/** Cue process info returned by the getCueProcesses callback */
export interface CueProcessEntry {
	runId: string;
	pid: number;
	command: string;
	args: string[];
	cwd: string;
	toolType: string;
	startTime: number;
	sessionName: string;
	subscriptionName: string;
	eventType: string;
	/** For SSH spawns: the agent invocation running on the remote host. */
	sshRemoteCommand?: string;
}

export interface ProcessHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
	getMainWindow: () => BrowserWindow | null;
	sessionsStore: Store<{ sessions: any[] }>;
	/** Optional callback to get active Cue run processes for Process Monitor */
	getCueProcesses?: () => CueProcessEntry[];
	/**
	 * Optional reactive limit replay controller. When `maestro-p` exits with
	 * code 2 (Max-plan quota hit mid-turn), the controller respawns the same
	 * turn under `claude --print` so the user sees one continuous response.
	 * Optional so test harnesses and CLI paths that don't run the replay flow
	 * can omit it cleanly.
	 */
	interactiveReplayController?: InteractiveReplayController<ProcessSpawnConfig>;
}

/**
 * Register all Process-related IPC handlers.
 *
 * These handlers manage process lifecycle operations:
 * - spawn: Start a new process for a session
 * - write: Send input to a process
 * - interrupt: Send SIGINT to a process
 * - kill: Terminate a process
 * - resize: Resize PTY dimensions
 * - getActiveProcesses: List all running processes
 * - runCommand: Execute a single command and capture output
 */
export function registerProcessHandlers(deps: ProcessHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore, getMainWindow } =
		deps;

	// Spawn a new process for a session
	// Supports agent-specific argument builders for batch mode, JSON output, resume, read-only mode, YOLO mode
	ipcMain.handle(
		'process:spawn',
		withIpcErrorLogging(
			handlerOpts('spawn'),
			async (config: {
				sessionId: string;
				toolType: string;
				cwd: string;
				command: string;
				args: string[];
				prompt?: string;
				shell?: string;
				images?: string[]; // Base64 data URLs for images
				// Stdin prompt delivery modes
				sendPromptViaStdin?: boolean; // If true, send prompt via stdin as JSON (for stream-json compatible agents)
				sendPromptViaStdinRaw?: boolean; // If true, send prompt via stdin as raw text (for OpenCode, Codex, etc.)
				// Agent-specific spawn options (used to build args via agent config)
				agentSessionId?: string; // For session resume
				readOnlyMode?: boolean; // For read-only/plan mode
				modelId?: string; // For model selection
				yoloMode?: boolean; // For YOLO/full-access mode (bypasses confirmations)
				permissionMode?: 'full' | 'standard' | 'readonly'; // 3-way permission mode (overrides readOnlyMode/yoloMode)
				// Per-session overrides (take precedence over agent-level config)
				sessionCustomPath?: string; // Session-specific custom path
				sessionCustomArgs?: string; // Session-specific custom args
				sessionCustomEnvVars?: Record<string, string>; // Session-specific env vars
				sessionCustomModel?: string; // Session-specific model selection
				sessionCustomEffort?: string; // Session-specific effort/reasoning level
				sessionCustomContextWindow?: number; // Session-specific context window size
				// Per-session SSH remote config (takes precedence over agent-level SSH config)
				sessionSshRemoteConfig?: {
					enabled: boolean;
					remoteId: string | null;
					workingDirOverride?: string;
				};
				// Batch Mode (Claude Code only). When true and a maestro-p binary resolves,
				// the spawner picks between maestro-p (Time Limits / Max plan) and
				// claude --print (API Limits) based on the latest usage snapshot.
				enableMaestroP?: boolean;
				// Refines the Adaptive opt-in: 'interactive' always drives the maestro-p
				// TUI, 'dynamic' (default) auto-switches to API when over the usage
				// limit. Authoritative value is read from the persisted session; this is
				// only a fallback for callers that pass it inline.
				maestroPMode?: 'interactive' | 'dynamic';
				// Optional override for the maestro-p binary path. When unset/empty, the
				// spawner falls back to the bundled maestro-p script.
				maestroPPath?: string;
				// System prompt delivery (separate from user message for token efficiency)
				appendSystemPrompt?: string; // System prompt to pass via --append-system-prompt or embed in prompt
				// Stats tracking options
				querySource?: 'user' | 'auto'; // Whether this query is user-initiated or from Auto Run
				tabId?: string; // Tab ID for multi-tab tracking
			}) => {
				const processManager = requireProcessManager(getProcessManager);
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				// Get agent definition to access config options and argument builders
				const agent = await agentDetector.getAgent(config.toolType);
				// Use INFO level on Windows for better visibility in logs

				const logFn = isWindows() ? logger.info.bind(logger) : logger.debug.bind(logger);
				logFn(`Spawn config received`, LOG_CONTEXT, {
					platform: process.platform,
					configToolType: config.toolType,
					configCommand: config.command,
					agentId: agent?.id,
					agentCommand: agent?.command,
					agentPath: agent?.path,
					agentPathExtension: agent?.path ? require('path').extname(agent.path) : 'none',
					hasAgentSessionId: !!config.agentSessionId,
					hasPrompt: !!config.prompt,
					promptLength: config.prompt?.length,
					// On Windows, show prompt preview to help debug truncation issues
					promptPreview:
						config.prompt && isWindows()
							? {
									first50: config.prompt.substring(0, 50),
									last50: config.prompt.substring(Math.max(0, config.prompt.length - 50)),
									containsHash: config.prompt.includes('#'),
									containsNewline: config.prompt.includes('\n'),
								}
							: undefined,
					// SSH remote config logging
					hasSessionSshRemoteConfig: !!config.sessionSshRemoteConfig,
					sessionSshRemoteConfig: config.sessionSshRemoteConfig
						? {
								enabled: config.sessionSshRemoteConfig.enabled,
								remoteId: config.sessionSshRemoteConfig.remoteId,
								hasWorkingDirOverride: !!config.sessionSshRemoteConfig.workingDirOverride,
							}
						: null,
				});
				// Claude Code's `maestro-p` interactive wrapper is opt-in per-session via
				// the Batch Mode toggle in AgentConfigPanel. When the toggle is on AND a
				// maestro-p binary resolves (per-session override OR bundled auto-detect),
				// the auto-resolver picks between maestro-p (interactive / Time Limits)
				// and `claude --print` (api / API Limits) based on the latest usage
				// snapshot. When the toggle is off, the spawner stays on the api path
				// regardless of usage state. SSH-enabled tabs always skip interactive —
				// the wrapper needs the real claude binary on the local machine.
				let claudeResolvedMode: 'interactive' | 'api' = 'api';
				let claudeResolvedReason: 'auto' | 'limit' = 'auto';
				let resolvedMaestroPBinPath: string | null = null;
				let resolvedConfigDirKey: string | undefined;
				// The real claude binary maestro-p should drive, as decided by the
				// resolver. Consumed by the interactive command swap below.
				let claudeDecisionRealBinPath: string | undefined;
				// Interactive resolved for an SSH remote spawn: maestro-p runs on the
				// remote host (not a local script). Realized in the SSH block below.
				let claudeResolvedRemote = false;
				const isClaudeCode =
					agent?.id === 'claude-code' &&
					!!agent?.interactiveCommand &&
					!!agent?.interactiveModeArgs;
				const isSshEnabled = !!config.sessionSshRemoteConfig?.enabled;
				// Desktop turns spawn with a COMPOUND session id (`{agentId}-ai-{tabId}`,
				// built in agentStore.processQueuedItem), but persisted session records are
				// keyed by the bare agent id. Strip the `-ai-…` suffix so both the token-mode
				// lookup and the `claudeInteractive` write-back below match the right record.
				// Without this every desktop claude-code turn missed the persisted record,
				// fell through to the inline `config.enableMaestroP` (which the desktop caller
				// never sends), and silently resolved to `api` (`claude --print`) even when the
				// agent was set to TUI/Dynamic. Background surfaces (tab naming, synopsis, group
				// chat, Cue) pass their token-mode fields inline, so they were unaffected. The
				// renderer mirror (`process:claude-mode-resolved`) already strips this suffix on
				// its side, so it still receives `config.sessionId` unchanged.
				const baseSessionId = config.sessionId.replace(REGEX_AI_SUFFIX, '');
				// Resolve the Claude token source (maestro-p TUI vs `claude --print`)
				// through the shared resolver. Token-mode fields are read from the
				// persisted session record (authoritative) with the spawn payload as
				// a fallback, so every desktop spawn surface that reaches this handler
				// (main turn, Auto Run, background synopsis) honors the per-agent
				// selection. The resolver folds in the former three branches:
				// dynamic/interactive selection, the direct-maestro-p-Path power-user
				// case, and stale `claudeInteractive` cleanup.
				if (isClaudeCode) {
					const persistedSession = (
						deps.sessionsStore.get('sessions', []) as Array<{
							id?: string;
							enableMaestroP?: boolean;
							maestroPMode?: 'interactive' | 'dynamic';
							maestroPPath?: string;
							claudeInteractive?: {
								mode?: 'interactive' | 'api';
								modeReason?: 'auto' | 'limit';
							};
						}>
					).find((s) => s?.id === baseSessionId);

					// Over SSH, warm the remote maestro-p probe BEFORE resolving so the
					// resolver's TUI->API backstop fires on the very first spawn - the
					// readiness probe / config modal that would otherwise warm the cache
					// may never have run (app just launched, agent sent to directly).
					// Without this an unconfigured/interactive SSH agent resolves to the
					// remote TUI on a cold cache and exits 127 when maestro-p is absent.
					let remoteMaestroPAvailable: boolean | undefined;
					if (isSshEnabled) {
						const sshRemote = getSshRemoteConfig(createSshRemoteStoreAdapter(settingsStore), {
							sessionSshConfig: config.sessionSshRemoteConfig,
						}).config;
						if (sshRemote) {
							remoteMaestroPAvailable = await ensureRemoteMaestroPProbed(sshRemote);
						}
					}

					const tokenMode = getClaudeTokenMode(
						{
							enableMaestroP: persistedSession?.enableMaestroP ?? config.enableMaestroP,
							// Fall back to the inline config when the persisted lookup misses
							// (e.g. background synopsis spawns under a synthetic sessionId that
							// won't match any persisted session, so they forward the token-mode
							// fields explicitly on the spawn payload).
							maestroPMode: persistedSession?.maestroPMode ?? config.maestroPMode,
						},
						// Remote agents default to the TUI when the user hasn't chosen,
						// unless the remote has no maestro-p to run it (then API).
						{ sshEnabled: isSshEnabled, sshMaestroPAvailable: remoteMaestroPAvailable }
					);

					const decision = resolveClaudeSpawnMode({
						agent,
						tokenMode,
						sshEnabled: isSshEnabled,
						// Lets the resolver fall a remote TUI spawn back to API when the
						// remote has no maestro-p on its PATH (avoids exit 127).
						sshRemoteId: config.sessionSshRemoteConfig?.remoteId ?? undefined,
						command: config.command,
						sessionCustomPath: config.sessionCustomPath,
						sessionCustomEnvVars: config.sessionCustomEnvVars,
						maestroPPath: persistedSession?.maestroPPath ?? config.maestroPPath,
						persisted: persistedSession?.claudeInteractive,
						now: new Date(),
					});

					claudeResolvedMode = decision.mode;
					claudeResolvedReason = decision.reason;
					resolvedMaestroPBinPath = decision.maestroPBinPath;
					resolvedConfigDirKey = decision.configDirKey;
					claudeDecisionRealBinPath = decision.claudeRealBinPath;
					claudeResolvedRemote = !!decision.remote;
				}

				// Pick the binary and arg list based on the resolved mode. Interactive
				// uses maestro-p (a Node script) invoked through `process.execPath`, so
				// the OS shebang is irrelevant and the script's basename never has to
				// be on `$PATH`. API mode stays on the original command/args.
				let effectiveCommand = config.command;
				let effectiveSessionCustomPath: string | undefined = config.sessionCustomPath;
				let baseArgsForSpawn = config.args;
				let claudeRealBinPath: string | undefined;
				if (
					claudeResolvedMode === 'interactive' &&
					resolvedMaestroPBinPath &&
					agent?.interactiveModeArgs
				) {
					// Preserve the original claude path so maestro-p can find the TUI binary.
					claudeRealBinPath =
						claudeDecisionRealBinPath ?? config.sessionCustomPath ?? config.command;
					effectiveCommand = process.execPath;
					effectiveSessionCustomPath = undefined;
					baseArgsForSpawn = [resolvedMaestroPBinPath, ...agent.interactiveModeArgs];
					logger.debug('Spawning Claude Code in interactive mode (maestro-p)', LOG_CONTEXT, {
						sessionId: config.sessionId,
						maestroPBin: resolvedMaestroPBinPath,
						claudeRealBin: claudeRealBinPath,
						configDirKey: resolvedConfigDirKey,
					});
				}

				// Resuming a Claude Code conversation under the API token source? Strip
				// any subscription-account thinking shells first. The sanitizer is
				// narrowly scoped to empty-thinking blocks (maestro-p's signature-only
				// shells); validly-signed API thinking blocks always carry non-empty
				// reasoning text and are preserved, so this is safe to run on any
				// transcript - including pure-API sessions that never touched
				// Adaptive Mode. If `resolvedConfigDirKey` wasn't already computed
				// (Batch Mode currently off, no maestro-p Path, no stale interactive
				// state), compute it now so we can locate the transcript on disk.
				if (
					claudeResolvedMode === 'api' &&
					config.agentSessionId &&
					isClaudeCode &&
					!isSshEnabled
				) {
					const configDirKey =
						resolvedConfigDirKey ??
						resolveConfigDirKey({
							...(process.env as NodeJS.ProcessEnv),
							...(agent?.defaultEnvVars ?? {}),
							...(config.sessionCustomEnvVars ?? {}),
						});
					sanitizeClaudeTranscriptBeforeApiResume({
						configDirKey,
						cwd: config.cwd,
						agentSessionId: config.agentSessionId,
						sessionId: config.sessionId,
					});
				}

				let finalArgs = buildAgentArgs(agent, {
					baseArgs: baseArgsForSpawn,
					prompt: config.prompt,
					cwd: config.cwd,
					readOnlyMode: config.readOnlyMode,
					modelId: config.modelId,
					yoloMode: config.yoloMode,
					permissionMode: config.permissionMode,
					agentSessionId: config.agentSessionId,
				});

				// ========================================================================
				// Apply agent config options and session overrides
				// Session-level overrides take precedence over agent-level config
				// ========================================================================
				const allConfigs = agentConfigsStore.get('configs', {});
				const agentConfigValues = allConfigs[config.toolType] || {};
				const configResolution = applyAgentConfigOverrides(agent, finalArgs, {
					agentConfigValues,
					sessionCustomModel: config.sessionCustomModel,
					sessionCustomEffort: config.sessionCustomEffort,
					sessionCustomArgs: config.sessionCustomArgs,
					sessionCustomEnvVars: config.sessionCustomEnvVars,
				});
				finalArgs = configResolution.args;

				if (configResolution.modelSource === 'session' && config.sessionCustomModel) {
					logger.debug(`Using session-level model for ${config.toolType}`, LOG_CONTEXT, {
						model: config.sessionCustomModel,
					});
				}

				if (configResolution.customArgsSource !== 'none') {
					logger.debug(
						`Appending custom args for ${config.toolType} (${configResolution.customArgsSource}-level)`,
						LOG_CONTEXT
					);
				}

				// In read-only mode, apply agent-specific env var overrides to strip
				// blanket permission grants (e.g., OpenCode's "*":"allow" YOLO config)
				let effectiveCustomEnvVars = configResolution.effectiveCustomEnvVars;
				if (config.readOnlyMode && agent?.readOnlyEnvOverrides) {
					effectiveCustomEnvVars = {
						...(effectiveCustomEnvVars || {}),
						...agent.readOnlyEnvOverrides,
					};
				}
				// In full-access mode, apply agent-specific env var overrides for full permissions
				const isFullAccess = config.permissionMode === 'full' || config.yoloMode === true;
				if (isFullAccess && (agent as any)?.fullAccessEnvOverrides) {
					effectiveCustomEnvVars = {
						...(effectiveCustomEnvVars || {}),
						...(agent as any).fullAccessEnvOverrides,
					};
				}
				if (configResolution.customEnvSource !== 'none' && effectiveCustomEnvVars) {
					logger.debug(
						`Custom env vars configured for ${config.toolType} (${configResolution.customEnvSource}-level)`,
						LOG_CONTEXT,
						{ keys: Object.keys(effectiveCustomEnvVars) }
					);
				}

				// ========================================================================
				// System prompt delivery: use --append-system-prompt for supported agents,
				// otherwise embed in the user prompt as fallback.
				// On Windows local execution, use --append-system-prompt-file with a temp
				// file to avoid exceeding the ~32K CreateProcess command-line length limit.
				// SSH sessions are exempt (the command runs inside a stdin script, not the
				// OS command line) and always use inline --append-system-prompt.
				//
				// Resume behavior: for agents WITHOUT native --append-system-prompt support,
				// the fallback path embeds the system prompt into the first user turn. That
				// turn is preserved in the agent's session transcript, so on resume we skip
				// re-embedding to avoid polluting every subsequent user message with the
				// full system prompt (which would be redundant context and waste tokens).
				// Agents with native support re-send per invocation — that flag is metadata,
				// not conversation content, and some agents (e.g. Claude Code) require it
				// every turn because it isn't persisted into the session transcript.
				// ========================================================================
				let effectivePrompt = config.prompt;
				let systemPromptTempFile: string | undefined;
				const isSshSession = config.sessionSshRemoteConfig?.enabled;
				const isResume = !!config.agentSessionId;
				if (config.appendSystemPrompt) {
					if (agent?.capabilities?.supportsAppendSystemPrompt) {
						if (isWindows() && !isSshSession) {
							// Windows local: write to temp file to avoid CLI length limits
							const tmpDir = os.tmpdir();
							systemPromptTempFile = path.join(
								tmpDir,
								`maestro-sysprompt-${config.sessionId}-${Date.now()}.txt`
							);
							await fsp.writeFile(systemPromptTempFile, config.appendSystemPrompt, 'utf-8');
							// Schedule cleanup early so the file is removed even if spawn fails.
							// 30s gives the agent plenty of time to read it after spawning.
							// Fire-and-forget unlink mirrors process-manager/utils/imageUtils.cleanupTempFiles:
							// silence ENOENT (file already gone), capture other codes via Sentry.
							const tempFileToClean = systemPromptTempFile;
							setTimeout(() => {
								fsp.unlink(tempFileToClean).catch((cleanupErr: unknown) => {
									if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
										captureException(
											cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)),
											{
												context: 'systemPromptTempFile cleanup (safety)',
												file: tempFileToClean,
											}
										);
									}
								});
							}, 30_000);
							finalArgs = [...finalArgs, '--append-system-prompt-file', systemPromptTempFile];
							logger.debug(
								'Using --append-system-prompt-file for system prompt delivery (Windows)',
								LOG_CONTEXT,
								{
									agentId: agent?.id,
									systemPromptLength: config.appendSystemPrompt.length,
									tempFile: systemPromptTempFile,
								}
							);
						} else {
							// Non-Windows or SSH: pass inline (no command-line length concern)
							finalArgs = [...finalArgs, '--append-system-prompt', config.appendSystemPrompt];
							logger.debug('Using --append-system-prompt for system prompt delivery', LOG_CONTEXT, {
								agentId: agent?.id,
								systemPromptLength: config.appendSystemPrompt.length,
							});
						}
					} else if (isResume) {
						// Resume path for agents without native --append-system-prompt:
						// the system prompt was embedded in the first user turn at initial
						// spawn and is preserved in the agent's session transcript. Skip
						// re-embedding to avoid polluting every subsequent user message.
						logger.debug(
							'Skipping system prompt re-injection on resume (already in transcript)',
							LOG_CONTEXT,
							{
								agentId: agent?.id,
								systemPromptLength: config.appendSystemPrompt.length,
							}
						);
					} else if (effectivePrompt) {
						// Fallback: embed system prompt in user message
						effectivePrompt = `${config.appendSystemPrompt}\n\n---\n\n# User Request\n\n${effectivePrompt}`;
						logger.debug('Embedding system prompt in user message (fallback)', LOG_CONTEXT, {
							agentId: agent?.id,
							systemPromptLength: config.appendSystemPrompt.length,
						});
					} else {
						// No user message to embed into - send system prompt as sole content
						effectivePrompt = config.appendSystemPrompt;
						logger.warn(
							'appendSystemPrompt provided without a user prompt; using as sole prompt',
							LOG_CONTEXT,
							{
								agentId: agent?.id,
								systemPromptLength: config.appendSystemPrompt.length,
							}
						);
					}
				}

				// Copilot-CLI batch-mode preamble.
				//
				// Copilot's `-p` mode auto-flips into autopilot, where the model ends
				// each run by calling the `task_complete` tool. The built-in autopilot
				// system prompt biases the model toward calling that tool *early*,
				// which manifests in Maestro as "the turn came back to me but the
				// task wasn't actually done". The remedy isn't a CLI flag — it's a
				// user-message preamble injected on every batch invocation that
				// pushes back on premature completion and instructs the model to
				// put its real conclusion in `task_complete.summary` (which is what
				// CopilotShutdownWaiter.readCopilotFinalAnswer surfaces to the user).
				//
				// Repeated every turn intentionally: each batch spawn is a fresh
				// Copilot process with its own system prompt reload, and the
				// preamble has to ride in the user prompt to be in-context for
				// that turn's reasoning. The text is user-editable via Maestro
				// Prompts (`copilot-preamble`); an empty customization disables it.
				if (agent?.id === 'copilot-cli' && effectivePrompt) {
					try {
						const preamble = getPrompt('copilot-preamble').trim();
						if (preamble) {
							effectivePrompt = `${preamble}\n\n${effectivePrompt}`;
							logger.debug('Prepended copilot-preamble to user prompt', LOG_CONTEXT, {
								preambleLength: preamble.length,
							});
						}
					} catch (err) {
						// Prompt not loaded yet (initializePrompts not called) — skip silently.
						// This path is hit by tests that stub the IPC handler without bootstrapping
						// prompts. Production code always runs initializePrompts() at app start.
						logger.debug('copilot-preamble unavailable; skipping injection', LOG_CONTEXT, {
							error: String(err),
						});
					}
				}

				// If no shell is specified and this is a terminal session, use the default shell from settings
				// For terminal sessions, we also load custom shell path, args, and env vars
				let shellToUse =
					config.shell ||
					(config.toolType === 'terminal'
						? settingsStore.get('defaultShell', getDefaultShell())
						: undefined);
				let shellArgsStr: string | undefined;

				// Load global shell environment variables for ALL process types (terminals and agents)
				//
				// IMPORTANT: These are the user-defined global env vars from Settings → General → Shell Configuration.
				// They apply to BOTH terminal sessions AND agent processes. This allows users to set API keys,
				// proxy settings, and other environment variables once and have them apply everywhere.
				//
				// Precedence order (highest to lowest):
				// 1. Session-level overrides (config.sessionCustomEnvVars)
				// 2. Global vars (shellEnvVars from Settings) - loaded here
				// 3. Process defaults (with Electron/IDE vars stripped for agents)
				//
				// The actual merging happens in buildChildProcessEnv() or buildPtyTerminalEnv().
				const globalShellEnvVars = settingsStore.get('shellEnvVars', {}) as Record<string, string>;

				// Debug logging when global env vars are configured
				if (Object.keys(globalShellEnvVars).length > 0) {
					logger.debug(
						`Applying ${Object.keys(globalShellEnvVars).length} global environment variables to ${config.toolType}`,
						LOG_CONTEXT,
						{
							sessionId: config.sessionId,
							toolType: config.toolType,
							globalEnvVarKeys: Object.keys(globalShellEnvVars).join(', '),
						}
					);
				}

				if (config.toolType === 'terminal') {
					// Custom shell path overrides the detected/selected shell path
					const customShellPath = settingsStore.get('customShellPath', '');
					if (customShellPath && customShellPath.trim()) {
						shellToUse = customShellPath.trim();
						logger.debug('Using custom shell path for terminal', LOG_CONTEXT, { customShellPath });
					}
					// Load additional shell args (env vars are loaded globally for both terminals and agents)
					shellArgsStr = settingsStore.get('shellArgs', '');
				}

				// Extract session ID from args for logging (supports both --resume and --session flags)
				const resumeArgIndex = finalArgs.indexOf('--resume');
				const sessionArgIndex = finalArgs.indexOf('--session');
				const agentSessionId =
					resumeArgIndex !== -1
						? finalArgs[resumeArgIndex + 1]
						: sessionArgIndex !== -1
							? finalArgs[sessionArgIndex + 1]
							: config.agentSessionId;

				// Redact system prompt content from logged args (can be large and sensitive)
				const appendPromptIdx = finalArgs.indexOf('--append-system-prompt');
				const argsToLog =
					appendPromptIdx !== -1
						? [
								...finalArgs.slice(0, appendPromptIdx + 1),
								`<${finalArgs[appendPromptIdx + 1]?.length ?? 0} chars>`,
								...finalArgs.slice(appendPromptIdx + 2),
							]
						: finalArgs;

				logger.info(`Spawning process: ${config.command}`, LOG_CONTEXT, {
					sessionId: config.sessionId,
					toolType: config.toolType,
					cwd: config.cwd,
					command: config.command,
					fullCommand: `${config.command} ${argsToLog.join(' ')}`,
					args: argsToLog,
					requiresPty: agent?.requiresPty || false,
					shell: shellToUse,
					...(agentSessionId && { agentSessionId }),
					...(config.readOnlyMode && { readOnlyMode: true }),
					...(config.yoloMode && { yoloMode: true }),
					...(config.permissionMode && { permissionMode: config.permissionMode }),
					...(config.modelId && { modelId: config.modelId }),
					...(config.prompt && {
						prompt:
							config.prompt.length > 500 ? config.prompt.substring(0, 500) + '...' : config.prompt,
					}),
					...(config.appendSystemPrompt && {
						systemPromptDelivery: agent?.capabilities?.supportsAppendSystemPrompt
							? systemPromptTempFile
								? 'file'
								: 'cli-arg'
							: 'embedded',
						...(systemPromptTempFile && { systemPromptFile: systemPromptTempFile }),
						effectivePromptLength: effectivePrompt?.length ?? 0,
					}),
				});

				// Add breadcrumb for crash diagnostics (MAESTRO-5A/4Y)
				await addBreadcrumb('agent', `Spawn: ${config.toolType}`, {
					sessionId: config.sessionId,
					toolType: config.toolType,
					command: config.command,
					hasPrompt: !!config.prompt,
				});

				// Get contextWindow: session-level override takes priority over agent-level config
				// Falls back to the agent's configOptions default (e.g., 400000 for Codex, 128000 for OpenCode)
				const contextWindow = getContextWindowValue(
					agent,
					agentConfigValues,
					config.sessionCustomContextWindow
				);

				// ========================================================================
				// Command Resolution: Apply session-level custom path override if set
				// This allows users to override the detected agent path per-session
				//
				// NEW: Always use shell execution for agent processes on Windows (except SSH),
				// so PATH and other environment variables are available. This ensures cross-platform
				// compatibility and correct agent behavior.
				// ========================================================================
				let commandToSpawn = effectiveSessionCustomPath || effectiveCommand;
				let argsToSpawn = finalArgs;
				let useShell = false;
				let sshRemoteUsed: SshRemoteConfig | null = null;
				let customEnvVarsToPass: Record<string, string> | undefined = effectiveCustomEnvVars;
				let sshStdinScript: string | undefined;
				let sshRemoteCommand: string | undefined;

				// When interactive mode resolved, thread the underlying claude binary
				// through `MAESTRO_CLAUDE_BIN` so maestro-p knows which TUI to drive.
				if (claudeRealBinPath) {
					customEnvVarsToPass = {
						...(customEnvVarsToPass ?? {}),
						MAESTRO_CLAUDE_BIN: claudeRealBinPath,
					};
				}

				// maestro-p is a Node script launched through `process.execPath` (the
				// Electron binary). Without ELECTRON_RUN_AS_NODE a PACKAGED app ignores
				// the script arg and launches a SECOND Maestro GUI instead of running
				// maestro-p, so the turn emits no stream-json and dies with no thinking
				// pill and no response - while `npm run dev` happens to load the script
				// as an app entry and works, masking it. envBuilder strips
				// ELECTRON_RUN_AS_NODE from the inherited env and applies customEnvVars
				// AFTER the strip, so setting it here survives. The batch/cue surfaces
				// set the same flag in applyClaudeSpawnDecision(); the desktop
				// process:spawn path applies the decision inline and must mirror it.
				if (claudeResolvedMode === 'interactive' && resolvedMaestroPBinPath) {
					customEnvVarsToPass = {
						...(customEnvVarsToPass ?? {}),
						ELECTRON_RUN_AS_NODE: '1',
					};
				}

				// LOCAL interactive turns run maestro-p as pure Node (via
				// `process.execPath` + ELECTRON_RUN_AS_NODE) and it does
				// `require('node-pty')`, which esbuild left external. In a PACKAGED
				// app maestro-p.js sits at the resources root, OUTSIDE the asar, so
				// Node can't find node-pty without help and every TUI turn dies on
				// startup with "Cannot find module 'node-pty'" - while API mode (no
				// maestro-p) and `npm run dev` (node-pty in the project tree) work.
				// Point NODE_PATH at the IN-ASAR node_modules (`<resources>/app.asar/
				// node_modules`), NOT the unpacked copy: node-pty's JS loads from the
				// asar (the native `pty.node` is auto-redirected to app.asar.unpacked),
				// and it derives its `spawn-helper` path via
				// `helperPath.replace('app.asar', 'app.asar.unpacked')` - handing it the
				// already-unpacked path double-applies to `app.asar.unpacked.unpacked`
				// and the helper exec fails. This mirrors the batch/cue path in
				// applyClaudeSpawnDecision(); without it the desktop interactive spawn
				// had no node-pty resolution at all. Dev has an empty resourcesPath, so
				// this only fires when packaged.
				if (
					claudeResolvedMode === 'interactive' &&
					resolvedMaestroPBinPath &&
					typeof process.resourcesPath === 'string' &&
					process.resourcesPath.length > 0
				) {
					const asarModules = path.join(process.resourcesPath, 'app.asar', 'node_modules');
					const existingNodePath = customEnvVarsToPass?.NODE_PATH ?? process.env.NODE_PATH;
					customEnvVarsToPass = {
						...(customEnvVarsToPass ?? {}),
						NODE_PATH: existingNodePath
							? `${asarModules}${path.delimiter}${existingNodePath}`
							: asarModules,
					};
				}

				// Persist the resolved Claude headless-mode state back to the session
				// record and notify the renderer. Fires when:
				//   - Adaptive Mode's auto-resolver ran (toggle on), OR
				//   - The user wired `Path` directly at maestro-p (resolved-interactive
				//     without the toggle), OR
				//   - We need to clear stale `mode === 'interactive'` from a prior
				//     turn (both `resolvedConfigDirKey` above branches resolve it,
				//     gate on `!== undefined`).
				// When none of those apply we leave `claudeInteractive` alone — the
				// popover hides itself anyway when `enableMaestroP` is false.
				if (isClaudeCode && resolvedConfigDirKey) {
					try {
						const allSessions = deps.sessionsStore.get('sessions', []) as Array<
							Record<string, unknown>
						>;
						let mutated = false;
						const nextSessions = allSessions.map((s) => {
							if (s?.id !== baseSessionId) return s;
							const current = s.claudeInteractive as
								| {
										mode?: string;
										modeReason?: string;
										lastUsageSnapshotKey?: string;
								  }
								| undefined;
							if (
								current?.mode === claudeResolvedMode &&
								current?.modeReason === claudeResolvedReason &&
								current?.lastUsageSnapshotKey === resolvedConfigDirKey
							) {
								return s;
							}
							mutated = true;
							return {
								...s,
								claudeInteractive: {
									mode: claudeResolvedMode,
									modeReason: claudeResolvedReason,
									lastUsageSnapshotKey: resolvedConfigDirKey,
								},
							};
						});
						if (mutated) {
							deps.sessionsStore.set('sessions', nextSessions);
						}
					} catch (err) {
						logger.warn('Failed to persist resolved Claude mode', LOG_CONTEXT, {
							sessionId: config.sessionId,
							error: err instanceof Error ? err.message : String(err),
						});
					}

					// Mirror to the renderer so the popover updates without a refetch.
					const mainWindow = getMainWindow();
					if (mainWindow && isWebContentsAvailable(mainWindow)) {
						mainWindow.webContents.send('process:claude-mode-resolved', config.sessionId, {
							mode: claudeResolvedMode,
							reason: claudeResolvedReason,
							configDirKey: resolvedConfigDirKey,
						});
					}
				}

				if (effectiveSessionCustomPath) {
					logger.debug(`Using session-level custom path for ${config.toolType}`, LOG_CONTEXT, {
						customPath: effectiveSessionCustomPath,
						originalCommand: effectiveCommand,
					});
				}

				// On Windows (except SSH), always use shell execution for agents
				// This avoids cmd.exe command line length limits (~8191 chars) which can cause
				// "Die Befehlszeile ist zu lang" errors with long prompts
				if (isWindows() && !config.sessionSshRemoteConfig?.enabled) {
					// Use expanded environment with custom env vars to ensure PATH includes all binary locations
					const expandedEnv = buildExpandedEnv(customEnvVarsToPass);
					// Filter out undefined values to match Record<string, string> type
					customEnvVarsToPass = Object.fromEntries(
						Object.entries(expandedEnv).filter(([_, value]) => value !== undefined)
					) as Record<string, string>;

					// Get the preferred shell for Windows (custom -> current -> PowerShell)
					// PowerShell is preferred over cmd.exe to avoid command line length limits
					const customShellPath = settingsStore.get('customShellPath', '') as string;
					const shellConfig = getWindowsShellForAgentExecution({
						customShellPath,
						currentShell: shellToUse,
					});
					shellToUse = shellConfig.shell;
					useShell = shellConfig.useShell;

					logger.info(`Forcing shell execution for agent on Windows for PATH access`, LOG_CONTEXT, {
						agentId: agent?.id,
						command: commandToSpawn,
						args: argsToSpawn,
						shell: shellToUse,
						shellSource: shellConfig.source,
					});
				}

				// ========================================================================
				// SSH Remote Execution: Detect and wrap command for remote execution
				// Terminal sessions are always local (they need PTY for shell interaction)
				// ========================================================================
				// Only consider SSH remote for non-terminal AI agent sessions
				// SSH is session-level ONLY - no agent-level or global defaults
				// Log SSH evaluation on Windows for debugging
				if (isWindows()) {
					logger.info(`Evaluating SSH remote config`, LOG_CONTEXT, {
						toolType: config.toolType,
						isTerminal: config.toolType === 'terminal',
						hasSessionSshRemoteConfig: !!config.sessionSshRemoteConfig,
						sshEnabled: config.sessionSshRemoteConfig?.enabled,
						willUseSsh: config.toolType !== 'terminal' && config.sessionSshRemoteConfig?.enabled,
					});
				}
				if (config.toolType !== 'terminal' && config.sessionSshRemoteConfig?.enabled) {
					// Session-level SSH config provided - resolve and use it
					logger.info(`Using session-level SSH config`, LOG_CONTEXT, {
						sessionId: config.sessionId,
						enabled: config.sessionSshRemoteConfig.enabled,
						remoteId: config.sessionSshRemoteConfig.remoteId,
					});

					// Resolve effective SSH remote configuration
					const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
					const sshResult = getSshRemoteConfig(sshStoreAdapter, {
						sessionSshConfig: config.sessionSshRemoteConfig,
					});

					if (sshResult.config) {
						// SSH remote is configured - use stdin-based execution
						// This completely bypasses shell escaping issues by sending the script via stdin
						sshRemoteUsed = sshResult.config;

						// Claude interactive/dynamic over SSH: run maestro-p on the remote
						// host (it strips the headless flags, drives the remote claude TUI
						// on the Max subscription, and reads the prompt from the stdin
						// passthrough below) instead of `claude --print`. maestro-p must be
						// installed on the remote PATH. For the API path this is null and
						// the spawn stays on the plain claude binary.
						const remoteInteractive =
							isClaudeCode && claudeResolvedMode === 'interactive' && claudeResolvedRemote
								? buildRemoteInteractiveSpawn({
										decision: {
											mode: 'interactive',
											reason: claudeResolvedReason,
											maestroPBinPath: null,
											remote: true,
											claudeRealBinPath: claudeDecisionRealBinPath,
										},
										interactiveModeArgs: agent?.interactiveModeArgs,
										remoteClaudeBin: claudeDecisionRealBinPath,
									})
								: null;

						// Determine the command to run on the remote host
						const remoteCommand =
							remoteInteractive?.command ||
							config.sessionCustomPath ||
							agent?.binaryName ||
							config.command;

						// Build the SSH command with stdin script
						// The script contains PATH setup, cd, env vars, and the actual command
						// This eliminates all shell escaping issues
						//
						// IMPORTANT: ALL agent prompts are passed via stdin passthrough for SSH.
						// Benefits:
						// - Avoids CLI argument length limits (128KB-2MB depending on OS)
						// - No shell escaping needed - prompt is never parsed by any shell
						// - Works with any prompt content (quotes, newlines, special chars)
						// - Simpler code - no heredoc or delimiter collision detection
						//
						// How it works: bash reads the script, `exec` replaces bash with the agent,
						// and the agent reads the remaining stdin (the prompt) directly.
						//
						// IMAGE SUPPORT: When images are present, the approach depends on the agent:
						// - Stream-json agents (Claude Code): Images are embedded as base64 in the
						//   stream-json message sent via stdin passthrough. --input-format stream-json
						//   is added to args so the agent parses the JSON+base64 message correctly.
						// - File-based agents (Codex, OpenCode): Images are decoded from base64 into
						//   temp files on the remote host via the SSH script, then passed as CLI args
						//   (e.g., -i /tmp/image.png for Codex, -f /tmp/image.png for OpenCode).
						const hasImages = config.images && config.images.length > 0;
						// Prepend the interactive flags ahead of the headless arg list when
						// running maestro-p on the remote (it forwards the interactive flags
						// to the TUI and strips the headless ones). No-op for the API path.
						let sshArgs = remoteInteractive
							? [...remoteInteractive.prependArgs, ...finalArgs]
							: finalArgs;
						let stdinInput: string | undefined = effectivePrompt;

						if (hasImages && effectivePrompt && agent?.capabilities?.supportsStreamJsonInput) {
							// Stream-json agent (Claude Code): embed images in the stdin message
							stdinInput = buildStreamJsonMessage(effectivePrompt, config.images!) + '\n';
							if (!sshArgs.includes('--input-format')) {
								sshArgs = [...sshArgs, '--input-format', 'stream-json'];
							}
							logger.info(`SSH: using stream-json stdin for images`, LOG_CONTEXT, {
								sessionId: config.sessionId,
								imageCount: config.images!.length,
							});
						}

						// Determine if this is a resume with prompt-embed images
						// agentSessionId presence indicates resume; imageResumeMode tells us to embed paths in prompt
						const isResumeWithImages =
							hasImages &&
							agent?.capabilities?.imageResumeMode === 'prompt-embed' &&
							config.agentSessionId;

						// Merge global environment variables with session custom env vars
						// Session vars take precedence over global vars. Remote interactive
						// adds MAESTRO_CLAUDE_BIN only when a custom remote claude path is
						// set (otherwise maestro-p defaults to `claude` on the remote PATH).
						const mergedSshEnvVars = {
							...globalShellEnvVars,
							...(effectiveCustomEnvVars || {}),
							...(remoteInteractive?.env || {}),
						};

						const sshCommand = await buildSshCommandWithStdin(sshResult.config, {
							command: remoteCommand,
							args: sshArgs,
							cwd: config.cwd,
							env: mergedSshEnvVars,
							// prompt is not passed as CLI arg - it goes via stdinInput
							stdinInput,
							// File-based image agents (Codex, OpenCode): pass images for remote temp file creation
							// Also needed for resume-with-prompt-embed (still creates temp files, just no -i args)
							images:
								hasImages &&
								(agent?.imageArgs || agent?.imagePromptBuilder) &&
								!agent?.capabilities?.supportsStreamJsonInput
									? config.images
									: undefined,
							imageArgs:
								hasImages && agent?.imageArgs && !agent?.capabilities?.supportsStreamJsonInput
									? agent.imageArgs
									: undefined,
							imagePromptBuilder:
								hasImages &&
								agent?.imagePromptBuilder &&
								!agent?.capabilities?.supportsStreamJsonInput
									? agent.imagePromptBuilder
									: undefined,
							// Signal resume mode for prompt embedding instead of -i CLI args
							imageResumeMode: isResumeWithImages ? 'prompt-embed' : undefined,
						});

						commandToSpawn = sshCommand.command;
						argsToSpawn = sshCommand.args;
						sshStdinScript = sshCommand.stdinScript;
						sshRemoteCommand = sshCommand.remoteCommandLine;

						// For SSH, env vars are passed in the stdin script, not locally
						customEnvVarsToPass = undefined;

						// CRITICAL: When using SSH, do NOT use shell execution
						// SSH needs direct stdin/stdout/stderr access for the script passthrough to work
						// Running SSH through a shell breaks stdin passthrough and the agent never gets the script
						useShell = false;
						shellToUse = undefined;

						logger.info(`SSH command built with stdin passthrough`, LOG_CONTEXT, {
							sessionId: config.sessionId,
							toolType: config.toolType,
							sshBinary: sshCommand.command,
							sshArgsCount: sshCommand.args.length,
							remoteCommand,
							remoteCwd: config.cwd,
							promptLength: config.prompt?.length,
							stdinScriptLength: sshCommand.stdinScript?.length,
							hasImages,
							imageCount: config.images?.length,
						});
					}
				}

				// Debug logging for shell configuration
				logger.info(`Shell configuration before spawn`, LOG_CONTEXT, {
					sessionId: config.sessionId,
					useShell,
					shellToUse,
					isWindows: isWindows(),
					isSshCommand: !!sshRemoteUsed,
					globalEnvVarsCount: Object.keys(globalShellEnvVars).length,
				});

				// For local (non-SSH) spawns, prepend the parent dir of the binary
				// we're actually about to spawn to PATH. Covers npm-style script
				// agents (codex, claude, etc.) installed alongside a non-standard
				// `node` that's outside our hardcoded version-manager paths —
				// the script's `#!/usr/bin/env node` shebang needs that node on
				// PATH. SSH path is built separately on the remote and must not
				// inherit any local directories.
				//
				// Prefer the session's effective custom path over the detected
				// agent path: if the user overrode the binary, the co-located
				// runtime belongs to *that* dir, not the auto-detected one.
				// Skip non-absolute paths so `path.dirname("codex")` doesn't
				// inject "." into PATH (which would let a binary in cwd shadow
				// system tools).
				const localSpawnBinaryPath = !sshRemoteUsed
					? effectiveSessionCustomPath || agent?.path
					: undefined;
				const localAgentBinDir =
					localSpawnBinaryPath && path.isAbsolute(localSpawnBinaryPath)
						? path.dirname(localSpawnBinaryPath)
						: undefined;

				const result = processManager.spawn({
					...config,
					command: commandToSpawn,
					args: argsToSpawn,
					// When using SSH, use user's home directory as local cwd
					// The remote working directory is embedded in the SSH stdin script
					// This fixes ENOENT errors when session.cwd is a remote-only path
					cwd: sshRemoteUsed ? os.homedir() : config.cwd,
					// When using SSH, disable PTY (SSH provides its own terminal handling)
					requiresPty: sshRemoteUsed ? false : agent?.requiresPty,
					// For SSH, prompt is included in the stdin script, not passed separately
					// For local execution, pass prompt (with system prompt embedded for non-append-system-prompt agents)
					prompt: sshRemoteUsed ? undefined : effectivePrompt,
					shell: shellToUse,
					runInShell: useShell,
					shellArgs: shellArgsStr, // Shell-specific CLI args (for terminal sessions)
					shellEnvVars: globalShellEnvVars, // Global shell env vars (for both terminals and agents)
					contextWindow, // Pass configured context window to process manager
					// When using SSH, env vars are passed in the stdin script, not locally
					customEnvVars: customEnvVarsToPass,
					imageArgs: agent?.imageArgs, // Function to build image CLI args (for Codex, OpenCode)
					imagePromptBuilder: agent?.imagePromptBuilder, // Function to embed image refs into prompts (for Copilot)
					promptArgs: agent?.promptArgs, // Function to build prompt args (e.g., ['-p', prompt] for OpenCode)
					noPromptSeparator: agent?.noPromptSeparator, // Some agents don't support '--' before prompt
					// Stats tracking: use cwd as projectPath if not explicitly provided
					projectPath: config.cwd,
					// SSH remote context (for SSH-specific error messages)
					sshRemoteId: sshRemoteUsed?.id,
					sshRemoteHost: sshRemoteUsed?.host,
					// SSH stdin script - the entire command is sent via stdin to /bin/bash on remote
					sshStdinScript,
					// Human-readable remote agent invocation (shown in Process Details)
					sshRemoteCommand,
					// Extra dirs to prepend to spawn PATH (local non-SSH only)
					extraPathDirs: localAgentBinDir ? [localAgentBinDir] : undefined,
				});

				logger.info(`Process spawned successfully`, LOG_CONTEXT, {
					sessionId: config.sessionId,
					pid: result.pid,
					...(sshRemoteUsed && {
						sshRemoteId: sshRemoteUsed.id,
						sshRemoteName: sshRemoteUsed.name,
					}),
				});

				// Arm the interactive-mode replay controller when this turn ran
				// through maestro-p. If the wrapper exits with code 2 (Max-plan
				// quota hit mid-turn), the controller re-spawns the same prompt
				// under `claude --print` so the user sees one continuous response
				// after a single visible mode switch.
				if (
					claudeResolvedMode === 'interactive' &&
					resolvedMaestroPBinPath &&
					resolvedConfigDirKey &&
					deps.interactiveReplayController &&
					agent
				) {
					const replayPrompt = config.prompt ?? '';
					const originalConfig = config;
					const originalAgent = agent;
					const originalEffectivePrompt = effectivePrompt;
					const originalCustomEnvVars = effectiveCustomEnvVars;
					const originalContextWindow = contextWindow;

					deps.interactiveReplayController.registerInteractiveReplay(config.sessionId, {
						configDirKey: resolvedConfigDirKey,
						prompt: replayPrompt,
						buildApiSpawnConfig: ({ prompt }): ProcessSpawnConfig | null => {
							// Pull the freshest agentSessionId for this session/tab off the
							// sessions store — maestro-p's session-id watcher may have stamped
							// one between spawn and exit.
							let freshAgentSessionId: string | undefined = originalConfig.agentSessionId;
							try {
								const sessions = deps.sessionsStore.get('sessions', []) as Array<{
									id?: string;
									aiTabs?: Array<{ id?: string; agentSessionId?: string | null }>;
								}>;
								// Same compound-id caveat as the token-mode lookup above: the
								// replay config carries the `{agentId}-ai-{tabId}` spawn id, but
								// sessions are keyed by the bare agent id. Strip the suffix or the
								// owner lookup misses and we never pick up the fresh agentSessionId.
								const ownerSessionId = originalConfig.sessionId.replace(REGEX_AI_SUFFIX, '');
								const ownerSession = sessions.find((s) => s?.id === ownerSessionId);
								const targetTab = ownerSession?.aiTabs?.find((t) => t?.id === originalConfig.tabId);
								if (targetTab?.agentSessionId) {
									freshAgentSessionId = targetTab.agentSessionId;
								}
							} catch {
								// Best-effort: stale agentSessionId is fine; resume will fall back to a new session.
							}

							// Sanitize the transcript we're about to `--resume` before the API
							// turn re-sends it (see helper for the full thinking-block 400
							// rationale). Best-effort: a failure must not abort the replay.
							if (freshAgentSessionId) {
								sanitizeClaudeTranscriptBeforeApiResume({
									configDirKey: resolvedConfigDirKey,
									cwd: originalConfig.cwd,
									agentSessionId: freshAgentSessionId,
									sessionId: originalConfig.sessionId,
								});
							}

							const apiArgs = buildAgentArgs(originalAgent, {
								baseArgs: originalAgent.apiModeArgs ?? originalConfig.args,
								prompt,
								cwd: originalConfig.cwd,
								readOnlyMode: originalConfig.readOnlyMode,
								modelId: originalConfig.modelId,
								yoloMode: originalConfig.yoloMode,
								permissionMode: originalConfig.permissionMode,
								agentSessionId: freshAgentSessionId,
							});

							const replayEnv = originalCustomEnvVars ? { ...originalCustomEnvVars } : undefined;
							if (replayEnv) {
								delete replayEnv.MAESTRO_CLAUDE_BIN;
							}

							const apiCommand = originalAgent.apiCommand ?? 'claude';
							const apiCommandToSpawn = originalConfig.sessionCustomPath || apiCommand;

							return {
								sessionId: originalConfig.sessionId,
								toolType: originalConfig.toolType,
								cwd: originalConfig.cwd,
								command: apiCommandToSpawn,
								args: apiArgs,
								prompt: originalEffectivePrompt,
								requiresPty: originalAgent.requiresPty,
								contextWindow: originalContextWindow,
								customEnvVars: replayEnv,
								imageArgs: originalAgent.imageArgs,
								imagePromptBuilder: originalAgent.imagePromptBuilder,
								promptArgs: originalAgent.promptArgs,
								noPromptSeparator: originalAgent.noPromptSeparator,
								projectPath: originalConfig.cwd,
								querySource: originalConfig.querySource,
								tabId: originalConfig.tabId,
							};
						},
					});
				}

				// Temp file cleanup is scheduled at creation time (30s safety net)
				// so it's cleaned up even if spawn fails above.

				// Add power block reason for AI sessions (not terminals)
				// This prevents system sleep while AI is processing
				if (config.toolType !== 'terminal') {
					powerManager.addBlockReason(`session:${config.sessionId}`);
				}

				// Emit SSH remote status event for renderer to update session state
				// This is emitted for all spawns (sshRemote will be null for local execution)
				const mainWindow = getMainWindow();
				if (isWebContentsAvailable(mainWindow)) {
					const sshRemoteInfo = sshRemoteUsed
						? {
								id: sshRemoteUsed.id,
								name: sshRemoteUsed.name,
								host: sshRemoteUsed.host,
							}
						: null;
					mainWindow.webContents.send('process:ssh-remote', config.sessionId, sshRemoteInfo);
				}

				// Return spawn result with SSH remote info if used
				return {
					...result,
					sshRemote: sshRemoteUsed
						? {
								id: sshRemoteUsed.id,
								name: sshRemoteUsed.name,
								host: sshRemoteUsed.host,
							}
						: undefined,
				};
			}
		)
	);

	// Write data to a process
	ipcMain.handle(
		'process:write',
		withIpcErrorLogging(handlerOpts('write'), async (sessionId: string, data: string) => {
			const processManager = requireProcessManager(getProcessManager);
			logger.debug(`Writing to process: ${sessionId}`, LOG_CONTEXT, {
				sessionId,
				dataLength: data.length,
			});
			return processManager.write(sessionId, data);
		})
	);

	// Send SIGINT to a process
	ipcMain.handle(
		'process:interrupt',
		withIpcErrorLogging(handlerOpts('interrupt'), async (sessionId: string) => {
			const processManager = requireProcessManager(getProcessManager);
			logger.info(`Interrupting process: ${sessionId}`, LOG_CONTEXT, { sessionId });
			return processManager.interrupt(sessionId);
		})
	);

	// Kill a process
	ipcMain.handle(
		'process:kill',
		withIpcErrorLogging(handlerOpts('kill'), async (sessionId: string) => {
			const processManager = requireProcessManager(getProcessManager);
			logger.info(`Killing process: ${sessionId}`, LOG_CONTEXT, { sessionId });
			// Detach any interactive replay listener. A user-initiated kill
			// shouldn't trigger an API-mode replay even if it happens to exit 2.
			deps.interactiveReplayController?.clearInteractiveReplay(sessionId);
			// Add breadcrumb for crash diagnostics (MAESTRO-5A/4Y)
			await addBreadcrumb('agent', `Kill: ${sessionId}`, { sessionId });
			return processManager.kill(sessionId);
		})
	);

	// Resize PTY dimensions
	ipcMain.handle(
		'process:resize',
		withIpcErrorLogging(
			handlerOpts('resize'),
			async (sessionId: string, cols: number, rows: number) => {
				const processManager = requireProcessManager(getProcessManager);
				return processManager.resize(sessionId, cols, rows);
			}
		)
	);

	// Get all active processes managed by the ProcessManager (and Cue runs if available)
	ipcMain.handle(
		'process:getActiveProcesses',
		withIpcErrorLogging(handlerOpts('getActiveProcesses'), async () => {
			const processManager = requireProcessManager(getProcessManager);
			const processes = processManager.getAll();
			// Return serializable process info (exclude non-serializable PTY/child process objects)
			// For terminal processes, also fetch child processes to show what's running inside the shell
			const result: Array<Record<string, unknown>> = await Promise.all(
				processes.map(async (p) => {
					const entry: Record<string, unknown> = {
						sessionId: p.sessionId,
						toolType: p.toolType,
						pid: p.pid,
						cwd: p.cwd,
						isTerminal: p.isTerminal,
						isBatchMode: p.isBatchMode || false,
						startTime: p.startTime,
						command: p.command,
						args: p.args,
						maestroEnvVars: p.maestroEnvVars,
						sshRemoteCommand: p.sshRemoteCommand,
					};
					if (p.isTerminal && p.pid) {
						const children = await getChildProcesses(p.pid);
						if (children.length > 0) {
							entry.childProcesses = children;
						}
					}
					return entry;
				})
			);

			// Append active Cue run processes if available
			const cueProcesses = deps.getCueProcesses?.() ?? [];
			for (const cue of cueProcesses) {
				result.push({
					sessionId: `cue-run-${cue.runId}`,
					toolType: cue.toolType,
					pid: cue.pid,
					cwd: cue.cwd,
					isTerminal: false,
					isBatchMode: false,
					startTime: cue.startTime,
					command: cue.command,
					args: cue.args,
					sshRemoteCommand: cue.sshRemoteCommand,
					isCueRun: true,
					cueRunId: cue.runId,
					cueSessionName: cue.sessionName,
					cueSubscriptionName: cue.subscriptionName,
					cueEventType: cue.eventType,
				});
			}

			return result;
		})
	);

	// Check whether a terminal tab's PTY currently has a non-shell foreground process.
	// Compares node-pty's `process` (foreground process name) to the basename of the
	// shell we spawned. Used by Cmd+W to warn before closing a busy terminal.
	ipcMain.handle(
		'process:isTerminalBusy',
		withIpcErrorLogging(handlerOpts('isTerminalBusy'), async (sessionId: string) => {
			const processManager = requireProcessManager(getProcessManager);
			const managed = processManager.get(sessionId);
			if (!managed?.ptyProcess || !managed.command) return false;
			const foreground = managed.ptyProcess.process;
			if (!foreground) return false;
			return path.basename(managed.command) !== foreground;
		})
	);

	// Spawn a terminal tab PTY process.
	// Uses session ID format {sessionId}-terminal-{tabId} so PtySpawner forwards raw output.
	// SSH remote support: if the session has SSH config enabled, the shell command is
	// wrapped with ssh to execute on the remote host.
	ipcMain.handle(
		'process:spawnTerminalTab',
		withIpcErrorLogging(
			handlerOpts('spawnTerminalTab'),
			async (config: {
				sessionId: string;
				cwd: string;
				shell?: string;
				shellArgs?: string;
				shellEnvVars?: Record<string, string>;
				cols?: number;
				rows?: number;
				// Agent type (e.g. 'claude-code') — used to resolve agent-level customEnvVars
				toolType?: string;
				// Session-level custom env vars (override agent-level)
				sessionCustomEnvVars?: Record<string, string>;
				// Per-session SSH remote config
				sessionSshRemoteConfig?: {
					enabled: boolean;
					remoteId: string | null;
					workingDirOverride?: string;
				};
			}) => {
				const processManager = requireProcessManager(getProcessManager);

				// Resolve shell: prefer config.shell, then settings default
				const globalShellEnvVars = settingsStore.get('shellEnvVars', {}) as Record<string, string>;
				let shellToUse = config.shell || settingsStore.get('defaultShell', getDefaultShell());
				const customShellPath = settingsStore.get('customShellPath', '');
				if (customShellPath && (customShellPath as string).trim()) {
					shellToUse = (customShellPath as string).trim();
				}

				// Resolve agent-level custom env vars from agent config store
				let agentCustomEnvVars: Record<string, string> = {};
				if (config.toolType) {
					const allConfigs = agentConfigsStore.get('configs', {});
					const agentConfig = allConfigs[config.toolType];
					if (agentConfig?.customEnvVars) {
						agentCustomEnvVars = agentConfig.customEnvVars;
					}
				}

				// Merge env vars: global → agent-level → session-level → per-invocation
				// Each layer takes precedence over the previous
				const mergedEnvVars = {
					...globalShellEnvVars,
					...agentCustomEnvVars,
					...(config.sessionCustomEnvVars || {}),
					...(config.shellEnvVars || {}),
				};

				logger.info(`Spawning terminal tab: ${config.sessionId}`, LOG_CONTEXT, {
					sessionId: config.sessionId,
					cwd: config.cwd,
					shell: shellToUse,
					cols: config.cols,
					rows: config.rows,
					hasSshConfig: !!config.sessionSshRemoteConfig?.enabled,
				});

				// SSH remote support for terminal tabs
				if (config.sessionSshRemoteConfig?.enabled) {
					const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
					const sshResult = getSshRemoteConfig(sshStoreAdapter, {
						sessionSshConfig: config.sessionSshRemoteConfig,
					});
					if (sshResult.config) {
						logger.info(`Terminal tab will connect via SSH`, LOG_CONTEXT, {
							sessionId: config.sessionId,
							remoteName: sshResult.config.name,
							remoteHost: sshResult.config.host,
							hasWorkingDirOverride: !!config.sessionSshRemoteConfig.workingDirOverride,
						});
						// For SSH terminal tabs we spawn ssh interactively so xterm.js can interact
						const sshArgs: string[] = [];

						// SSH options for reliable connection (consistent with SshRemoteManager)
						sshArgs.push('-o', 'StrictHostKeyChecking=accept-new');
						sshArgs.push('-o', 'ConnectTimeout=10');
						sshArgs.push('-o', 'ClearAllForwardings=yes');

						if (sshResult.config.privateKeyPath) {
							sshArgs.push('-i', sshResult.config.privateKeyPath);
						}
						if (sshResult.config.port && sshResult.config.port !== 22) {
							sshArgs.push('-p', String(sshResult.config.port));
						}

						// -t forces PTY allocation, required for interactive SSH terminals
						// regardless of whether a remote command is specified.
						sshArgs.push('-t');

						const workingDirOverride = config.sessionSshRemoteConfig.workingDirOverride;

						// Destination: user@host or just host
						sshArgs.push(
							sshResult.config.username
								? `${sshResult.config.username}@${sshResult.config.host}`
								: sshResult.config.host
						);

						// Build remote command parts
						const remoteParts: string[] = [];

						// Remote command (must come after destination)
						if (workingDirOverride) {
							// Handle leading ~ by using $HOME outside of quotes so the remote shell expands it
							const cdPath = workingDirOverride.startsWith('~/')
								? `"$HOME"/${shellEscape(workingDirOverride.slice(2))}`
								: workingDirOverride === '~'
									? '"$HOME"'
									: shellEscape(workingDirOverride);
							remoteParts.push(`cd ${cdPath}`);
						}

						// Export merged env vars on the remote side
						const envExports: string[] = [];
						for (const [key, value] of Object.entries(mergedEnvVars)) {
							if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
								envExports.push(`export ${key}=${shellEscape(value)}`);
							}
						}
						if (envExports.length > 0) {
							remoteParts.push(envExports.join(' && '));
						}

						remoteParts.push('exec "$SHELL"');
						sshArgs.push(remoteParts.join(' && '));

						return processManager.spawn({
							sessionId: config.sessionId,
							toolType: 'terminal',
							cwd: os.homedir(),
							command: await resolveSshPath(),
							args: sshArgs,
							shellEnvVars: mergedEnvVars,
							cols: config.cols || 80,
							rows: config.rows || 24,
						});
					}
					// SSH is enabled but the remote config was not found (deleted or disabled).
					// Fail explicitly rather than silently falling through to a local terminal,
					// which would give the user a local shell they didn't ask for.
					logger.error(`Terminal tab SSH config not found or disabled`, LOG_CONTEXT, {
						sessionId: config.sessionId,
						remoteId: config.sessionSshRemoteConfig.remoteId,
					});
					return { success: false, pid: 0 };
				}

				return processManager.spawnTerminalTab({
					sessionId: config.sessionId,
					cwd: config.cwd,
					shell: shellToUse,
					shellArgs: config.shellArgs || settingsStore.get('shellArgs', ''),
					shellEnvVars: mergedEnvVars,
					cols: config.cols || 80,
					rows: config.rows || 24,
				});
			}
		)
	);

	// Run a single command and capture only stdout/stderr (no PTY echo/prompts)
	// Supports SSH remote execution when sessionSshRemoteConfig is provided
	// TODO: Remove this handler once all callers migrate to process:spawnTerminalTab for persistent PTY sessions
	ipcMain.handle(
		'process:runCommand',
		withIpcErrorLogging(
			handlerOpts('runCommand'),
			async (config: {
				sessionId: string;
				command: string;
				cwd: string;
				shell?: string;
				// Per-session SSH remote config (same as process:spawn)
				sessionSshRemoteConfig?: {
					enabled: boolean;
					remoteId: string | null;
					workingDirOverride?: string;
				};
			}) => {
				logger.warn(
					'process:runCommand is deprecated — use process:spawnTerminalTab for persistent PTY sessions'
				);
				const processManager = requireProcessManager(getProcessManager);

				// Get the shell from settings if not provided
				// Custom shell path takes precedence over the selected shell ID
				let shell = config.shell || settingsStore.get('defaultShell', getDefaultShell());
				const customShellPath = settingsStore.get('customShellPath', '');
				if (customShellPath && customShellPath.trim()) {
					shell = customShellPath.trim();
				}

				// Get shell env vars for passing to runCommand
				const shellEnvVars = settingsStore.get('shellEnvVars', {}) as Record<string, string>;

				// ========================================================================
				// SSH Remote Execution: Resolve SSH config if provided
				// ========================================================================
				let sshRemoteConfig: SshRemoteConfig | null = null;

				if (config.sessionSshRemoteConfig?.enabled && config.sessionSshRemoteConfig?.remoteId) {
					const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
					const sshResult = getSshRemoteConfig(sshStoreAdapter, {
						sessionSshConfig: config.sessionSshRemoteConfig,
					});

					if (sshResult.config) {
						sshRemoteConfig = sshResult.config;
						logger.info(`Terminal command will execute via SSH`, LOG_CONTEXT, {
							sessionId: config.sessionId,
							remoteName: sshResult.config.name,
							remoteHost: sshResult.config.host,
							source: sshResult.source,
						});
					}
				}

				logger.debug(`Running command: ${config.command}`, LOG_CONTEXT, {
					sessionId: config.sessionId,
					cwd: config.cwd,
					shell,
					hasCustomEnvVars: Object.keys(shellEnvVars).length > 0,
					sshRemote: sshRemoteConfig?.name || null,
				});

				return processManager.runCommand(
					config.sessionId,
					config.command,
					config.cwd,
					shell,
					shellEnvVars,
					sshRemoteConfig
				);
			}
		)
	);
}
