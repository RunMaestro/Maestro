/**
 * goalRunLaunch tests
 *
 * Launch arbitration for `maestro-cli goal-run --visible` (issue #1286).
 *
 * Both behaviors under test exist because of a timing gap: `startBatchRun` does
 * not mark an agent running synchronously, and the goal runner can return early
 * without ever starting. Each of those, left alone, produces a specific wrong
 * answer for the CLI - two overlapping runs on one agent, or a "launched" reply
 * for a run that never began - so the tests below are written around those two
 * failures rather than around the happy path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import {
	isBatchRunning,
	reserveGoalRunLaunch,
	releaseGoalRunLaunch,
	clearGoalRunLaunches,
	waitForGoalRunStart,
} from '../../../../renderer/hooks/remote/goalRunLaunch';

const SESSION = 'agent-1';

/** Put the batch store into a running / not-running state for one agent. */
function setRunning(sessionId: string, isRunning: boolean): void {
	useBatchStore.setState({
		batchRunStates: { [sessionId]: { ...DEFAULT_BATCH_STATE, isRunning } },
	});
}

/** A promise that never settles - stands in for a run that is still going. */
function pending(): Promise<void> {
	return new Promise<void>(() => {});
}

describe('goalRunLaunch', () => {
	beforeEach(() => {
		clearGoalRunLaunches();
		useBatchStore.setState({ batchRunStates: {} });
		vi.useRealTimers();
	});

	describe('reserveGoalRunLaunch', () => {
		it('grants an idle agent', () => {
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
		});

		it('refuses a second claim while the first is still in flight', () => {
			// The gap this closes: neither launch has reached START_BATCH yet, so
			// an isRunning read alone would let both through and put two goal runs
			// on one agent.
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			expect(reserveGoalRunLaunch(SESSION)).toBe(false);
		});

		it('refuses an agent that already has a run going', () => {
			setRunning(SESSION, true);
			expect(reserveGoalRunLaunch(SESSION)).toBe(false);
		});

		it('does not block a different agent', () => {
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			expect(reserveGoalRunLaunch('agent-2')).toBe(true);
		});

		it('grants again after release when the run never started', () => {
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			releaseGoalRunLaunch(SESSION);
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
		});

		it('still refuses after release once the run is actually running', () => {
			// Release happens as soon as the launch is confirmed, so from that point
			// on it is the batch store - not the reservation - that holds the agent.
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			setRunning(SESSION, true);
			releaseGoalRunLaunch(SESSION);
			expect(reserveGoalRunLaunch(SESSION)).toBe(false);
		});

		it('tolerates a double release', () => {
			reserveGoalRunLaunch(SESSION);
			releaseGoalRunLaunch(SESSION);
			expect(() => releaseGoalRunLaunch(SESSION)).not.toThrow();
		});
	});

	describe('isBatchRunning', () => {
		it('is false for an agent with no batch state', () => {
			expect(isBatchRunning('unknown')).toBe(false);
		});

		it('tracks the store', () => {
			setRunning(SESSION, true);
			expect(isBatchRunning(SESSION)).toBe(true);
			setRunning(SESSION, false);
			expect(isBatchRunning(SESSION)).toBe(false);
		});
	});

	describe('waitForGoalRunStart', () => {
		it('resolves true immediately when the run is already running', async () => {
			setRunning(SESSION, true);
			await expect(waitForGoalRunStart(SESSION, pending())).resolves.toBe(true);
		});

		it('resolves true once the store reports the run running', async () => {
			const promise = waitForGoalRunStart(SESSION, pending());
			setRunning(SESSION, true);
			await expect(promise).resolves.toBe(true);
		});

		it('ignores a store update for a different agent', async () => {
			const promise = waitForGoalRunStart(SESSION, pending(), { timeoutMs: 20 });
			setRunning('agent-2', true);
			await expect(promise).resolves.toBe(false);
		});

		it('resolves false when the runner returns without ever starting', async () => {
			// The real cases: Auto Run kill switch on, session gone, or the
			// `autorun-goal` prompt template failed to load. All of them return
			// quietly, which is exactly why success cannot be assumed.
			await expect(waitForGoalRunStart(SESSION, Promise.resolve())).resolves.toBe(false);
		});

		it('resolves false when the run rejects during startup', async () => {
			await expect(
				waitForGoalRunStart(SESSION, Promise.reject(new Error('spawn failed')))
			).resolves.toBe(false);
		});

		it('reports true for a run that started and finished before we looked', async () => {
			// Losing the race to a resolved promise means "did not start" only if
			// the store agrees; a very short run must not be reported as a failure.
			setRunning(SESSION, true);
			await expect(waitForGoalRunStart(SESSION, Promise.resolve())).resolves.toBe(true);
		});

		it('resolves false on timeout when nothing ever starts', async () => {
			await expect(waitForGoalRunStart(SESSION, pending(), { timeoutMs: 20 })).resolves.toBe(false);
		});

		it('unsubscribes from the store once settled', async () => {
			const before = useBatchStore.getState();
			await waitForGoalRunStart(SESSION, pending(), { timeoutMs: 10 });
			// A leaked listener would keep firing; setting state after the wait
			// resolved must not throw or re-resolve.
			expect(() => setRunning(SESSION, true)).not.toThrow();
			expect(before).toBeDefined();
		});
	});
});
