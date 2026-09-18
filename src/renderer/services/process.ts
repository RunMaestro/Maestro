/**
 * Process management service
 * Wraps IPC calls to main process for process operations
 */

import { createIpcMethod } from './ipcWrapper';
import { resolveLiveAiTurns, type LiveAiTurn } from '../utils/liveTurnReattach';
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

/**
 * What the MAIN process says is actually running for one agent's AI tabs.
 *
 * The renderer can briefly report an agent as idle before the process-exit
 * event has reconciled into session state, so anything deciding "is this agent
 * busy right now" has to ask main rather than trust the store. Spawning a turn
 * with an id main still owns replaces the live process and discards its
 * eventual response.
 *
 * Terminal tabs and Cue runs are excluded: neither occupies the agent's
 * sequential AI turn.
 *
 * On IPC failure every flag comes back `true` (and `probeFailed` is set) so
 * callers fail SAFE - unknown ownership must read as busy, never as idle.
 */
export interface SessionAiProcessState {
	/** Any AI turn is live for this agent, on any tab. */
	anyActive: boolean;
	/** A turn is live on the specific tab asked about. */
	targetTabActive: boolean;
	/** Earliest start time among the live turns, for the thinking pill. */
	earliestStartTime?: number;
	/** The probe itself failed; the flags above are the safe fallback. */
	probeFailed: boolean;
}

/**
 * How long the ownership probe may take before it is treated as failed.
 *
 * The probe sits on the SEND path, before the composer has drawn anything: the
 * user bubble, the composer clear, and the queued card are all written after it
 * resolves. On web-desktop it is a WebSocket round trip, and `BridgeClient`
 * parks an invoke in its pending map with no deadline of its own - only a
 * `close` event rejects it. iOS Safari suspends a backgrounded or locked socket
 * WITHOUT firing `close`, so the promise simply never settles and every Enter
 * produces no bubble, no card, and no error. A phone user reads that as a dead
 * Send button and presses it again, and again.
 *
 * A deadline converts that into the safe answer the `catch` below already
 * gives: unknown ownership reads as BUSY, so the message is queued, drawn, and
 * drained when the socket returns. Generous enough that a merely slow round
 * trip still gets a real answer.
 */
export const AI_PROCESS_PROBE_TIMEOUT_MS = 4000;

/**
 * Reject after `ms`, so a hung IPC round trip cannot outlive the caller.
 * Rejects rather than resolving a sentinel because `probeSessionAiProcesses`
 * already has exactly one place that decides what "I could not find out" means.
 */
function rejectAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout>;
	const promise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('probe timed out')), ms);
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

export async function probeSessionAiProcesses(
	sessionId: string,
	targetTabId?: string
): Promise<SessionAiProcessState> {
	const prefix = `${sessionId}-ai-`;
	const targetProcessSessionId = `${sessionId}-ai-${targetTabId || 'default'}`;

	const deadline = rejectAfter(AI_PROCESS_PROBE_TIMEOUT_MS);
	try {
		const active = await Promise.race([
			window.maestro.process.getActiveProcesses({
				includeChildProcesses: false,
			}),
			deadline.promise,
		]);
		const sessionAiProcesses = active.filter(
			(process) => !process.isTerminal && !process.isCueRun && process.sessionId.startsWith(prefix)
		);
		return {
			anyActive: sessionAiProcesses.length > 0,
			targetTabActive: sessionAiProcesses.some(
				(process) =>
					process.sessionId === targetProcessSessionId ||
					// Forced-parallel turns run under a `-fp-<n>` suffix on the same tab.
					process.sessionId.startsWith(`${targetProcessSessionId}-fp-`)
			),
			earliestStartTime: sessionAiProcesses.reduce<number | undefined>((earliest, process) => {
				if (process.startTime === undefined) return earliest;
				return earliest === undefined ? process.startTime : Math.min(earliest, process.startTime);
			}, undefined),
			probeFailed: false,
		};
	} catch {
		// Preserve the input when ownership is unknown: treating an IPC failure as
		// idle can retry a live process id and lose its response. A timeout lands
		// here too, and means the same thing - see AI_PROCESS_PROBE_TIMEOUT_MS.
		return { anyActive: true, targetTabActive: true, probeFailed: true };
	} finally {
		// Clear the timer on the happy path so a resolved probe does not leave a
		// pending `setTimeout` (and a rejected promise nobody is listening to)
		// behind on every keystroke-driven send.
		deadline.cancel();
	}
}

/**
 * Every AI turn the MAIN process is running right now, across all agents.
 *
 * The whole-table counterpart to {@link probeSessionAiProcesses}, which asks
 * about one agent: startup reconciliation needs the answer for every restored
 * agent at once, and one round trip beats one per session.
 *
 * Returns `null` when the probe itself fails. Callers reconcile idle state
 * against this, so an empty array would read as "nothing is running" and is the
 * wrong shape for "I could not find out" - the two must stay distinguishable.
 */
export async function fetchLiveAiTurns(): Promise<LiveAiTurn[] | null> {
	try {
		const active = await window.maestro.process.getActiveProcesses({
			includeChildProcesses: false,
		});
		return resolveLiveAiTurns(active);
	} catch {
		return null;
	}
}
