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
}

/**
 * Usage statistics from AI responses
 */
export interface UsageStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	contextWindow: number;
	reasoningTokens?: number; // Separate reasoning tokens (Codex o3/o4-mini)
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
		 * Write data to a process stdin
		 */
		write: (sessionId: string, data: string): Promise<boolean> =>
			ipcRenderer.invoke('process:write', sessionId, data),

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

		// Event listeners

		/**
		 * Subscribe to process data output
		 */
		onData: (callback: (sessionId: string, data: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, data: string) => callback(sessionId, data);
			ipcRenderer.on('process:data', handler);
			return () => ipcRenderer.removeListener('process:data', handler);
		},

		/**
		 * Subscribe to process exit events
		 */
		onExit: (callback: (sessionId: string, code: number) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, code: number) => callback(sessionId, code);
			ipcRenderer.on('process:exit', handler);
			return () => ipcRenderer.removeListener('process:exit', handler);
		},

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
		 * Subscribe to remote command execution from web interface
		 * This allows web commands to go through the same code path as desktop commands
		 * inputMode is optional - if provided, renderer should use it instead of session state
		 */
		onRemoteCommand: (
			callback: (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => void
		): (() => void) => {
			log('Registering onRemoteCommand listener');
			const handler = (
				_: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal'
			) => {
				log('Received remote:executeCommand IPC', {
					sessionId,
					commandPreview: command?.substring(0, 50),
					inputMode,
				});
				try {
					callback(sessionId, command, inputMode);
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
