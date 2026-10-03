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

import { captureException } from '../utils/sentry';
import type { AutoRunOwner, OrphanedAutoRun } from '../../shared/autoRunBroadcast';

export type { AutoRunOwner, OrphanedAutoRun };

export interface AutoRunTrackedState {
	isRunning: boolean;
	totalTasks?: number;
	completedTasks?: number;
	totalTasksAcrossAllDocs?: number;
	completedTasksAcrossAllDocs?: number;
	// The fields below decide whether an orphaned run may be resumed and how
	// much of it is left. They ride along on every broadcast frame already.
	isStopping?: boolean;
	errorPaused?: boolean;
	loopIteration?: number;
	goalIteration?: number;
}

export interface AutoRunFinalPayload {
	tasksCompleted?: number;
	tasksTotal?: number;
}

type FinalListener = (agentId: string, payload: AutoRunFinalPayload) => void;

export class AutoRunStateTracker {
	private states = new Map<string, AutoRunTrackedState>();
	/** agentId -> when the current running batch began. */
	private runningSince = new Map<string, number>();
	/** Claims that have not yet been promoted by a renderer state broadcast. */
	private provisionalStarts = new Set<string>();
	/** agentId -> the client that started the current run. */
	private owners = new Map<string, AutoRunOwner>();
	/**
	 * Orphaned runs handed back to their owner but not yet restarted. The run
	 * stays `isRunning` meanwhile so no other client can start over it while the
	 * owner waits for the orphaned task to finish.
	 */
	private pendingReclaims = new Map<string, string>();
	/**
	 * Restarted orphans whose first broadcast has not landed yet, with the state
	 * the dead loop last published. Releasing one of these still ends a run that
	 * really happened, so it has to produce the finality edge.
	 */
	private reclaimedStarts = new Map<string, AutoRunTrackedState | undefined>();
	private listeners = new Set<FinalListener>();

	/**
	 * Record the latest Auto Run state for an agent. `null` means "no Auto Run"
	 * (batch finished or was cleared) and produces the finality edge when the
	 * agent was previously running.
	 */
	update(agentId: string, state: AutoRunTrackedState | null): void {
		const previous = this.states.get(agentId);
		const wasRunning = previous?.isRunning === true;
		const wasProvisional = this.provisionalStarts.delete(agentId);
		this.reclaimedStarts.delete(agentId);
		// A frame for a run handed back to its owner means the loop it was taken
		// from is still alive (a duplicated browser tab inherits its parent's id).
		// The live loop keeps the run; the reclaim is cancelled, so the restart
		// fails its claim instead of starting a second loop.
		this.pendingReclaims.delete(agentId);

		if (!state) {
			this.states.delete(agentId);
			this.runningSince.delete(agentId);
			this.forgetOwnership(agentId);
			if (wasRunning && !wasProvisional) this.emitFinal(agentId, previous);
			return;
		}

		this.states.set(agentId, state);
		if (state.isRunning) {
			if (!wasRunning) this.runningSince.set(agentId, Date.now());
		} else {
			this.runningSince.delete(agentId);
			this.forgetOwnership(agentId);
		}
		if (wasRunning && !state.isRunning && !wasProvisional) this.emitFinal(agentId, state);
	}

	/** True while a batch is running for this agent. */
	isRunning(agentId: string): boolean {
		return this.states.get(agentId)?.isRunning === true;
	}

	/**
	 * Atomically reserve an agent for a new Auto Run.
	 *
	 * Every renderer shares this main-process tracker, so unlike a renderer-local
	 * store check this serializes near-simultaneous starts from desktop and browser
	 * clients. The first real state broadcast replaces the provisional state.
	 *
	 * `owner` records who started the run so a reload can hand it back. The one
	 * claim that succeeds over a running agent is the owner restarting a run it
	 * reclaimed with {@link takeOrphanedRuns}; it keeps the original start time,
	 * because dispatch callbacks correlate against it.
	 */
	tryClaimStart(agentId: string, owner?: AutoRunOwner): boolean {
		const reclaimedBy = this.pendingReclaims.get(agentId);
		if (reclaimedBy !== undefined) {
			if (owner?.instanceId !== reclaimedBy) return false;
			this.pendingReclaims.delete(agentId);
			this.reclaimedStarts.set(agentId, this.lastPublishedState(agentId));
			this.states.set(agentId, { isRunning: true });
			if (!this.runningSince.has(agentId)) this.runningSince.set(agentId, Date.now());
			this.provisionalStarts.add(agentId);
			this.owners.set(agentId, owner);
			return true;
		}
		if (this.isRunning(agentId)) return false;
		this.states.set(agentId, { isRunning: true });
		this.runningSince.set(agentId, Date.now());
		this.provisionalStarts.add(agentId);
		if (owner) this.owners.set(agentId, owner);
		return true;
	}

	/**
	 * Release a claim when preparation fails before the renderer publishes its
	 * first real running state. Once promoted, a stale rollback cannot clear the
	 * active batch.
	 */
	releaseStartClaim(agentId: string): boolean {
		if (!this.provisionalStarts.delete(agentId)) return false;
		const wasReclaimed = this.reclaimedStarts.has(agentId);
		const reclaimedState = this.reclaimedStarts.get(agentId);
		this.reclaimedStarts.delete(agentId);
		this.states.delete(agentId);
		this.runningSince.delete(agentId);
		this.forgetOwnership(agentId);
		// A restarted orphan that found nothing left to do still ends a real run.
		if (wasReclaimed) this.emitFinal(agentId, reclaimedState);
		return true;
	}

	/**
	 * Hand a reloaded client back every run it owned that is still marked
	 * running.
	 *
	 * Only the owner can ask, and only for its own runs, which is what keeps this
	 * from double-spawning: the caller proves it is the same browser tab (or
	 * desktop window) by presenting the same instance id, and a page that has
	 * reloaded has no loop left running. A run started by any other client is
	 * never returned, however orphaned it looks from here.
	 *
	 * Each run returned is held for its owner until it restarts it
	 * ({@link tryClaimStart}) or gives it up ({@link abandonReclaim}). Asking
	 * again returns it again, so a second reload before the restart loses
	 * nothing.
	 */
	takeOrphanedRuns(instanceId: string): OrphanedAutoRun<AutoRunTrackedState>[] {
		const runs: OrphanedAutoRun<AutoRunTrackedState>[] = [];
		for (const [agentId, owner] of this.owners) {
			if (owner.instanceId !== instanceId) continue;
			// A claim still being prepared belonged to the page that just went away;
			// it never published a run, so there is nothing to resume.
			if (this.provisionalStarts.has(agentId) && !this.reclaimedStarts.has(agentId)) continue;
			if (!this.isRunning(agentId)) continue;
			this.pendingReclaims.set(agentId, instanceId);
			runs.push({
				agentId,
				config: owner.config,
				folderPath: owner.folderPath,
				state: this.lastPublishedState(agentId),
			});
		}
		return runs;
	}

	/**
	 * The owner decided not to restart a reclaimed run (the user had asked it to
	 * stop, it was paused waiting on the user, or its agent is gone). End it here
	 * so the agent stops reading as busy and can be started again.
	 */
	abandonReclaim(agentId: string, instanceId: string): boolean {
		if (this.pendingReclaims.get(agentId) !== instanceId) return false;
		const previous = this.lastPublishedState(agentId);
		this.provisionalStarts.delete(agentId);
		this.reclaimedStarts.delete(agentId);
		this.states.delete(agentId);
		this.runningSince.delete(agentId);
		this.forgetOwnership(agentId);
		this.emitFinal(agentId, previous);
		return true;
	}

	/**
	 * When the current batch started, or `undefined` when none is running.
	 * Consumers that correlate against a specific turn (dispatch callbacks) need
	 * this to tell "the batch my dispatch just started" from "a batch that was
	 * already running in some other tab of the same agent".
	 */
	getRunningSince(agentId: string): number | undefined {
		return this.runningSince.get(agentId);
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
		this.runningSince.delete(agentId);
		this.provisionalStarts.delete(agentId);
		this.reclaimedStarts.delete(agentId);
		this.forgetOwnership(agentId);
	}

	/**
	 * The last state the run's loop actually published. A reclaimed run that was
	 * restarted and then orphaned again before its first broadcast holds only a
	 * provisional placeholder in `states`; the real one was set aside at restart.
	 */
	private lastPublishedState(agentId: string): AutoRunTrackedState | undefined {
		return this.reclaimedStarts.has(agentId)
			? this.reclaimedStarts.get(agentId)
			: this.states.get(agentId);
	}

	private forgetOwnership(agentId: string): void {
		this.owners.delete(agentId);
		this.pendingReclaims.delete(agentId);
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
			} catch (error) {
				// One bad listener must not break Auto Run state tracking for the
				// others, but the failure is a real bug - report it rather than
				// discarding it.
				void captureException(error instanceof Error ? error : new Error(String(error)), {
					extra: { area: 'autorun-state-tracker', hook: 'onFinal', agentId },
				});
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
