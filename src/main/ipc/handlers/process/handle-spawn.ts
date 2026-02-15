import { app, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as os from 'os';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { ProcessManager } from '../../../process-manager';
import { AgentDetector } from '../../../agents';
import { resolveMaestroCliScriptPath } from '../../../cue/cue-cli-executor';
import {
	getActivePluginManager,
	isPluginsFeatureEnabled,
} from '../../../plugins/plugin-manager-singleton';
import {
	buildMcpInjection,
	MCP_CONFIG_BY_AGENT,
} from '../../../../shared/plugins/mcp-agent-config';
import type { InteractiveReplayController } from '../../../agents/claude-interactive-replay';
import type { ProcessConfig as ProcessSpawnConfig } from '../../../process-manager/types';
import type { AgentConfigsData } from '../../../stores/types';
import { logger } from '../../../utils/logger';
import { isWindows } from '../../../../shared/platformDetection';
import { REGEX_AI_SUFFIX } from '../../../constants';
import { addBreadcrumb, captureException } from '../../../utils/sentry';
import { isWebContentsAvailable } from '../../../utils/safe-send';
import {
	buildAgentArgs,
	applyAgentConfigOverrides,
	getContextWindowValue,
} from '../../../utils/agent-args';
import { requireProcessManager, requireDependency } from '../../../utils/ipcHandler';
import { getPrompt } from '../../../prompt-manager';
import { getWindowsShellForAgentExecution } from '../../../process-manager/utils/shellEscape';
import { buildExpandedEnv } from '../../../../shared/pathUtils';
import type { SshRemoteConfig } from '../../../../shared/types';
import { powerManager } from '../../../power-manager';
import { MaestroSettings } from '../persistence';
import { getDefaultShell } from '../../../stores/defaults';
import { sanitizeClaudeTranscriptBeforeApiResume } from './claude-transcript-sanitize';
import { resolveClaudeSpawnContext } from './resolve-claude-spawn-context';
import { applyLocalInteractiveSpawnDecision } from './apply-local-interactive-spawn';
import { persistClaudeInteractiveMode } from './persist-claude-interactive-mode';
import { wrapSpawnForSsh } from './wrap-spawn-for-ssh';
import { preparePermissionRelayArgs } from '../../../permission-relay';
import type { SpawnProcessConfig } from './spawn-types';
import type { AccountRegistry } from '../../../accounts/account-registry';
import { injectAccountEnv } from '../../../accounts/account-env-injector';
import { getStatsDB } from '../../../stats';

const LOG_CONTEXT = '[ProcessManager]';

/** Dependencies injected into the `process:spawn` orchestration handler. */
export interface SpawnHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
	getMainWindow: () => BrowserWindow | null;
	safeSend?: (channel: string, ...args: unknown[]) => void;
	sessionsStore: Store<{ sessions: unknown[] }>;
	interactiveReplayController?: InteractiveReplayController<ProcessSpawnConfig>;
	getAccountRegistry?: () => AccountRegistry | null;
}

/**
 * Orchestrate a full agent/terminal spawn: resolve Claude mode, build args,
 * apply config overrides, wrap SSH, and delegate to ProcessManager.spawn().
 */
export async function handleProcessSpawn(
	config: SpawnProcessConfig,
	deps: SpawnHandlerDependencies
) {
	const {
		getProcessManager,
		getAgentDetector,
		agentConfigsStore,
		settingsStore,
		getMainWindow,
		safeSend,
	} = deps;

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
	const claudeContext = await resolveClaudeSpawnContext(config, agent, {
		sessionsStore: deps.sessionsStore,
		settingsStore,
	});
	const {
		baseSessionId,
		claudeResolvedMode,
		resolvedMaestroPBinPath,
		resolvedConfigDirKey,
		isClaudeCode,
		isSshEnabled,
	} = claudeContext;

	let finalArgs = buildAgentArgs(agent, {
		baseArgs: config.args,
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

	// Derive effective read-only state, honoring the legacy boolean flag only
	// when permissionMode wasn't explicitly set (back-compat for older configs).
	const hasExplicitPermissionMode = config.permissionMode !== undefined;
	const isReadOnly =
		config.permissionMode === 'readonly' ||
		(!hasExplicitPermissionMode && config.readOnlyMode === true);

	// In read-only mode, apply agent-specific env var overrides to strip blanket
	// permission grants.
	let effectiveCustomEnvVars = configResolution.effectiveCustomEnvVars;
	if (isReadOnly && agent?.readOnlyEnvOverrides) {
		effectiveCustomEnvVars = {
			...(effectiveCustomEnvVars || {}),
			...agent.readOnlyEnvOverrides,
		};
	}
	if (configResolution.customEnvSource !== 'none' && effectiveCustomEnvVars) {
		logger.debug(
			`Custom env vars configured for ${config.toolType} (${configResolution.customEnvSource}-level)`,
			LOG_CONTEXT,
			{ keys: Object.keys(effectiveCustomEnvVars) }
		);
	}

	// Pianola manager agent: expose the bundled maestro-cli to the agent's
	// Bash (via MAESTRO_CLI_JS) so it can orchestrate other agents - list,
	// create, dispatch, watch, and set rules - without any PATH assumptions,
	// and tell it its own id (MAESTRO_AGENT_ID) so it never acts on itself.
	// Injected into effectiveCustomEnvVars so it flows through both the local
	// and SSH env-merge paths below.
	const isPianolaSession = (
		deps.sessionsStore.get('sessions', []) as Array<{ id?: string; isPianola?: boolean }>
	).some((s) => s?.id === baseSessionId && s?.isPianola === true);
	if (isPianolaSession) {
		effectiveCustomEnvVars = {
			...(effectiveCustomEnvVars || {}),
			MAESTRO_CLI_JS: resolveMaestroCliScriptPath(),
			MAESTRO_AGENT_ID: baseSessionId,
		};
	}

	// MCP plugin-tool bridge: when the plugins feature is on, this agent
	// supports a verified ephemeral MCP config, and at least one plugin tool
	// is registered, point the agent at `maestro-cli mcp serve` so its model
	// can call plugin tools (each call risk-gated in the app). Local spawns
	// only - the bridge reaches the app over a localhost WebSocket + discovery
	// file an SSH-remote agent cannot see. Best-guess (unverified) agents are
	// intentionally skipped to avoid breaking their startup with a wrong shape.
	const mcpCap = MCP_CONFIG_BY_AGENT[config.toolType];
	if (
		mcpCap?.verified &&
		isPluginsFeatureEnabled() &&
		!config.sessionSshRemoteConfig?.enabled &&
		// Skip the electron-as-node interactive path (claude maestro-p): there
		// argv[0] is a script path, so prepending global flags ahead of it would
		// make Node reject the launch. API-mode/codex spawn the agent binary
		// directly, where leading flags are valid.
		!(claudeResolvedMode === 'interactive' && resolvedMaestroPBinPath)
	) {
		const mcpTools = getActivePluginManager()?.getContributions().tools ?? [];
		if (mcpTools.length > 0) {
			const mcpSpec = {
				command: process.execPath,
				args: [resolveMaestroCliScriptPath(), 'mcp', 'serve', '--tab', baseSessionId],
				env: {
					ELECTRON_RUN_AS_NODE: '1',
					// The agent's MCP client forwards only a sanitized env subset to
					// the spawned bridge; forward the data-dir overrides the app
					// itself honors so the bridge resolves the SAME discovery file
					// (else custom-data-dir / dev installs silently connect nowhere
					// and advertise zero tools).
					...(process.env.MAESTRO_USER_DATA
						? { MAESTRO_USER_DATA: process.env.MAESTRO_USER_DATA }
						: {}),
					...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
				},
			};
			// Cheap pure pre-build to learn whether this strategy needs temp
			// files; only then allocate a unique per-spawn dir (so concurrent
			// spawns never share/clobber a config) and rebuild with real paths.
			let mcpInjection = buildMcpInjection(mcpCap, mcpSpec, {
				tmpDir: os.tmpdir(),
				join: path.join,
			});
			if (mcpInjection.files.length > 0) {
				const mcpTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maestro-mcp-'));
				mcpInjection = buildMcpInjection(mcpCap, mcpSpec, {
					tmpDir: mcpTmpDir,
					join: path.join,
				});
				for (const file of mcpInjection.files) {
					await fsp.writeFile(file.path, file.content, 'utf-8');
				}
				setTimeout(() => {
					fsp.rm(mcpTmpDir, { recursive: true, force: true }).catch((err: unknown) => {
						if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
							captureException(err instanceof Error ? err : new Error(String(err)), {
								context: 'mcp config temp dir cleanup',
								dir: mcpTmpDir,
							});
						}
					});
				}, 30_000);
			}
			finalArgs = [...mcpInjection.globalArgs, ...finalArgs];
			effectiveCustomEnvVars = {
				...(effectiveCustomEnvVars || {}),
				...mcpInjection.env,
			};
			logger.debug(
				`[Plugins] MCP tool bridge enabled for ${config.toolType} (${mcpTools.length} tools)`,
				LOG_CONTEXT
			);
		}
	}

	// ========================================================================
	// Standard permission mode (Claude Code, API/print path): route tool
	// permission prompts through the Maestro relay. Without this, Claude
	// aborts the whole run on the first non-allowed tool call. The relay
	// injects `--permission-prompt-tool` + `--mcp-config` pointing at a
	// stdio bridge that dials Maestro's loopback socket for a user
	// decision. Not applicable to full/read-only modes, non-claude agents,
	// or the interactive (maestro-p/TUI) path, which renders its own
	// native prompts.
	// ========================================================================
	if (isClaudeCode && claudeResolvedMode === 'api' && config.permissionMode === 'standard') {
		if (isSshEnabled) {
			// Fail loud: never silently downgrade to full/unsafe over SSH.
			// The relay socket is local-only, so it cannot mediate a remote
			// spawn's tool calls; running standard mode remotely without it
			// would leave the agent unable to act. Matches the SSH fail-loud
			// convention (see CLAUDE.md / agent-spawner sshUnresolvedFailure).
			logger.error('Claude Code standard permission mode is not supported over SSH', LOG_CONTEXT, {
				sessionId: config.sessionId,
			});
			const win = getMainWindow();
			if (win && isWebContentsAvailable(win)) {
				win.webContents.send(
					'process:data',
					config.sessionId,
					'\r\n[Maestro] Standard permission mode is not available for Claude Code over SSH. ' +
						'Switch this agent to Full Access or Read-Only, or disable SSH.\r\n'
				);
			}
			return { success: false, pid: 0 };
		}
		try {
			const relayArgs = await preparePermissionRelayArgs({
				sessionId: config.sessionId,
				tabId: config.tabId,
				userDataDir: app.getPath('userData'),
				execPath: process.execPath,
			});
			finalArgs = [...finalArgs, ...relayArgs];
		} catch (e) {
			// Fail loud: don't spawn standard mode without the relay (it would
			// abort on the first tool call).
			logger.error('Failed to prepare permission relay', LOG_CONTEXT, {
				sessionId: config.sessionId,
				error: e instanceof Error ? e.message : String(e),
			});
			const win = getMainWindow();
			if (win && isWebContentsAvailable(win)) {
				win.webContents.send(
					'process:data',
					config.sessionId,
					'\r\n[Maestro] Could not start the permission relay for Standard mode. ' +
						'Switch to Full Access or Read-Only to continue.\r\n'
				);
			}
			return { success: false, pid: 0 };
		}
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
			prompt: config.prompt.length > 500 ? config.prompt.substring(0, 500) + '...' : config.prompt,
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
	let commandToSpawn = config.sessionCustomPath || config.command;
	let argsToSpawn = finalArgs;
	let useShell = false;
	let sshRemoteUsed: SshRemoteConfig | null = null;
	let customEnvVarsToPass: Record<string, string> | undefined = effectiveCustomEnvVars;

	// ========================================================================
	// Account Multiplexing: Inject CLAUDE_CONFIG_DIR for account assignment
	// Must happen before SSH command building so the env var is included
	// ========================================================================
	const accountRegistry = deps.getAccountRegistry?.();
	if (accountRegistry) {
		const envToInject: Record<string, string> = customEnvVarsToPass
			? { ...customEnvVarsToPass }
			: {};
		const assignedAccountId = injectAccountEnv(
			config.sessionId,
			config.toolType,
			envToInject,
			accountRegistry,
			config.accountId, // May be passed from renderer
			safeSend,
			() => {
				const db = getStatsDB();
				return db.isReady() ? db : null;
			}
		);
		if (assignedAccountId) {
			customEnvVarsToPass = envToInject;
		}
	}

	({ commandToSpawn, argsToSpawn, customEnvVarsToPass } = applyLocalInteractiveSpawnDecision({
		config,
		agent,
		claudeContext,
		commandToSpawn,
		argsToSpawn,
		customEnvVarsToPass,
	}));

	persistClaudeInteractiveMode(config, claudeContext, {
		sessionsStore: deps.sessionsStore,
		safeSend,
		getMainWindow,
	});

	if (config.sessionCustomPath) {
		logger.debug(`Using session-level custom path for ${config.toolType}`, LOG_CONTEXT, {
			customPath: config.sessionCustomPath,
			originalCommand: config.command,
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

	const sshWrap = await wrapSpawnForSsh({
		config,
		agent,
		claudeContext,
		commandToSpawn,
		argsToSpawn,
		headlessArgs: finalArgs,
		customEnvVarsToPass,
		effectiveCustomEnvVars,
		effectivePrompt,
		globalShellEnvVars,
		useShell,
		shellToUse,
		settingsStore,
	});
	const sshStdinScript = sshWrap.sshStdinScript;
	const sshRemoteCommand = sshWrap.sshRemoteCommand;
	commandToSpawn = sshWrap.commandToSpawn;
	argsToSpawn = sshWrap.argsToSpawn;
	sshRemoteUsed = sshWrap.sshRemoteUsed;
	customEnvVarsToPass = sshWrap.customEnvVarsToPass;
	useShell = sshWrap.useShell;
	shellToUse = sshWrap.shellToUse;

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
	const localSpawnBinaryPath = !sshRemoteUsed ? config.sessionCustomPath || agent?.path : undefined;
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
	const sshRemoteInfo = sshRemoteUsed
		? {
				id: sshRemoteUsed.id,
				name: sshRemoteUsed.name,
				host: sshRemoteUsed.host,
			}
		: null;
	if (safeSend) {
		safeSend('process:ssh-remote', config.sessionId, sshRemoteInfo);
	} else {
		const mainWindow = getMainWindow();
		if (isWebContentsAvailable(mainWindow)) {
			mainWindow.webContents.send('process:ssh-remote', config.sessionId, sshRemoteInfo);
		}
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
