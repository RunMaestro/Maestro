/**
 * Main-process mirror of per-agent Auto Run state.
 *
 * Auto Run is renderer-owned state. Until now the only thing the main process
 * learned about it was `web:broadcastAutoRunState`, which forwards to the web
 * server and returns early when there is no web server - so with Live Mode off,
 * nothing in the main process could tell "the process exited and the agent is
 * done" from "the process exited and Auto Run is about to spawn task 4".
 *
 * This tracker is fed unconditionally from that same IPC handler, before the
 * web-server null check, and is the first-party signal main-process consumers
 * (dispatch callbacks today, Cue's agent.completed later) use for Auto Run
 * finality.
 *
 * Note on the running -> not-running edge: the renderer clears the state to
 * `null` when a batch ends (useBatchRunner's `broadcastAutoRunState(sessionId,
 * null)`), so `null` must be treated as "not running" and still produce the
 * edge. The web broadcaster's own transition detection only looks at the
 * non-null branch, which is why `autorun_complete` was unreliable there.
 */

export interface AutoRunTrackedState {
	isRunning: boolean;
	totalTasks?: number;
	completedTasks?: number;
	totalTasksAcrossAllDocs?: number;
	completedTasksAcrossAllDocs?: number;
}

export interface AutoRunFinalPayload {
	tasksCompleted?: number;
	tasksTotal?: number;
}

type FinalListener = (agentId: string, payload: AutoRunFinalPayload) => void;

export class AutoRunStateTracker {
	private states = new Map<string, AutoRunTrackedState>();
	private listeners = new Set<FinalListener>();

	/**
	 * Record the latest Auto Run state for an agent. `null` means "no Auto Run"
	 * (batch finished or was cleared) and produces the finality edge when the
	 * agent was previously running.
	 */
	update(agentId: string, state: AutoRunTrackedState | null): void {
		const previous = this.states.get(agentId);
		const wasRunning = previous?.isRunning === true;

		if (!state) {
			this.states.delete(agentId);
			if (wasRunning) this.emitFinal(agentId, previous);
			return;
		}

		this.states.set(agentId, state);
		if (wasRunning && !state.isRunning) this.emitFinal(agentId, state);
	}

	/** True while a batch is running for this agent. */
	isRunning(agentId: string): boolean {
		return this.states.get(agentId)?.isRunning === true;
	}

	getState(agentId: string): AutoRunTrackedState | undefined {
		return this.states.get(agentId);
	}

	/** Subscribe to the running -> not-running edge. Returns an unsubscribe fn. */
	onFinal(listener: FinalListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Forget an agent entirely (agent deleted). Does not emit an edge. */
	clear(agentId: string): void {
		this.states.delete(agentId);
	}

	private emitFinal(agentId: string, state: AutoRunTrackedState | undefined): void {
		const payload: AutoRunFinalPayload = {
			...(state?.completedTasksAcrossAllDocs !== undefined
				? { tasksCompleted: state.completedTasksAcrossAllDocs }
				: state?.completedTasks !== undefined
					? { tasksCompleted: state.completedTasks }
					: {}),
			...(state?.totalTasksAcrossAllDocs !== undefined
				? { tasksTotal: state.totalTasksAcrossAllDocs }
				: state?.totalTasks !== undefined
					? { tasksTotal: state.totalTasks }
					: {}),
		};
		for (const listener of this.listeners) {
			try {
				listener(agentId, payload);
			} catch {
				// Listener failures must never break Auto Run state tracking.
			}
		}
	}
}

let sharedTracker: AutoRunStateTracker | null = null;

/** Process-wide tracker. Created lazily so tests can use their own instance. */
export function getAutoRunStateTracker(): AutoRunStateTracker {
	if (!sharedTracker) sharedTracker = new AutoRunStateTracker();
	return sharedTracker;
}

/** Test-only reset. */
export function resetAutoRunStateTracker(): void {
	sharedTracker = null;
}
