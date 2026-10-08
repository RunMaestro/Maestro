/**
 * Launch arbitration for desktop-owned Goal-Driven Auto Runs started from the
 * CLI (`maestro-cli goal-run --visible`).
 *
 * Lives outside the React listener so both halves are unit-testable without a
 * renderer, and because the two problems it solves are timing problems rather
 * than UI ones:
 *
 *  1. **Reservation.** `startBatchRun` does not mark the agent running
 *     synchronously - the goal runner awaits the `autorun-goal` prompt template
 *     and a git status read before it dispatches `START_BATCH`. Two `--visible`
 *     launches racing at the same agent would therefore both observe an idle
 *     batch store and both proceed. `reserveGoalRunLaunch` closes that window
 *     with a synchronous claim taken before the first await.
 *
 *  2. **Confirmation.** `startGoalRun` returns early - and silently, with only a
 *     toast - when the Auto Run kill switch is on, the session has vanished, or
 *     the prompt template fails to load. Replying "launched" the moment the call
 *     is made would hand the CLI a success for a run that never started, so the
 *     bridge waits for the batch store to actually report the run running.
 */

import { useBatchStore } from '../../stores/batchStore';

/**
 * Agents with a `--visible` launch between its synchronous claim and the batch
 * store reporting it running. Module-level rather than a store slice because it
 * is bridge bookkeeping, not UI state: nothing renders from it.
 */
const launchesInFlight = new Set<string>();

/** True if the batch store currently reports an active run for this agent. */
export function isBatchRunning(sessionId: string): boolean {
	return Boolean(useBatchStore.getState().batchRunStates[sessionId]?.isRunning);
}

/**
 * Synchronously claim an agent for a visible goal run. Returns false when the
 * agent already has a run going or another launch is mid-flight; the caller
 * should reject with `AGENT_BUSY` and must NOT release a claim it did not take.
 */
export function reserveGoalRunLaunch(sessionId: string): boolean {
	if (launchesInFlight.has(sessionId) || isBatchRunning(sessionId)) return false;
	launchesInFlight.add(sessionId);
	return true;
}

/** Release a claim taken by `reserveGoalRunLaunch`. Safe to call twice. */
export function releaseGoalRunLaunch(sessionId: string): void {
	launchesInFlight.delete(sessionId);
}

/** Test seam - drops every outstanding claim. */
export function clearGoalRunLaunches(): void {
	launchesInFlight.clear();
}

/**
 * Resolve true once the agent's run is actually running, false if it ended or
 * never started.
 *
 * `runPromise` is the value returned by `startBatchRun`, which for goal mode
 * settles when the whole run ENDS - so losing this race means "bailed during
 * startup", not "finished". Either way the store is re-read rather than assumed,
 * because a very short run could legitimately complete before we observe it.
 */
export function waitForGoalRunStart(
	sessionId: string,
	runPromise: Promise<void>,
	options: { timeoutMs?: number } = {}
): Promise<boolean> {
	const { timeoutMs = 15000 } = options;
	if (isBatchRunning(sessionId)) return Promise.resolve(true);

	return new Promise<boolean>((resolve) => {
		let settled = false;
		let unsubscribe: () => void = () => {};
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			unsubscribe();
			resolve(value);
		};
		// Arm the timeout before subscribing: a store update delivered
		// synchronously would otherwise run `finish` while `timeoutId` is still in
		// its temporal dead zone and throw a ReferenceError out of the listener.
		const timeoutId = setTimeout(() => finish(isBatchRunning(sessionId)), timeoutMs);
		unsubscribe = useBatchStore.subscribe(() => {
			if (isBatchRunning(sessionId)) finish(true);
		});
		// A rejection is a genuine startup failure; a resolution this early means
		// the runner returned without ever starting.
		runPromise.then(
			() => finish(isBatchRunning(sessionId)),
			() => finish(false)
		);
	});
}
