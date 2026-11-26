/**
 * Ending an Auto Run whose turn never settles.
 *
 * Both runners (the document loop and the goal loop) await each task's turn through the spawn,
 * and the spawn settles on the turn process's exit. When that never happens (the exit was missed,
 * or the spawn is still waiting on a queue that never drains), the loop hangs inside the await:
 * a stop request is only read at the next iteration boundary, so `stop-auto-run` and
 * `abort-auto-run` answered success and the run stayed "stopping" until the agent was removed.
 *
 * Every Auto Run spawn and goal handoff synopsis therefore runs inside an abort scope keyed by the
 * agent. A force-end (`killBatchRun`: the Force Kill button, a second `stop-auto-run` or an
 * `abort-auto-run` on a run already stopping) aborts the scope, the await settles at once as a
 * failed turn, and the loop reaches its stop check and its cleanup.
 */

import type { AutoRunSpawnAgentFn } from '../useDocumentProcessor';

/** What an aborted turn reports. */
export const AUTO_RUN_TURN_ABORTED = 'Auto Run was force-stopped while this turn was running';

const scopes = new Map<string, Set<AbortController>>();

/**
 * Settle with `onAbort()` as soon as `abortAutoRunTurns(sessionId)` runs, or with `work` if it
 * settles first. The signal is handed to `work` so it can release what it holds.
 */
export function untilAutoRunTurnAborted<T>(
	sessionId: string,
	work: (signal: AbortSignal) => Promise<T>,
	onAbort: () => T
): Promise<T> {
	const controller = new AbortController();
	let set = scopes.get(sessionId);
	if (!set) {
		set = new Set();
		scopes.set(sessionId, set);
	}
	set.add(controller);
	const release = () => {
		const current = scopes.get(sessionId);
		current?.delete(controller);
		if (current && current.size === 0) scopes.delete(sessionId);
	};
	const aborted = new Promise<T>((resolve) => {
		controller.signal.addEventListener('abort', () => resolve(onAbort()), { once: true });
	});
	return Promise.race([work(controller.signal), aborted]).finally(release);
}

/** End every Auto Run turn of this agent that is still awaited. Returns how many it ended. */
export function abortAutoRunTurns(sessionId: string): number {
	const set = scopes.get(sessionId);
	if (!set) return 0;
	scopes.delete(sessionId);
	for (const controller of set) controller.abort();
	return set.size;
}

/** An Auto Run spawn whose wait `abortAutoRunTurns()` can end. Both runners spawn through it. */
export function abortableAutoRunSpawn(spawn: AutoRunSpawnAgentFn): AutoRunSpawnAgentFn {
	return (sessionId, prompt, cwdOverride, turnSettings) =>
		untilAutoRunTurnAborted<Awaited<ReturnType<AutoRunSpawnAgentFn>>>(
			sessionId,
			(abortSignal) => spawn(sessionId, prompt, cwdOverride, { ...turnSettings, abortSignal }),
			() => ({ success: false, error: AUTO_RUN_TURN_ABORTED })
		);
}
