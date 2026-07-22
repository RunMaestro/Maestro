/**
 * Preload API for process management
 *
 * Provides the window.maestro.process namespace for:
 * - Spawning and managing agent/terminal processes
 * - Writing to processes
 * - Handling process events (data, exit, errors)
 * - Remote command execution from web interface
 * - SSH remote execution support
 */

import { ipcRenderer } from 'electron';
import type { UsageStats, GroupAppearanceEcho, UpdateGroupPayload } from '../../shared/types';
import type { CadenzaPayload } from '../../shared/cadenza-types';
import type { MovementPayload, MovementStateSnapshot } from '../../shared/movement-types';

// Re-export for consumers that import from preload
export type { UsageStats } from '../../shared/types';

/**
 * Helper to log via the main process logger.
 * Uses 'debug' level for preload operations.
 */
const log = (message: string, data?: unknown) => {
	ipcRenderer.invoke('logger:log', 'debug', message, 'Preload', data);
};

/**
 * Configuration for spawning a process
 */
export interface ProcessConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	shell?: string;
	images?: string[]; // Base64 data URLs for images
	// Agent-specific spawn options (used to build args via agent config)
	agentSessionId?: string; // For session resume (uses agent's resumeArgs builder)
	readOnlyMode?: boolean; // For read-only/plan mode (uses agent's readOnlyArgs)
	modelId?: string; // For model selection (uses agent's modelArgs builder)
	yoloMode?: boolean; // For YOLO/full-access mode (uses agent's yoloModeArgs)
	permissionMode?: 'full' | 'standard' | 'readonly'; // 3-way permission mode (overrides readOnlyMode/yoloMode)
	// System prompt delivery (separate from user message for token efficiency)
	appendSystemPrompt?: string; // System prompt to pass via --append-system-prompt or embed in prompt
	// Stdin-based prompt delivery (Windows workaround for CLI length limits)
	sendPromptViaStdin?: boolean; // If true, send prompt via stdin as JSON (for stream-json compatible agents)
	sendPromptViaStdinRaw?: boolean; // If true, send prompt via stdin as raw text (for agents without stream-json)
	// Stats tracking options
	querySource?: 'user' | 'auto'; // Whether this query is user-initiated or from Auto Run
	tabId?: string; // Tab ID for multi-tab tracking
}

/**
 * Response from spawning a process
 */
export interface ProcessSpawnResponse {
	pid: number;
	success: boolean;
	sshRemote?: { id: string; name: string; host: string };
}

/**
 * Configuration for running a single command
 */
export interface RunCommandConfig {
	sessionId: string;
	command: string;
	cwd: string;
	shell?: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * Active process information
 */
export interface ActiveProcess {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime: number;
	command?: string;
	args?: string[];
	/** True if this is a Cue automation run process */
	isCueRun?: boolean;
	/** The Cue run ID (for stopping via cue:stopRun) */
	cueRunId?: string;
	/** Target session name for this Cue run */
	cueSessionName?: string;
	/** Subscription name that triggered this Cue run */
	cueSubscriptionName?: string;
	/** Event type that triggered this Cue run */
	cueEventType?: string;
	/** Child processes running inside this process (e.g., commands in a terminal shell) */
	childProcesses?: Array<{ pid: number; command: string }>;
}

// UsageStats imported and re-exported from shared/types above

/**
 * Agent error information
 */
export interface AgentError {
	type: string;
	message: string;
	recoverable: boolean;
	agentId: string;
	sessionId?: string;
	timestamp: number;
	raw?: {
		exitCode?: number;
		stderr?: string;
		stdout?: string;
		errorLine?: string;
	};
}

/**
 * Tool execution event
 */
export interface ToolExecutionEvent {
	toolName: string;
	state?: unknown;
	timestamp: number;
	/** Stable correlation id from the agent. When present, the renderer
	 *  merges `running` and `completed`/`failed` events into a single log
	 *  entry instead of appending two bubbles. */
	toolCallId?: string;
}

export interface ProcessUserInputBroadcast {
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
}

/**
 * SSH remote info
 */
export interface SshRemoteInfo {
	id: string;
	name: string;
	host: string;
}

/**
 * Creates the process API object for preload exposure
 */
export function createProcessApi() {
	return {
		/**
		 * Spawn a new process (agent or terminal)
		 */
		spawn: (config: ProcessConfig): Promise<ProcessSpawnResponse> =>
			ipcRenderer.invoke('process:spawn', config),

		/**
		 * Spawn a terminal tab PTY (convenience wrapper for xterm.js terminal tabs)
		 */
		spawnTerminalTab: (config: {
			sessionId: string;
			cwd: string;
			shell?: string;
			shellArgs?: string;
			shellEnvVars?: Record<string, string>;
			toolType?: string;
			sessionCustomEnvVars?: Record<string, string>;
			cols?: number;
			rows?: number;
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
			};
		}): Promise<{ pid: number; success: boolean }> =>
			ipcRenderer.invoke('process:spawnTerminalTab', config),

		/**
		 * Write data to a process stdin
		 */
		write: (sessionId: string, data: string): Promise<boolean> =>
			ipcRenderer.invoke('process:write', sessionId, data),

		broadcastUserInput: (payload: ProcessUserInputBroadcast): Promise<void> =>
			ipcRenderer.invoke('process:broadcast-user-input', payload),

		/**
		 * Send interrupt signal (Ctrl+C) to a process
		 */
		interrupt: (sessionId: string): Promise<boolean> =>
			ipcRenderer.invoke('process:interrupt', sessionId),

		/**
		 * Kill a process
		 */
		kill: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('process:kill', sessionId),

		/**
		 * Resize process terminal
		 */
		resize: (sessionId: string, cols: number, rows: number): Promise<boolean> =>
			ipcRenderer.invoke('process:resize', sessionId, cols, rows),

		/**
		 * Run a single command and capture only stdout/stderr (no PTY echo/prompts)
		 * Supports SSH remote execution when sessionSshRemoteConfig is provided
		 */
		runCommand: (config: RunCommandConfig): Promise<{ exitCode: number }> =>
			ipcRenderer.invoke('process:runCommand', config),

		/**
		 * Get all active processes from ProcessManager
		 */
		getActiveProcesses: (): Promise<ActiveProcess[]> =>
			ipcRenderer.invoke('process:getActiveProcesses'),

		/**
		 * Check whether a terminal tab's PTY has a non-shell foreground process
		 * (i.e. is actively running a command). Returns false if no PTY is found.
		 */
		isTerminalBusy: (sessionId: string): Promise<boolean> =>
			ipcRenderer.invoke('process:isTerminalBusy', sessionId),

		// Event listeners

		/**
		 * Subscribe to process data output
		 */
		onData: (callback: (sessionId: string, data: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, data: string) => callback(sessionId, data);
			ipcRenderer.on('process:data', handler);
			return () => ipcRenderer.removeListener('process:data', handler);
		},

		onUserInput: (callback: (payload: ProcessUserInputBroadcast) => void): (() => void) => {
			const handler = (_: unknown, payload: ProcessUserInputBroadcast) => callback(payload);
			ipcRenderer.on('process:user-input', handler);
			return () => ipcRenderer.removeListener('process:user-input', handler);
		},

		/**
		 * Subscribe to process exit events.
		 * `signal` is present only when the process was killed by a signal.
		 */
		onExit: (
			callback: (sessionId: string, code: number, signal?: number) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, code: number, signal?: number) =>
				callback(sessionId, code, signal);
			ipcRenderer.on('process:exit', handler);
			return () => ipcRenderer.removeListener('process:exit', handler);
		},

		/**
		 * Subscribe to Claude Code permission-relay requests (standard mode).
		 * The renderer shows a prompt and replies via respondPermission().
		 */
		onPermissionRequest: (
			callback: (request: {
				requestId: string;
				sessionId: string;
				tabId?: string;
				toolName: string;
				input: Record<string, unknown>;
				createdAt: number;
			}) => void
		): (() => void) => {
			const handler = (_: unknown, request: Parameters<typeof callback>[0]) => callback(request);
			ipcRenderer.on('process:permission-request', handler);
			return () => ipcRenderer.removeListener('process:permission-request', handler);
		},

		/**
		 * Send the user's allow/deny decision for a relayed permission request.
		 */
		respondPermission: (
			requestId: string,
			decision:
				| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
				| { behavior: 'deny'; message: string }
		): Promise<boolean> => ipcRenderer.invoke('permission:respond', requestId, decision),

		/**
		 * Subscribe to agent session ID events
		 */
		onSessionId: (callback: (sessionId: string, agentSessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, agentSessionId: string) =>
				callback(sessionId, agentSessionId);
			ipcRenderer.on('process:session-id', handler);
			return () => ipcRenderer.removeListener('process:session-id', handler);
		},

		/**
		 * Subscribe to slash commands discovered from agent
		 */
		onSlashCommands: (
			callback: (sessionId: string, slashCommands: string[]) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, slashCommands: string[]) =>
				callback(sessionId, slashCommands);
			ipcRenderer.on('process:slash-commands', handler);
			return () => ipcRenderer.removeListener('process:slash-commands', handler);
		},

		/**
		 * Subscribe to thinking/streaming content chunks from AI agents
		 * Emitted when agents produce partial text events (isPartial: true)
		 * Renderer decides whether to display based on tab's showThinking setting
		 */
		onThinkingChunk: (callback: (sessionId: string, content: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, content: string) =>
				callback(sessionId, content);
			ipcRenderer.on('process:thinking-chunk', handler);
			return () => ipcRenderer.removeListener('process:thinking-chunk', handler);
		},

		/**
		 * Subscribe to tool execution events
		 */
		onToolExecution: (
			callback: (sessionId: string, toolEvent: ToolExecutionEvent) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, toolEvent: ToolExecutionEvent) =>
				callback(sessionId, toolEvent);
			ipcRenderer.on('process:tool-execution', handler);
			return () => ipcRenderer.removeListener('process:tool-execution', handler);
		},

		/**
		 * Subscribe to SSH remote execution status
		 * Emitted when a process starts executing via SSH on a remote host
		 */
		onSshRemote: (
			callback: (sessionId: string, sshRemote: SshRemoteInfo | null) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, sshRemote: SshRemoteInfo | null) =>
				callback(sessionId, sshRemote);
			ipcRenderer.on('process:ssh-remote', handler);
			return () => ipcRenderer.removeListener('process:ssh-remote', handler);
		},

		/**
		 * Subscribe to Claude headless-mode resolution.
		 * Emitted after a Claude Code spawn succeeds, carrying the mode the spawner
		 * actually picked (`api` vs `interactive`/maestro-p), the reason tag for
		 * persistence, and the canonical CLAUDE_CONFIG_DIR key the snapshot was
		 * consulted under. Non-Claude agents and SSH Claude spawns don't fire this.
		 */
		onClaudeModeResolved: (
			callback: (
				sessionId: string,
				resolution: {
					mode: 'interactive' | 'api';
					reason: 'auto' | 'limit';
					configDirKey: string;
				}
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				resolution: {
					mode: 'interactive' | 'api';
					reason: 'auto' | 'limit';
					configDirKey: string;
				}
			) => callback(sessionId, resolution);
			ipcRenderer.on('process:claude-mode-resolved', handler);
			return () => ipcRenderer.removeListener('process:claude-mode-resolved', handler);
		},

		/**
		 * Subscribe to remote command execution from web interface
		 * This allows web commands to go through the same code path as desktop commands
		 * inputMode is optional - if provided, renderer should use it instead of session state
		 */
		onRemoteCommand: (
			callback: (
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[]
			) => void
		): (() => void) => {
			log('Registering onRemoteCommand listener');
			const handler = (
				_: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[]
			) => {
				log('Received remote:executeCommand IPC', {
					sessionId,
					commandPreview: command?.substring(0, 50),
					inputMode,
					tabId,
					force,
					imageCount: images?.length ?? 0,
				});
				try {
					callback(sessionId, command, inputMode, tabId, force, images);
				} catch (error) {
					ipcRenderer.invoke(
						'logger:log',
						'error',
						'Error invoking remote command callback',
						'Preload',
						{ error: String(error) }
					);
				}
			};
			ipcRenderer.on('remote:executeCommand', handler);
			return () => ipcRenderer.removeListener('remote:executeCommand', handler);
		},

		/**
		 * Subscribe to remote mode switch from web interface
		 * Forwards to desktop's toggleInputMode logic
		 */
		onRemoteSwitchMode: (
			callback: (sessionId: string, mode: 'ai' | 'terminal') => void
		): (() => void) => {
			log('Registering onRemoteSwitchMode listener');
			const handler = (_: unknown, sessionId: string, mode: 'ai' | 'terminal') => {
				log('Received remote:switchMode IPC', { sessionId, mode });
				callback(sessionId, mode);
			};
			ipcRenderer.on('remote:switchMode', handler);
			return () => ipcRenderer.removeListener('remote:switchMode', handler);
		},

		/**
		 * Subscribe to remote interrupt from web interface
		 * Forwards to desktop's handleInterrupt logic
		 */
		onRemoteInterrupt: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:interrupt', handler);
			return () => ipcRenderer.removeListener('remote:interrupt', handler);
		},

		/**
		 * Subscribe to remote session selection from web interface
		 * Forwards to desktop's setActiveSessionId logic
		 * Optional tabId to also switch to a specific tab within the session
		 */
		onRemoteSelectSession: (
			callback: (sessionId: string, tabId?: string) => void
		): (() => void) => {
			log('Registering onRemoteSelectSession listener');
			const handler = (_: unknown, sessionId: string, tabId?: string) => {
				log('Received remote:selectSession IPC', { sessionId, tabId });
				callback(sessionId, tabId);
			};
			ipcRenderer.on('remote:selectSession', handler);
			return () => ipcRenderer.removeListener('remote:selectSession', handler);
		},

		/**
		 * Subscribe to remote tab selection from web interface
		 */
		onRemoteSelectTab: (callback: (sessionId: string, tabId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string) => callback(sessionId, tabId);
			ipcRenderer.on('remote:selectTab', handler);
			return () => ipcRenderer.removeListener('remote:selectTab', handler);
		},

		/**
		 * Subscribe to remote new tab from web interface
		 */
		onRemoteNewTab: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) =>
				callback(sessionId, responseChannel);
			ipcRenderer.on('remote:newTab', handler);
			return () => ipcRenderer.removeListener('remote:newTab', handler);
		},

		/**
		 * Send response for remote new tab
		 */
		sendRemoteNewTabResponse: (responseChannel: string, result: { tabId: string } | null): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote close tab from web interface
		 */
		onRemoteCloseTab: (callback: (sessionId: string, tabId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string) => callback(sessionId, tabId);
			ipcRenderer.on('remote:closeTab', handler);
			return () => ipcRenderer.removeListener('remote:closeTab', handler);
		},

		/**
		 * Subscribe to remote rename tab from web interface
		 */
		onRemoteRenameTab: (
			callback: (sessionId: string, tabId: string, newName: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string, newName: string) =>
				callback(sessionId, tabId, newName);
			ipcRenderer.on('remote:renameTab', handler);
			return () => ipcRenderer.removeListener('remote:renameTab', handler);
		},

		/**
		 * Subscribe to remote star tab from web interface
		 */
		onRemoteStarTab: (
			callback: (sessionId: string, tabId: string, starred: boolean) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string, starred: boolean) =>
				callback(sessionId, tabId, starred);
			ipcRenderer.on('remote:starTab', handler);
			return () => ipcRenderer.removeListener('remote:starTab', handler);
		},

		/**
		 * Subscribe to remote reorder tab from web interface
		 */
		onRemoteReorderTab: (
			callback: (sessionId: string, fromIndex: number, toIndex: number) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, fromIndex: number, toIndex: number) =>
				callback(sessionId, fromIndex, toIndex);
			ipcRenderer.on('remote:reorderTab', handler);
			return () => ipcRenderer.removeListener('remote:reorderTab', handler);
		},

		/**
		 * Subscribe to remote bookmark toggle from web interface
		 */
		onRemoteToggleBookmark: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:toggleBookmark', handler);
			return () => ipcRenderer.removeListener('remote:toggleBookmark', handler);
		},

		/**
		 * Subscribe to remote open file tab from web interface.
		 * `switchToAgent` controls whether the UI switches to the target agent
		 * (defaults to true if the sender omits it).
		 */
		onRemoteOpenFileTab: (
			callback: (sessionId: string, filePath: string, switchToAgent: boolean) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, filePath: string, switchToAgent?: boolean) =>
				callback(sessionId, filePath, switchToAgent !== false);
			ipcRenderer.on('remote:openFileTab', handler);
			return () => ipcRenderer.removeListener('remote:openFileTab', handler);
		},

		/**
		 * Subscribe to remote refresh file tree from web interface
		 */
		onRemoteRefreshFileTree: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:refreshFileTree', handler);
			return () => ipcRenderer.removeListener('remote:refreshFileTree', handler);
		},

		/**
		 * Subscribe to remote toast notifications from CLI/web interface.
		 * Color is one of the 5 canonical Toast/Center Flash colors.
		 * `dismissible: true` makes the toast sticky (no auto-dismiss, click-to-close).
		 */
		onRemoteNotifyToast: (
			callback: (params: {
				title: string;
				message: string;
				color: 'green' | 'yellow' | 'orange' | 'red' | 'theme';
				duration?: number;
				dismissible?: boolean;
				sessionId?: string;
				tabId?: string;
				actionUrl?: string;
				actionLabel?: string;
				clickAction?:
					| { kind: 'jump-session'; sessionId: string; tabId?: string }
					| { kind: 'open-file'; sessionId: string; path: string }
					| { kind: 'open-url'; url: string };
			}) => void
		): (() => void) => {
			const handler = (_: unknown, params: Parameters<typeof callback>[0]) => callback(params);
			ipcRenderer.on('remote:notifyToast', handler);
			return () => ipcRenderer.removeListener('remote:notifyToast', handler);
		},

		/**
		 * Subscribe to remote cadenza-view operations (open/update/close) from
		 * the CLI/web interface. Cadenzas are small agent-opened panels that
		 * display or track work.
		 */
		onRemoteCadenza: (callback: (params: CadenzaPayload) => void): (() => void) => {
			const handler = (_: unknown, params: CadenzaPayload) => callback(params);
			ipcRenderer.on('remote:cadenza', handler);
			return () => ipcRenderer.removeListener('remote:cadenza', handler);
		},

		/**
		 * Subscribe to a cadenza "flash" pulse (from a chat "point" chip). The main
		 * process routes it to whichever renderer holds the cadenza - the HUD window,
		 * or the in-app fallback layer - so the card pulses even though cadenzas
		 * normally live in the separate HUD renderer.
		 */
		onRemoteCadenzaFlash: (callback: (id: string) => void): (() => void) => {
			const handler = (_: unknown, id: string) => callback(id);
			ipcRenderer.on('remote:cadenzaFlash', handler);
			return () => ipcRenderer.removeListener('remote:cadenzaFlash', handler);
		},

		/**
		 * Subscribe to remote movement operations (add/update/move/remove/clear) from
		 * the CLI/web interface. The renderer applies them to the movement store and
		 * opens the movement view.
		 */
		onRemoteMovement: (callback: (params: MovementPayload) => void): (() => void) => {
			const handler = (_: unknown, params: MovementPayload) => callback(params);
			ipcRenderer.on('remote:movement', handler);
			return () => ipcRenderer.removeListener('remote:movement', handler);
		},

		/**
		 * Subscribe to `movement state` reads: the main process sends a request with a
		 * response channel; the renderer replies via sendMovementStateResponse with the
		 * current movement snapshot (so an agent can compose around what's there).
		 */
		onRequestMovementState: (callback: (responseChannel: string) => void): (() => void) => {
			const handler = (_: unknown, responseChannel: string) => callback(responseChannel);
			ipcRenderer.on('remote:getMovementState', handler);
			return () => ipcRenderer.removeListener('remote:getMovementState', handler);
		},

		/** Reply to a `movement state` read with the current snapshot. */
		sendMovementStateResponse: (
			responseChannel: string,
			snapshot: MovementStateSnapshot | null
		): void => {
			ipcRenderer.send(responseChannel, snapshot);
		},

		/**
		 * Signal that the cadenza HUD window's renderer has mounted and
		 * subscribed to `remote:cadenza`. The main process buffers the cadenza
		 * that triggered the (lazy) HUD creation until this fires, then flushes it -
		 * otherwise the very first cadenza is dropped before the listener exists.
		 */
		notifyCadenzaHudReady: (): void => {
			ipcRenderer.send('cadenza-hud:ready');
		},

		/**
		 * Ask main to flash (pulse) a cadenza by id - used by the chat "point" chip.
		 * Main routes it to whichever renderer holds the cadenza (HUD window, or the
		 * in-app fallback layer), respecting the Concerto gate.
		 */
		flashCadenza: (id: string): void => {
			ipcRenderer.send('cadenza:flash', id);
		},

		/**
		 * Report the cadenza cards' hit regions (in HUD-window content
		 * coordinates) so the main process can poll the cursor against them and
		 * toggle click-through. Cross-platform by design: renderer mouse-move
		 * forwarding (`setIgnoreMouseEvents` `forward`) is unsupported on Linux.
		 */
		setCadenzaHudCardRects: (
			rects: Array<{ x: number; y: number; width: number; height: number }>
		): void => {
			ipcRenderer.send('cadenza-hud:card-rects', rects);
		},

		/**
		 * Expand a file cadenza from the HUD window into the owning agent's File
		 * Preview tab in the main window. The HUD is a separate window, so it can't
		 * dispatch the in-app `maestro:openFileTab` event directly; the main process
		 * forwards this to the main renderer (and raises it - a deliberate "take me
		 * to Maestro" action, unlike ordinary card interaction).
		 */
		openCadenzaFileTab: (sessionId: string, filePath: string): void => {
			ipcRenderer.send('cadenza-hud:open-file', sessionId, filePath);
		},

		/**
		 * Reply to the owning agent from a `decision` cadenza: the chosen option's
		 * value is injected as a live prompt into that agent's session (the same
		 * path `maestro-cli dispatch` uses), so the agent's next turn sees the
		 * choice. Does not raise Maestro - the decision is made in place.
		 */
		sendCadenzaDecision: (sessionId: string, message: string): void => {
			ipcRenderer.send('cadenza-hud:decision', sessionId, message);
		},

		/**
		 * Subscribe to remote center-flash notifications from CLI/web interface.
		 * Color is one of the 5 canonical Center Flash colors.
		 */
		onRemoteNotifyCenterFlash: (
			callback: (params: {
				message: string;
				detail?: string;
				color: 'green' | 'yellow' | 'orange' | 'red' | 'theme';
				duration?: number;
			}) => void
		): (() => void) => {
			const handler = (_: unknown, params: Parameters<typeof callback>[0]) => callback(params);
			ipcRenderer.on('remote:notifyCenterFlash', handler);
			return () => ipcRenderer.removeListener('remote:notifyCenterFlash', handler);
		},

		/**
		 * Subscribe to remote open browser tab from CLI/web interface.
		 * Renderer must ack success via sendRemoteOpenBrowserTabResponse.
		 * If the callback throws synchronously, ack false first so the CLI
		 * doesn't wait for the 5s response timeout, then rethrow for Sentry.
		 */
		onRemoteOpenBrowserTab: (
			callback: (sessionId: string, url: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, url: string, responseChannel: string) => {
				try {
					callback(sessionId, url, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, false);
					throw error;
				}
			};
			ipcRenderer.on('remote:openBrowserTab', handler);
			return () => ipcRenderer.removeListener('remote:openBrowserTab', handler);
		},

		/**
		 * Send response for remote open browser tab
		 */
		sendRemoteOpenBrowserTabResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote open terminal tab from CLI/web interface.
		 * Renderer must ack success via sendRemoteOpenTerminalTabResponse.
		 * Ack false before rethrowing synchronous callback errors so the CLI
		 * doesn't wait for the 5s response timeout.
		 */
		onRemoteOpenTerminalTab: (
			callback: (
				sessionId: string,
				config: { cwd?: string; shell?: string; name?: string | null },
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				config: { cwd?: string; shell?: string; name?: string | null },
				responseChannel: string
			) => {
				try {
					callback(sessionId, config, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, false);
					throw error;
				}
			};
			ipcRenderer.on('remote:openTerminalTab', handler);
			return () => ipcRenderer.removeListener('remote:openTerminalTab', handler);
		},

		/**
		 * Send response for remote open terminal tab
		 */
		sendRemoteOpenTerminalTabResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote "new AI tab with prompt" from CLI/web interface.
		 * Renderer must ack success via sendRemoteNewAITabWithPromptResponse.
		 * Ack false before rethrowing synchronous callback errors so the CLI
		 * doesn't wait for the 5s response timeout.
		 */
		onRemoteNewAITabWithPrompt: (
			callback: (sessionId: string, prompt: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, prompt: string, responseChannel: string) => {
				try {
					callback(sessionId, prompt, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, false);
					throw error;
				}
			};
			ipcRenderer.on('remote:newAITabWithPrompt', handler);
			return () => ipcRenderer.removeListener('remote:newAITabWithPrompt', handler);
		},

		/**
		 * Send response for remote "new AI tab with prompt".
		 * `tabId` is the id of the freshly-created tab — surfaced so
		 * `maestro-cli dispatch --new-tab` can return an addressable id to its
		 * caller without owning a persistent channel.
		 */
		sendRemoteNewAITabWithPromptResponse: (
			responseChannel: string,
			success: boolean,
			tabId?: string
		): void => {
			ipcRenderer.send(responseChannel, { success, tabId });
		},

		/**
		 * Subscribe to remote refresh auto-run docs from web interface
		 */
		onRemoteRefreshAutoRunDocs: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:refreshAutoRunDocs', handler);
			return () => ipcRenderer.removeListener('remote:refreshAutoRunDocs', handler);
		},

		/**
		 * Subscribe to remote configure auto-run from CLI/web interface
		 */
		onRemoteConfigureAutoRun: (
			callback: (sessionId: string, config: any, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, config: any, responseChannel: string) => {
				try {
					// callback may return a promise even though typed as void
					Promise.resolve(callback(sessionId, config, responseChannel)).catch((error) => {
						ipcRenderer.send(responseChannel, {
							success: false,
							error: error instanceof Error ? error.message : String(error),
						});
					});
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			};
			ipcRenderer.on('remote:configureAutoRun', handler);
			return () => ipcRenderer.removeListener('remote:configureAutoRun', handler);
		},

		/**
		 * Send response for remote configure auto-run
		 */
		sendRemoteConfigureAutoRunResponse: (
			responseChannel: string,
			result: { success: boolean; playbookId?: string; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote create-worktree-agent from the CLI. Creates a new
		 * agent in a git worktree branched off a parent agent, without Auto Run.
		 */
		onRemoteCreateWorktreeSession: (
			callback: (parentSessionId: string, config: any, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				parentSessionId: string,
				config: any,
				responseChannel: string
			) => {
				try {
					// callback may return a promise even though typed as void
					Promise.resolve(callback(parentSessionId, config, responseChannel)).catch((error) => {
						ipcRenderer.send(responseChannel, {
							success: false,
							error: error instanceof Error ? error.message : String(error),
						});
					});
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			};
			ipcRenderer.on('remote:createWorktreeSession', handler);
			return () => ipcRenderer.removeListener('remote:createWorktreeSession', handler);
		},

		/**
		 * Send response for remote create-worktree-agent
		 */
		sendRemoteCreateWorktreeSessionResponse: (
			responseChannel: string,
			result: { success: boolean; sessionId?: string; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote set Auto Run folder from web interface
		 * (request-response). Web clients use this to repoint a session at a
		 * different `.maestro/` folder, mirroring desktop's `dialog.selectFolder`
		 * + `handleAutoRunFolderSelected` flow.
		 */
		onRemoteSetAutoRunFolder: (
			callback: (sessionId: string, folderPath: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				folderPath: string,
				responseChannel: string
			) => {
				// Ack the response with a fallback so the web client doesn't hang on
				// a regression, then rethrow so Sentry actually sees the bug instead
				// of silently degrading. Mirrors `onRemoteOpenBrowserTab`'s pattern.
				try {
					Promise.resolve(callback(sessionId, folderPath, responseChannel)).catch((error) => {
						ipcRenderer.send(responseChannel, {
							success: false,
							error: error instanceof Error ? error.message : String(error),
						});
						throw error;
					});
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			};
			ipcRenderer.on('remote:setAutoRunFolder', handler);
			return () => ipcRenderer.removeListener('remote:setAutoRunFolder', handler);
		},

		/**
		 * Send response for remote set Auto Run folder
		 */
		sendRemoteSetAutoRunFolderResponse: (
			responseChannel: string,
			result: { success: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote get auto-run docs from web interface (request-response)
		 */
		onRemoteGetAutoRunDocs: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, []);
					});
				} catch {
					ipcRenderer.send(responseChannel, []);
				}
			};
			ipcRenderer.on('remote:getAutoRunDocs', handler);
			return () => ipcRenderer.removeListener('remote:getAutoRunDocs', handler);
		},

		/**
		 * Send response for remote get auto-run docs
		 */
		sendRemoteGetAutoRunDocsResponse: (responseChannel: string, documents: any[]): void => {
			ipcRenderer.send(responseChannel, documents);
		},

		/**
		 * Subscribe to remote get auto-run doc content from web interface (request-response)
		 */
		onRemoteGetAutoRunDocContent: (
			callback: (sessionId: string, filename: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				filename: string,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, filename, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, '');
					});
				} catch {
					ipcRenderer.send(responseChannel, '');
				}
			};
			ipcRenderer.on('remote:getAutoRunDocContent', handler);
			return () => ipcRenderer.removeListener('remote:getAutoRunDocContent', handler);
		},

		/**
		 * Send response for remote get auto-run doc content
		 */
		sendRemoteGetAutoRunDocContentResponse: (responseChannel: string, content: string): void => {
			ipcRenderer.send(responseChannel, content);
		},

		/**
		 * Subscribe to remote save auto-run doc from web interface (request-response)
		 */
		onRemoteSaveAutoRunDoc: (
			callback: (
				sessionId: string,
				filename: string,
				content: string,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				filename: string,
				content: string,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, filename, content, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, false);
					});
				} catch {
					ipcRenderer.send(responseChannel, false);
				}
			};
			ipcRenderer.on('remote:saveAutoRunDoc', handler);
			return () => ipcRenderer.removeListener('remote:saveAutoRunDoc', handler);
		},

		/**
		 * Send response for remote save auto-run doc
		 */
		sendRemoteSaveAutoRunDocResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote stop auto-run from web interface (fire-and-forget)
		 */
		onRemoteStopAutoRun: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:stopAutoRun', handler);
			return () => ipcRenderer.removeListener('remote:stopAutoRun', handler);
		},

		/**
		 * Subscribe to remote reset auto-run document tasks
		 * (request-response — renderer reads/writes the document via existing autorun IPC).
		 *
		 * On failure we ack the channel with a fallback (so the web client doesn't hang)
		 * and then rethrow so the unhandled rejection reaches Sentry via the global handler.
		 */
		onRemoteResetAutoRunDocTasks: (
			callback: (sessionId: string, filename: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				filename: string,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, filename, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:resetAutoRunDocTasks', handler);
			return () => ipcRenderer.removeListener('remote:resetAutoRunDocTasks', handler);
		},

		sendRemoteResetAutoRunDocTasksResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote auto-run error-recovery actions (resume / skip-document / abort).
		 * Each action mirrors the desktop AutoRunErrorBanner buttons.
		 */
		onRemoteResumeAutoRunError: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:resumeAutoRunError', handler);
			return () => ipcRenderer.removeListener('remote:resumeAutoRunError', handler);
		},

		sendRemoteResumeAutoRunErrorResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		onRemoteSkipAutoRunDocument: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:skipAutoRunDocument', handler);
			return () => ipcRenderer.removeListener('remote:skipAutoRunDocument', handler);
		},

		sendRemoteSkipAutoRunDocumentResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		onRemoteAbortAutoRunError: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:abortAutoRunError', handler);
			return () => ipcRenderer.removeListener('remote:abortAutoRunError', handler);
		},

		sendRemoteAbortAutoRunErrorResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote playbook CRUD from web interface (request-response).
		 * Renderer forwards to window.maestro.playbooks.* IPC and replies on the channel.
		 *
		 * Failure handling: each handler acks the IPC channel with a neutral
		 * fallback (`[]` / `null` / `false`) so the web client doesn't hang on a
		 * regression, and rethrows the error so Sentry's global unhandled-rejection
		 * hook still reports the cause. The web UI currently can't distinguish a
		 * legitimate empty list from a transport failure with this shape — a
		 * follow-up will move these to the structured `{ success, error }` payload
		 * used by `onRemoteSetAutoRunFolder` (tracked in the AutoRun follow-up gist).
		 */
		onRemoteListPlaybooks: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, []);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, []);
					throw err;
				}
			};
			ipcRenderer.on('remote:listPlaybooks', handler);
			return () => ipcRenderer.removeListener('remote:listPlaybooks', handler);
		},

		sendRemoteListPlaybooksResponse: (responseChannel: string, playbooks: unknown[]): void => {
			ipcRenderer.send(responseChannel, playbooks);
		},

		onRemoteCreatePlaybook: (
			callback: (sessionId: string, playbook: unknown, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				playbook: unknown,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, playbook, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, null);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, null);
					throw err;
				}
			};
			ipcRenderer.on('remote:createPlaybook', handler);
			return () => ipcRenderer.removeListener('remote:createPlaybook', handler);
		},

		sendRemoteCreatePlaybookResponse: (responseChannel: string, playbook: unknown): void => {
			ipcRenderer.send(responseChannel, playbook);
		},

		onRemoteUpdatePlaybook: (
			callback: (
				sessionId: string,
				playbookId: string,
				updates: unknown,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				playbookId: string,
				updates: unknown,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, playbookId, updates, responseChannel)).catch(
						(err) => {
							ipcRenderer.send(responseChannel, null);
							throw err;
						}
					);
				} catch (err) {
					ipcRenderer.send(responseChannel, null);
					throw err;
				}
			};
			ipcRenderer.on('remote:updatePlaybook', handler);
			return () => ipcRenderer.removeListener('remote:updatePlaybook', handler);
		},

		sendRemoteUpdatePlaybookResponse: (responseChannel: string, playbook: unknown): void => {
			ipcRenderer.send(responseChannel, playbook);
		},

		onRemoteDeletePlaybook: (
			callback: (sessionId: string, playbookId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				playbookId: string,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, playbookId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:deletePlaybook', handler);
			return () => ipcRenderer.removeListener('remote:deletePlaybook', handler);
		},

		sendRemoteDeletePlaybookResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote set setting from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteSetSetting: (
			callback: (key: string, value: unknown, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, key: string, value: unknown, responseChannel: string) =>
				callback(key, value, responseChannel);
			ipcRenderer.on('remote:setSetting', handler);
			return () => ipcRenderer.removeListener('remote:setSetting', handler);
		},

		/**
		 * Send response for remote set setting
		 */
		sendRemoteSetSettingResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote create session from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteCreateSession: (
			callback: (
				name: string,
				toolType: string,
				cwd: string,
				groupId: string | undefined,
				config: Record<string, unknown> | undefined,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				name: string,
				toolType: string,
				cwd: string,
				groupId: string | undefined,
				config: Record<string, unknown> | undefined,
				responseChannel: string
			) => callback(name, toolType, cwd, groupId, config, responseChannel);
			ipcRenderer.on('remote:createSession', handler);
			return () => ipcRenderer.removeListener('remote:createSession', handler);
		},

		/**
		 * Send response for remote create session
		 */
		sendRemoteCreateSessionResponse: (
			responseChannel: string,
			result: { sessionId: string } | null
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote delete session from web interface (fire-and-forget)
		 */
		onRemoteDeleteSession: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:deleteSession', handler);
			return () => ipcRenderer.removeListener('remote:deleteSession', handler);
		},

		/**
		 * Subscribe to remote rename session from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteRenameSession: (
			callback: (sessionId: string, newName: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, newName: string, responseChannel: string) =>
				callback(sessionId, newName, responseChannel);
			ipcRenderer.on('remote:renameSession', handler);
			return () => ipcRenderer.removeListener('remote:renameSession', handler);
		},

		/**
		 * Send response for remote rename session
		 */
		sendRemoteRenameSessionResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote update session cwd from CLI/web.
		 * Uses request-response pattern with a unique responseChannel; the
		 * renderer responds with { success, error? } so the caller can surface
		 * the reason a cwd change was refused (e.g. agent still running).
		 */
		onRemoteUpdateSessionCwd: (
			callback: (sessionId: string, newCwd: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, newCwd: string, responseChannel: string) =>
				callback(sessionId, newCwd, responseChannel);
			ipcRenderer.on('remote:updateSessionCwd', handler);
			return () => ipcRenderer.removeListener('remote:updateSessionCwd', handler);
		},

		/**
		 * Send response for remote update session cwd
		 */
		sendRemoteUpdateSessionCwdResponse: (
			responseChannel: string,
			result: { success: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote requests to update an agent's SSH execution config.
		 * The renderer merges the partial patch and responds with { success, error? }
		 * so the caller can surface why an update was refused (e.g. agent running).
		 */
		onRemoteUpdateSessionSsh: (
			callback: (
				sessionId: string,
				sshPatch: Record<string, unknown>,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				sshPatch: Record<string, unknown>,
				responseChannel: string
			) => callback(sessionId, sshPatch, responseChannel);
			ipcRenderer.on('remote:updateSessionSsh', handler);
			return () => ipcRenderer.removeListener('remote:updateSessionSsh', handler);
		},

		/**
		 * Send response for remote update session SSH config
		 */
		sendRemoteUpdateSessionSshResponse: (
			responseChannel: string,
			result: { success: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote requests to update an agent's editable per-session
		 * config (nudge/new-session message, custom path/args/env vars, model,
		 * effort, context window, Claude token source). The renderer merges the
		 * partial patch and responds with { success, error? }.
		 */
		onRemoteUpdateSessionConfig: (
			callback: (
				sessionId: string,
				configPatch: Record<string, unknown>,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				configPatch: Record<string, unknown>,
				responseChannel: string
			) => callback(sessionId, configPatch, responseChannel);
			ipcRenderer.on('remote:updateSessionConfig', handler);
			return () => ipcRenderer.removeListener('remote:updateSessionConfig', handler);
		},

		/**
		 * Send response for remote update session config
		 */
		sendRemoteUpdateSessionConfigResponse: (
			responseChannel: string,
			result: { success: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote create group from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteCreateGroup: (
			callback: (
				name: string,
				emoji: string | undefined,
				parentGroupId: string | undefined,
				icon: string | undefined,
				color: string | undefined,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				name: string,
				emoji: string | undefined,
				parentGroupId: string | undefined,
				icon: string | undefined,
				color: string | undefined,
				responseChannel: string
			) => {
				callback(name, emoji, parentGroupId, icon, color, responseChannel);
			};
			ipcRenderer.on('remote:createGroup', handler);
			return () => ipcRenderer.removeListener('remote:createGroup', handler);
		},

		/**
		 * Send response for remote create group. Echoes the persisted group
		 * appearance so the CLI can confirm icon/color were applied.
		 */
		sendRemoteCreateGroupResponse: (
			responseChannel: string,
			result: GroupAppearanceEcho | null
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote update group from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteUpdateGroup: (
			callback: (groupId: string, updates: UpdateGroupPayload, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				groupId: string,
				updates: UpdateGroupPayload,
				responseChannel: string
			) => {
				callback(groupId, updates, responseChannel);
			};
			ipcRenderer.on('remote:updateGroup', handler);
			return () => ipcRenderer.removeListener('remote:updateGroup', handler);
		},

		/**
		 * Send response for remote update group (persisted group echo, or null).
		 */
		sendRemoteUpdateGroupResponse: (
			responseChannel: string,
			result: GroupAppearanceEcho | null
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote rename group from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteRenameGroup: (
			callback: (groupId: string, name: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, groupId: string, name: string, responseChannel: string) =>
				callback(groupId, name, responseChannel);
			ipcRenderer.on('remote:renameGroup', handler);
			return () => ipcRenderer.removeListener('remote:renameGroup', handler);
		},

		/**
		 * Send response for remote rename group
		 */
		sendRemoteRenameGroupResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote delete group from web interface (fire-and-forget)
		 */
		onRemoteDeleteGroup: (callback: (groupId: string) => void): (() => void) => {
			const handler = (_: unknown, groupId: string) => callback(groupId);
			ipcRenderer.on('remote:deleteGroup', handler);
			return () => ipcRenderer.removeListener('remote:deleteGroup', handler);
		},

		/**
		 * Subscribe to remote move session to group from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteMoveSessionToGroup: (
			callback: (sessionId: string, groupId: string | null, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				groupId: string | null,
				responseChannel: string
			) => callback(sessionId, groupId, responseChannel);
			ipcRenderer.on('remote:moveSessionToGroup', handler);
			return () => ipcRenderer.removeListener('remote:moveSessionToGroup', handler);
		},

		/**
		 * Send response for remote move session to group
		 */
		sendRemoteMoveSessionToGroupResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote get git status from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteGetGitStatus: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, { branch: '', files: [], ahead: 0, behind: 0 });
					});
				} catch {
					ipcRenderer.send(responseChannel, { branch: '', files: [], ahead: 0, behind: 0 });
				}
			};
			ipcRenderer.on('remote:getGitStatus', handler);
			return () => ipcRenderer.removeListener('remote:getGitStatus', handler);
		},

		/**
		 * Send response for remote get git status
		 */
		sendRemoteGetGitStatusResponse: (responseChannel: string, result: any): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote get git diff from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteGetGitDiff: (
			callback: (sessionId: string, filePath: string | undefined, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				filePath: string | undefined,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, filePath, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, { diff: '', files: [] });
					});
				} catch {
					ipcRenderer.send(responseChannel, { diff: '', files: [] });
				}
			};
			ipcRenderer.on('remote:getGitDiff', handler);
			return () => ipcRenderer.removeListener('remote:getGitDiff', handler);
		},

		/**
		 * Send response for remote get git diff
		 */
		sendRemoteGetGitDiffResponse: (responseChannel: string, result: any): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote get group chats from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteGetGroupChats: (callback: (responseChannel: string) => void): (() => void) => {
			const handler = (_: unknown, responseChannel: string) => callback(responseChannel);
			ipcRenderer.on('remote:getGroupChats', handler);
			return () => ipcRenderer.removeListener('remote:getGroupChats', handler);
		},

		/**
		 * Send response for remote get group chats
		 */
		sendRemoteGetGroupChatsResponse: (responseChannel: string, result: any): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote start group chat from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteStartGroupChat: (
			callback: (topic: string, participantIds: string[], responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				topic: string,
				participantIds: string[],
				responseChannel: string
			) => callback(topic, participantIds, responseChannel);
			ipcRenderer.on('remote:startGroupChat', handler);
			return () => ipcRenderer.removeListener('remote:startGroupChat', handler);
		},

		/**
		 * Send response for remote start group chat
		 */
		sendRemoteStartGroupChatResponse: (
			responseChannel: string,
			result: { chatId: string } | null
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote get group chat state from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteGetGroupChatState: (
			callback: (chatId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, chatId: string, responseChannel: string) =>
				callback(chatId, responseChannel);
			ipcRenderer.on('remote:getGroupChatState', handler);
			return () => ipcRenderer.removeListener('remote:getGroupChatState', handler);
		},

		/**
		 * Send response for remote get group chat state
		 */
		sendRemoteGetGroupChatStateResponse: (responseChannel: string, result: any): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote stop group chat from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteStopGroupChat: (
			callback: (chatId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, chatId: string, responseChannel: string) =>
				callback(chatId, responseChannel);
			ipcRenderer.on('remote:stopGroupChat', handler);
			return () => ipcRenderer.removeListener('remote:stopGroupChat', handler);
		},

		/**
		 * Send response for remote stop group chat
		 */
		sendRemoteStopGroupChatResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote send group chat message from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteSendGroupChatMessage: (
			callback: (chatId: string, message: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, chatId: string, message: string, responseChannel: string) =>
				callback(chatId, message, responseChannel);
			ipcRenderer.on('remote:sendGroupChatMessage', handler);
			return () => ipcRenderer.removeListener('remote:sendGroupChatMessage', handler);
		},

		/**
		 * Send response for remote send group chat message
		 */
		sendRemoteSendGroupChatMessageResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote merge context from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteMergeContext: (
			callback: (sourceSessionId: string, targetSessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sourceSessionId: string,
				targetSessionId: string,
				responseChannel: string
			) => callback(sourceSessionId, targetSessionId, responseChannel);
			ipcRenderer.on('remote:mergeContext', handler);
			return () => ipcRenderer.removeListener('remote:mergeContext', handler);
		},

		/**
		 * Send response for remote merge context
		 */
		sendRemoteMergeContextResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote transfer context from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteTransferContext: (
			callback: (sourceSessionId: string, targetSessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sourceSessionId: string,
				targetSessionId: string,
				responseChannel: string
			) => callback(sourceSessionId, targetSessionId, responseChannel);
			ipcRenderer.on('remote:transferContext', handler);
			return () => ipcRenderer.removeListener('remote:transferContext', handler);
		},

		/**
		 * Send response for remote transfer context
		 */
		sendRemoteTransferContextResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote summarize context from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteSummarizeContext: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) =>
				callback(sessionId, responseChannel);
			ipcRenderer.on('remote:summarizeContext', handler);
			return () => ipcRenderer.removeListener('remote:summarizeContext', handler);
		},

		/**
		 * Send response for remote summarize context
		 */
		sendRemoteSummarizeContextResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote create-gist requests from the web/CLI interface.
		 * Uses request-response pattern with a unique responseChannel. Ack a
		 * structured failure before rethrowing synchronous callback errors so
		 * the CLI doesn't wait for the 60s response timeout.
		 */
		onRemoteCreateGist: (
			callback: (
				sessionId: string,
				description: string,
				isPublic: boolean,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				description: string,
				isPublic: boolean,
				responseChannel: string
			) => {
				try {
					callback(sessionId, description, isPublic, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			};
			ipcRenderer.on('remote:createGist', handler);
			return () => ipcRenderer.removeListener('remote:createGist', handler);
		},

		/**
		 * Send response for remote create-gist
		 */
		sendRemoteCreateGistResponse: (
			responseChannel: string,
			result: { success: boolean; gistUrl?: string; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Listen for remote trigger Cue subscription requests (from web/CLI clients)
		 */
		onRemoteTriggerCueSubscription: (
			callback: (
				subscriptionName: string,
				prompt: string | undefined,
				responseChannel: string,
				sourceAgentId: string | undefined
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				subscriptionName: string,
				prompt: string | undefined,
				responseChannel: string,
				sourceAgentId: string | undefined
			) => {
				try {
					Promise.resolve(callback(subscriptionName, prompt, responseChannel, sourceAgentId)).catch(
						(error) => {
							console.error('[Cue] Remote trigger callback failed:', error);
							ipcRenderer.send(responseChannel, false);
						}
					);
				} catch (error) {
					console.error('[Cue] Remote trigger callback threw:', error);
					ipcRenderer.send(responseChannel, false);
				}
			};
			ipcRenderer.on('remote:triggerCueSubscription', handler);
			return () => ipcRenderer.removeListener('remote:triggerCueSubscription', handler);
		},

		/**
		 * Send response for remote trigger Cue subscription
		 */
		sendRemoteTriggerCueSubscriptionResponse: (responseChannel: string, result: unknown): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to stderr from runCommand (separate stream)
		 */
		onStderr: (callback: (sessionId: string, data: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, data: string) => callback(sessionId, data);
			ipcRenderer.on('process:stderr', handler);
			return () => ipcRenderer.removeListener('process:stderr', handler);
		},

		/**
		 * Subscribe to command exit from runCommand (separate from PTY exit)
		 */
		onCommandExit: (callback: (sessionId: string, code: number) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, code: number) => callback(sessionId, code);
			ipcRenderer.on('process:command-exit', handler);
			return () => ipcRenderer.removeListener('process:command-exit', handler);
		},

		/**
		 * Subscribe to usage statistics from AI responses
		 */
		onUsage: (callback: (sessionId: string, usageStats: UsageStats) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, usageStats: UsageStats) =>
				callback(sessionId, usageStats);
			ipcRenderer.on('process:usage', handler);
			return () => ipcRenderer.removeListener('process:usage', handler);
		},

		/**
		 * Subscribe to agent error events (auth expired, token exhaustion, rate limits, etc.)
		 */
		onAgentError: (callback: (sessionId: string, error: AgentError) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, error: AgentError) =>
				callback(sessionId, error);
			ipcRenderer.on('agent:error', handler);
			return () => ipcRenderer.removeListener('agent:error', handler);
		},
	};
}

/**
 * TypeScript type for the process API
 */
export type ProcessApi = ReturnType<typeof createProcessApi>;
