/**
 * Mirror the host renderer's Auto Run state into attached clients.
 *
 * The host owns the live loop, process queue, timing and error-resolution
 * promises. Browsers/Lite only render its autorun_state frames and dispatch
 * lifecycle controls back to that owner through useBatchProcessor.
 *
 * Frames never overwrite a live locally-owned run. Mirrored entries remain
 * marked as such so local runner internals cannot mistake them for ownership.
 */

import { useCallback, useEffect } from 'react';
import type { AutoRunBroadcastState } from '../../../shared/autoRunBroadcast';
import type { AgentErrorType } from '../../../shared/types';
import type { BatchRunState } from '../../types';
import { useBatchStore } from '../../stores/batchStore';
import { DEFAULT_BATCH_STATE } from './batchReducer';
import { isWebDesktop } from '../../utils/runtimeContext';

/**
 * Tooltip for an Auto Run control disabled because the run belongs to another
 * client. One string so every disabled control gives the same explanation - a
 * user seeing a greyed-out Stop needs to know WHY, or the mirror reads as a
 * broken UI rather than a deliberately read-only one.
 */
export const MIRRORED_RUN_CONTROL_TITLE =
	'This Auto Run is being driven by another Maestro window. Control it from the window that started it.';

/**
 * Build the mirrored `BatchRunState` for one broadcast frame.
 *
 * `previous` is the entry already on screen (also a mirror) so fields that only
 * ride along on some frames - and the local elapsed-time accumulation
 * `useTimeTracking` writes - survive a frame that omits them. Exported for
 * tests.
 */
export function buildMirroredBatchState(
	incoming: AutoRunBroadcastState,
	previous?: BatchRunState
): BatchRunState {
	const base = previous ?? DEFAULT_BATCH_STATE;
	const documents = incoming.documents ?? base.documents ?? [];

	return {
		...base,
		mirrored: true,
		isRunning: incoming.isRunning,
		isStopping: incoming.isStopping ?? false,

		documents,
		lockedDocuments: incoming.lockedDocuments ?? base.lockedDocuments ?? [],
		currentDocumentIndex: incoming.currentDocumentIndex ?? 0,
		currentDocTasksTotal: incoming.currentDocTasksTotal ?? 0,
		currentDocTasksCompleted: incoming.currentDocTasksCompleted ?? 0,

		totalTasks: incoming.totalTasks,
		completedTasks: incoming.completedTasks,
		currentTaskIndex: incoming.currentTaskIndex,
		totalTasksAcrossAllDocs: incoming.totalTasksAcrossAllDocs ?? 0,
		completedTasksAcrossAllDocs: incoming.completedTasksAcrossAllDocs ?? 0,

		loopEnabled: incoming.loopEnabled ?? false,
		loopIteration: incoming.loopIteration ?? 0,

		worktreeActive: incoming.worktreeActive ?? false,
		worktreeBranch: incoming.worktreeBranch,

		// The owner's clock, not ours. A run that started before this browser tab
		// connected must not read as having started when the tab opened, so fall
		// back to the previous mirror's value rather than to `Date.now()`.
		startTime: incoming.startTime ?? base.startTime,

		errorPaused: incoming.errorPaused ?? false,
		errorDocumentIndex: incoming.errorDocumentIndex,
		errorTaskDescription: incoming.errorTaskDescription,
		// The wire carries the error flattened to scalars, so rebuild just enough
		// of an AgentError for the banner to render. `agentId` is not broadcast;
		// the banner shows the message and the recoverable/abort choice, neither
		// of which reads it.
		error: incoming.errorMessage
			? {
					type: (incoming.errorType ?? 'unknown') as AgentErrorType,
					message: incoming.errorMessage,
					recoverable: incoming.errorRecoverable ?? false,
					agentId: '',
					timestamp: Date.now(),
				}
			: undefined,

		goalMode: incoming.goalMode,
		goalProgress: incoming.goalProgress,
		goalRationale: incoming.goalRationale,
		goalIteration: incoming.goalIteration,
	};
}

/**
 * Apply one broadcast frame to the batch store. Exported for tests.
 *
 * Ownership rule: a frame may only ever create or update a MIRRORED entry, and
 * it may only ever delete one. If this client is running its own Auto Run for
 * that agent, its entry is authoritative and the frame is discarded - the
 * owner's broadcasts come straight back to it over the same fanout, and letting
 * one land would overwrite the live run with a lossy projection of itself.
 *
 * Ownership is LIVENESS, not presence. `COMPLETE_BATCH` resets an entry in
 * place rather than deleting the key, so any client that has run Auto Run once
 * keeps a non-mirrored `isRunning: false` entry for that agent forever. Reading
 * that as ownership would make mirroring permanently dead for exactly the
 * agents the user has already used it on.
 */
export function applyAutoRunMirrorFrame(
	sessionId: string,
	incoming: AutoRunBroadcastState | null
): void {
	const { batchRunStates, setBatchRunStates } = useBatchStore.getState();
	const existing = batchRunStates[sessionId];
	const isMirror = existing?.mirrored === true;
	if (existing?.isRunning === true && !isMirror) return; // we own a live run

	// `null` (run cleared) and `isRunning: false` (run finished) both mean the
	// mirror should go away entirely rather than linger as a stopped run - a
	// stale card on a finished run is what made the previous behaviour hard to
	// trust. Only ever remove an entry we put there: a finished LOCAL run's
	// reset entry belongs to the reducer.
	if (!incoming || !incoming.isRunning) {
		if (!isMirror) return;
		setBatchRunStates((prev) => {
			const next = { ...prev };
			delete next[sessionId];
			return next;
		});
		return;
	}

	// Carry forward only a previous MIRROR. A finished local run's reset entry
	// is not this run's history and must not seed it.
	const mirrored = buildMirroredBatchState(incoming, isMirror ? existing : undefined);
	setBatchRunStates((prev) => ({ ...prev, [sessionId]: mirrored }));
	noteMirrorFrame(sessionId);
}

// ============================================================================
// Staleness
// ============================================================================

/**
 * How long a mirror may go without a frame before it is checked for staleness.
 *
 * The owner polls document progress every 20s while a task runs and broadcasts
 * on every tick whether or not the counts moved, so a live run is a ~20s
 * heartbeat. This window is many multiples of that, because the cost of the two
 * outcomes is very asymmetric: dropping a live mirror too eagerly puts the user
 * back where this fix found them (no card), while keeping a dead one leaves the
 * composer queueing into a run that will never drain.
 */
const MIRROR_STALE_AFTER_MS = 5 * 60_000;

/** How often to look for stale mirrors. */
const MIRROR_REAP_INTERVAL_MS = 60_000;

/** sessionId -> epoch ms of the last frame that kept its mirror alive. */
const lastFrameAt = new Map<string, number>();

function noteMirrorFrame(sessionId: string): void {
	lastFrameAt.set(sessionId, Date.now());
}

/**
 * Drop mirrors whose owner has gone silent AND has no Auto Run process left in
 * the main process.
 *
 * Nothing tells main that a renderer holding a live run went away: if the
 * desktop window reloads or a browser tab that owned a run is closed mid-run,
 * main keeps `isRunning: true` for that agent forever and replays it to every
 * client that connects afterwards. A mirroring client cannot clear that - Stop
 * is disabled by design and every mutator refuses a mirror - so the card would
 * stay up permanently, and `useInputProcessing` would keep queueing the user's
 * messages behind a run that is never going to finish.
 *
 * Silence alone is not proof: an Auto Run task can be slow, and an error/HITL
 * pause is deliberately silent with no live process while its owner waits for
 * user input. Paused mirrors are therefore never candidates. For other quiet
 * runs, the reaper asks main whether ANY `-batch-` process still exists for that
 * agent, and only drops the mirror when both signals agree. A failed probe is
 * "I could not find out" rather than "nothing is running", and drops nothing.
 * Exported for tests.
 *
 * This is deliberately a containment, not a liveness protocol. Deciding which
 * client may CLAIM an orphaned run needs a renderer-ownership primitive that
 * does not exist yet (see issue #1470); refusing to render one is safe without
 * it.
 */
export async function reapStaleMirrors(now: number = Date.now()): Promise<void> {
	const { batchRunStates } = useBatchStore.getState();
	const quiet = Object.entries(batchRunStates)
		.filter(
			([sessionId, state]) =>
				state.mirrored === true &&
				state.errorPaused !== true &&
				now - (lastFrameAt.get(sessionId) ?? 0) >= MIRROR_STALE_AFTER_MS
		)
		.map(([sessionId]) => ({ sessionId, lastSeen: lastFrameAt.get(sessionId) ?? 0 }));
	if (quiet.length === 0) return;

	let active: Array<{ sessionId?: unknown }>;
	try {
		active = await window.maestro.process.getActiveProcesses({ includeChildProcesses: false });
	} catch {
		return; // could not find out - leave every mirror alone
	}

	const agentsWithLiveBatch = new Set<string>();
	for (const entry of active ?? []) {
		const id = entry?.sessionId;
		if (typeof id !== 'string') continue;
		const batchAt = id.indexOf('-batch-');
		if (batchAt > 0) agentsWithLiveBatch.add(id.slice(0, batchAt));
	}

	const dead = quiet.filter(({ sessionId }) => !agentsWithLiveBatch.has(sessionId));
	if (dead.length === 0) return;

	useBatchStore.getState().setBatchRunStates((prev) => {
		const next = { ...prev };
		for (const { sessionId, lastSeen } of dead) {
			// Re-check under the current state: a frame may have landed while the
			// probe was in flight, which would have made this entry live again.
			if (
				next[sessionId]?.mirrored !== true ||
				next[sessionId]?.errorPaused === true ||
				lastFrameAt.get(sessionId) !== lastSeen ||
				now - lastSeen < MIRROR_STALE_AFTER_MS
			) {
				continue;
			}
			delete next[sessionId];
			lastFrameAt.delete(sessionId);
		}
		return next;
	});
}

/** Test-only: forget every recorded frame timestamp. */
export function resetMirrorFrameClock(): void {
	lastFrameAt.clear();
}

/** Subscribe to host state without taking ownership of its runner. */
export function useAutoRunStateMirror(): void {
	const handleFrame = useCallback((sessionId: string, state: AutoRunBroadcastState | null) => {
		applyAutoRunMirrorFrame(sessionId, state);
	}, []);

	useEffect(() => {
		const subscribe = window.maestro?.process?.onRemoteAutoRunStateMirror;
		if (!subscribe) return;
		return subscribe(handleFrame);
	}, [handleFrame]);

	useEffect(() => {
		const timer = setInterval(() => {
			void reapStaleMirrors();
		}, MIRROR_REAP_INTERVAL_MS);
		return () => clearInterval(timer);
	}, []);
}

/** Native mirrors stay read-only; web/Lite controls are dispatched to the owner. */
export function useIsMirroredBatchRun(sessionId: string | undefined): boolean {
	return useBatchStore(
		useCallback(
			(s) => !isWebDesktop() && s.batchRunStates[sessionId ?? '']?.mirrored === true,
			[sessionId]
		)
	);
}
