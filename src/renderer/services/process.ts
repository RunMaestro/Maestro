/**
 * Process management service
 * Wraps IPC calls to main process for process operations
 */

import { createIpcMethod } from './ipcWrapper';
import type { ProcessConfig } from '../types';

export type { ProcessConfig } from '../types';

export interface ProcessDataHandler {
	(sessionId: string, data: string): void;
}

export interface ProcessExitHandler {
	(sessionId: string, code: number): void;
}

export interface ProcessSessionIdHandler {
	(sessionId: string, agentSessionId: string): void;
}

/**
 * Result from process spawn operation.
 * Includes SSH remote info when the agent is executed on a remote host.
 */
export interface ProcessSpawnResult {
	pid: number;
	success: boolean;
	sshRemote?: {
		id: string;
		name: string;
		host: string;
	};
}

export const processService = {
	/**
	 * Spawn a new process
	 */
	spawn: (config: ProcessConfig): Promise<ProcessSpawnResult> =>
		createIpcMethod({
			call: () => window.maestro.process.spawn(config),
			errorContext: 'Process spawn',
			rethrow: true,
		}),

	/**
	 * Write data to process stdin
	 */
	write: (sessionId: string, data: string): Promise<boolean> =>
		createIpcMethod({
			call: () => window.maestro.process.write(sessionId, data),
			errorContext: 'Process write',
			rethrow: true,
		}),

	/**
	 * Interrupt a process (send SIGINT/Ctrl+C)
	 */
	interrupt: (sessionId: string): Promise<boolean> =>
		createIpcMethod({
			call: () => window.maestro.process.interrupt(sessionId),
			errorContext: 'Process interrupt',
			rethrow: true,
		}),

	/**
	 * Kill a process
	 */
	kill: (sessionId: string): Promise<boolean> =>
		createIpcMethod({
			call: () => window.maestro.process.kill(sessionId),
			errorContext: 'Process kill',
			rethrow: true,
		}),

	/**
	 * Resize PTY terminal
	 */
	resize: (sessionId: string, cols: number, rows: number): Promise<boolean> =>
		createIpcMethod({
			call: () => window.maestro.process.resize(sessionId, cols, rows),
			errorContext: 'Process resize',
			rethrow: true,
		}),

	/**
	 * Register handler for process data events
	 */
	onData(handler: ProcessDataHandler): () => void {
		return window.maestro.process.onData(handler);
	},

	/**
	 * Register handler for process exit events
	 */
	onExit(handler: ProcessExitHandler): () => void {
		return window.maestro.process.onExit(handler);
	},

	/**
	 * Register handler for session-id events (batch mode)
	 */
	onSessionId(handler: ProcessSessionIdHandler): () => void {
		return window.maestro.process.onSessionId(handler);
	},

	/**
	 * Register handler for tool execution events (OpenCode, Codex)
	 */
	onToolExecution(
		handler: (
			sessionId: string,
			toolEvent: { toolName: string; state?: unknown; timestamp: number }
		) => void
	): () => void {
		return window.maestro.process.onToolExecution(handler);
	},
};
