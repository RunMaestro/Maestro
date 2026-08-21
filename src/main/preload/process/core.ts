import { ipcRenderer } from 'electron';
import type { UsageStats } from '../../../shared/types';
import type { ParsedQuestion } from '../../permission-relay/types';

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
 * Local desktop process lifecycle: spawn, write, resize, kill, and the
 * associated event listeners. Not web-interface related - see the sibling
 * `*Remote.ts` files for the `remote:*` channels forwarded from the web
 * client bridge.
 */
export function createProcessCoreApi() {
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
		 * Provider Failover: pin an agent to a backup endpoint's env vars (and its
		 * model, when the endpoint declares one), or pass `env: null` to return the
		 * agent to its primary provider. Main layers this over `sessionCustomEnvVars`
		 * for every subsequent spawn of this agent, so all spawn surfaces (interactive
		 * turn, Auto Run, Cue, tab naming) inherit the swap. Not persisted - agents
		 * come back on their primary after a restart.
		 */
		setFailoverOverlay: (
			sessionId: string,
			env: Record<string, string> | null,
			model?: string
		): Promise<void> => ipcRenderer.invoke('process:setFailoverOverlay', sessionId, env, model),

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
		 * Terminate an in-flight runCommand. Returns false when nothing is running
		 * under that sessionId (already exited, or never started).
		 */
		cancelCommand: (sessionId: string): Promise<boolean> =>
			ipcRenderer.invoke('process:cancelCommand', { sessionId }),

		/**
		 * Get all active processes from ProcessManager
		 */
		getActiveProcesses: (options?: {
			includeChildProcesses?: boolean;
		}): Promise<ActiveProcess[]> =>
			options === undefined
				? ipcRenderer.invoke('process:getActiveProcesses')
				: ipcRenderer.invoke('process:getActiveProcesses', options),

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
				// AskUserQuestion requests carry a parsed question payload; ordinary
				// permission requests omit both fields (unchanged shape).
				kind?: 'question';
				questions?: ParsedQuestion[];
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

		/**
		 * Subscribe to expired-credentials notices raised outside the agent
		 * streaming path - today, Cue pipeline runs, which spawn their agents
		 * directly and therefore never emit `agent:error`.
		 */
		onAuthExpired: (
			callback: (payload: {
				sessionId: string;
				agentId: string;
				message: string;
				fromPipeline?: boolean;
			}) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				payload: {
					sessionId: string;
					agentId: string;
					message: string;
					fromPipeline?: boolean;
				}
			) => callback(payload);
			ipcRenderer.on('agent:authExpired', handler);
			return () => ipcRenderer.removeListener('agent:authExpired', handler);
		},
	};
}
