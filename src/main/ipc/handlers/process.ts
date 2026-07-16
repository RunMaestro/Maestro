import { ipcMain, BrowserWindow } from 'electron';
import Store from 'electron-store';
import type { AgentConfigsData } from '../../stores/types';
import * as os from 'os';
import * as path from 'path';
import { ProcessManager } from '../../process-manager';
import { AgentDetector } from '../../agents';
import type { InteractiveReplayController } from '../../agents/claude-interactive-replay';
import type { ProcessConfig as ProcessSpawnConfig } from '../../process-manager/types';
import { logger } from '../../utils/logger';
import { getChildProcesses } from '../../process-manager/utils/childProcessInfo';
import { addBreadcrumb } from '../../utils/sentry';
import { isWebContentsAvailable } from '../../utils/safe-send';
import {
	withIpcErrorLogging,
	requireProcessManager,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { getSshRemoteConfig, createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { shellEscape } from '../../utils/shell-escape';
import { resolveSshPath } from '../../utils/cliDetection';
import type { SshRemoteConfig } from '../../../shared/types';
import { MaestroSettings } from './persistence';
import { getDefaultShell } from '../../stores/defaults';
import { handleProcessSpawn } from './process/handle-spawn';
import type { SpawnProcessConfig } from './process/spawn-types';
import { OmpNativeSessionAdapter } from '../../omp-native/session-adapter';
import {
	initPermissionRelay,
	resolvePermissionResponse,
	type PermissionDecision,
} from '../../permission-relay';
import type { ManagedRuntimeResolver } from '../../plugins/plugin-managed-runtime-service';

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
	safeSend?: (channel: string, ...args: unknown[]) => void;
	sessionsStore: Store<{ sessions: any[] }>;
	/** First-party OMP runtime resolver required for native JSONL launch. */
	ompRuntimeResolver?: ManagedRuntimeResolver;
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
	const {
		getProcessManager,
		getAgentDetector,
		agentConfigsStore,
		settingsStore,
		getMainWindow,
		safeSend,
	} = deps;

	// Wire the Claude Code permission relay: surface requests to the renderer
	// and clean up per-spawn bindings when a process exits.
	initPermissionRelay(getMainWindow, getProcessManager());

	// Renderer -> main: the user's allow/deny decision for a relayed request.
	ipcMain.handle(
		'permission:respond',
		(_event, requestId: string, decision: PermissionDecision) => {
			return resolvePermissionResponse(requestId, decision);
		}
	);

	// Spawn a new process for a session
	// Supports agent-specific argument builders for batch mode, JSON output, resume, read-only mode, YOLO mode
	ipcMain.handle(
		'process:spawn',
		withIpcErrorLogging(handlerOpts('spawn'), (config: SpawnProcessConfig) =>
			handleProcessSpawn(config, {
				getProcessManager,
				getAgentDetector,
				agentConfigsStore,
				settingsStore,
				getMainWindow,
				safeSend,
				ompRuntimeResolver: deps.ompRuntimeResolver,
				sessionsStore: deps.sessionsStore,
				interactiveReplayController: deps.interactiveReplayController,
			})
		)
	);

	ipcMain.handle(
		'process:respond-approval',
		withIpcErrorLogging(
			handlerOpts('respond-approval'),
			async (payload: unknown): Promise<boolean> => {
				if (!isOmpPayload(payload, ['sessionId', 'requestId'])) return false;
				const { sessionId, requestId, optionId, value, cancelled } = payload as {
					sessionId: string;
					requestId: string;
					optionId?: unknown;
					value?: unknown;
					cancelled?: unknown;
				};
				if (
					(optionId !== undefined && typeof optionId !== 'string') ||
					(value !== undefined && typeof value !== 'string') ||
					(cancelled !== undefined && typeof cancelled !== 'boolean')
				)
					return false;
				const adapter = OmpNativeSessionAdapter.forSession(sessionId);
				const responded = adapter
					? await adapter.respondApproval(requestId, { optionId, value, cancelled })
					: false;
				if (!responded)
					logger.warn('OMP approval response was rejected', LOG_CONTEXT, {
						sessionId,
						requestId,
						optionId,
					});
				return responded;
			}
		)
	);

	ipcMain.handle(
		'process:set-agent-control',
		withIpcErrorLogging(
			handlerOpts('set-agent-control'),
			async (payload: unknown): Promise<boolean> => {
				if (!isOmpPayload(payload, ['sessionId', 'controlId'])) return false;
				const { sessionId, controlId, value } = payload as {
					sessionId: string;
					controlId: string;
					value: unknown;
				};
				if (typeof value !== 'string' && typeof value !== 'boolean') return false;
				const adapter = OmpNativeSessionAdapter.forSession(sessionId);
				return adapter ? adapter.setControl(controlId, value) : false;
			}
		)
	);

	ipcMain.handle(
		'process:branch-session',
		withIpcErrorLogging(
			handlerOpts('branch-session'),
			async (payload: unknown): Promise<boolean> => {
				if (!isOmpPayload(payload, ['sessionId', 'entryId'])) return false;
				const { sessionId, entryId } = payload as { sessionId: string; entryId: string };
				const adapter = OmpNativeSessionAdapter.forSession(sessionId);
				return adapter ? adapter.branch(entryId) : false;
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

	ipcMain.handle(
		'process:broadcast-user-input',
		withIpcErrorLogging(
			handlerOpts('broadcast-user-input'),
			async (payload: {
				originId: string;
				sessionId: string;
				tabId?: string;
				inputMode: 'ai' | 'terminal';
				entry: {
					id: string;
					timestamp: number;
					source: 'user';
					text: string;
					images?: string[];
					readOnly?: boolean;
					forceParallel?: boolean;
				};
			}) => {
				if (safeSend) {
					safeSend('process:user-input', payload);
					return;
				}
				const mainWindow = getMainWindow();
				if (mainWindow && isWebContentsAvailable(mainWindow)) {
					mainWindow.webContents.send('process:user-input', payload);
				}
			}
		)
	);

	// Send an RPC abort for a live native OMP session; other agents retain
	// ProcessManager's existing platform-specific interrupt implementation.
	ipcMain.handle(
		'process:interrupt',
		withIpcErrorLogging(handlerOpts('interrupt'), async (sessionId: string) => {
			if (typeof sessionId !== 'string') return false;
			const ompAdapter = OmpNativeSessionAdapter.forSession(sessionId);
			if (ompAdapter) {
				await ompAdapter.interrupt();
				return true;
			}
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

function isOmpPayload(
	payload: unknown,
	required: readonly string[]
): payload is Record<string, unknown> & { sessionId: string } {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
	const record = payload as Record<string, unknown>;
	return required.every((key) => typeof record[key] === 'string');
}
