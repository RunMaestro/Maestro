/**
 * Tests for the Goal-Driven exit evaluator.
 *
 * @file src/shared/goalDriven/goalExitEvaluator.ts
 */

import { describe, it, expect } from 'vitest';
import {
	GOAL_STALL_FLAT_LIMIT,
	evaluateGoalExit,
	resolveGoalIterationProgress,
	summarizeGoalLoops,
} from '../../../shared/goalDriven/goalExitEvaluator';
import { STALL_THRESHOLD } from '../../../shared/goalDriven/types';
import type { GoalIterationRecord, GoalRunConfig } from '../../../shared/goalDriven/types';

// Local factory keeps each record construction terse. `progress` accepts
// `number | null` so we can exercise the evaluator's defensive missing-progress
// handling; it is stored on the (number-typed) record field via assertion.
function rec(
	iteration: number,
	progress: number | null,
	extra: Partial<GoalIterationRecord> = {}
): GoalIterationRecord {
	return {
		iteration,
		progress: progress as number,
		rationale: null,
		complete: false,
		deadlock: false,
		deadlockReason: null,
		...extra,
	};
}

const config = (overrides: Partial<GoalRunConfig> = {}): GoalRunConfig => ({
	goal: 'Ship the feature',
	exitCriteria: 'All acceptance tests pass.',
	maxIterations: null,
	...overrides,
});

describe('evaluateGoalExit', () => {
	describe('empty / healthy histories', () => {
		it('continues when there is no history yet', () => {
			expect(evaluateGoalExit([], config())).toEqual({ action: 'continue' });
		});

		it('continues for a healthy climbing sequence (0 -> 30 -> 60)', () => {
			const history = [rec(1, 0), rec(2, 30), rec(3, 60)];
			expect(evaluateGoalExit(history, config())).toEqual({ action: 'continue' });
		});
	});

	describe('completion', () => {
		it('stops with reason completed when the latest record is complete', () => {
			const history = [rec(1, 60), rec(2, 100, { complete: true })];
			const decision = evaluateGoalExit(history, config());
			expect(decision).toEqual({
				action: 'stop',
				reason: 'completed',
				detail: expect.stringContaining('complete'),
			});
		});

		it('stops with reason completed when latest progress is exactly 100', () => {
			const history = [rec(1, 80), rec(2, 100)];
			const decision = evaluateGoalExit(history, config());
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('completed');
			}
		});

		it('completion beats max-iterations when both would trigger', () => {
			// 2 records and a cap of 2 -> max-iterations would fire, but the latest
			// record also completes, so completion must win.
			const history = [rec(1, 70), rec(2, 100, { complete: true })];
			const decision = evaluateGoalExit(history, config({ maxIterations: 2 }));
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('completed');
			}
		});
	});

	describe('deadlock', () => {
		it('stops with reason deadlock and propagates the reason into detail', () => {
			const history = [
				rec(1, 40),
				rec(2, 40, { deadlock: true, rationale: 'upstream API is undocumented' }),
			];
			const decision = evaluateGoalExit(history, config());
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('deadlock');
				expect(decision.detail).toContain('upstream API is undocumented');
			}
		});

		it('stops with reason deadlock even without a stated reason', () => {
			const history = [rec(1, 40), rec(2, 40, { deadlock: true })];
			const decision = evaluateGoalExit(history, config());
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('deadlock');
			}
		});

		it('prefers the deadlock-marker reason over the progress rationale', () => {
			// The agent put a throwaway note in its progress rationale but the real
			// blocker in the deadlock marker; the detail must surface the latter.
			const history = [
				rec(1, 40),
				rec(2, 40, {
					deadlock: true,
					rationale: 'still investigating',
					deadlockReason: 'no write access to the production database',
				}),
			];
			const decision = evaluateGoalExit(history, config());
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('deadlock');
				expect(decision.detail).toContain('no write access to the production database');
				expect(decision.detail).not.toContain('still investigating');
			}
		});

		it('deadlock beats max-iterations and stall', () => {
			// Flat 50/50/50 would stall, and the cap of 3 would also trigger, but
			// the latest record declares a deadlock which has higher priority.
			const history = [
				rec(1, 50),
				rec(2, 50),
				rec(3, 50, { deadlock: true, rationale: 'circular dependency' }),
			];
			const decision = evaluateGoalExit(history, config({ maxIterations: 3 }));
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('deadlock');
			}
		});
	});

	describe('max iterations', () => {
		it('stops with reason max-iterations when a finite cap is reached', () => {
			const history = [rec(1, 20), rec(2, 40), rec(3, 60)];
			const decision = evaluateGoalExit(history, config({ maxIterations: 3 }));
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('max-iterations');
				expect(decision.detail).toContain('3');
			}
		});

		it('continues when below a finite cap', () => {
			const history = [rec(1, 20), rec(2, 40)];
			expect(evaluateGoalExit(history, config({ maxIterations: 5 }))).toEqual({
				action: 'continue',
			});
		});

		it('never triggers max-iterations when the cap is null (infinite)', () => {
			const history = Array.from({ length: 50 }, (_, i) => rec(i + 1, Math.min(99, i * 5)));
			const decision = evaluateGoalExit(history, config({ maxIterations: null }));
			// 50 climbing-then-flat iterations: not completed, not deadlocked, no cap.
			// (May stall once it plateaus, but it must NOT be max-iterations.)
			if (decision.action === 'stop') {
				expect(decision.reason).not.toBe('max-iterations');
			}
		});
	});

	describe('stall detection', () => {
		it('stops with reason stalled after exactly STALL_THRESHOLD flat iterations', () => {
			const history = Array.from({ length: STALL_THRESHOLD }, (_, i) => rec(i + 1, 50));
			const decision = evaluateGoalExit(history, config());
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('stalled');
				expect(decision.detail).toContain('50%');
			}
		});

		it('stalls on a declining window as well as a flat one', () => {
			const history = [rec(1, 70), rec(2, 65), rec(3, 60)];
			const decision = evaluateGoalExit(history, config());
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('stalled');
			}
		});

		it('does not stall with fewer than STALL_THRESHOLD records', () => {
			const history = [rec(1, 50), rec(2, 50)];
			expect(evaluateGoalExit(history, config())).toEqual({ action: 'continue' });
		});

		it('resets the stall when there is an upward tick inside the window', () => {
			// Last 3 = [50, 50, 60] -> the final upward tick means not stalled.
			const history = [rec(1, 50), rec(2, 50), rec(3, 60)];
			expect(evaluateGoalExit(history, config())).toEqual({ action: 'continue' });
		});

		it('stalls only on the trailing window, ignoring earlier upward movement', () => {
			// Climbed 10 -> 40, then stuck at 40 for the last STALL_THRESHOLD records.
			const history = [rec(1, 10), rec(2, 40), rec(3, 40), rec(4, 40)];
			const decision = evaluateGoalExit(history, config());
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('stalled');
				expect(decision.detail).toContain('40%');
			}
		});

		it('treats missing-progress (null) iterations as no-progress for stall', () => {
			// Reached 50, then two silent iterations (no progress marker -> null).
			// Defensive normalization carries 50 forward, so the window is flat.
			const history = [rec(1, 50), rec(2, null), rec(3, null)];
			const decision = evaluateGoalExit(history, config());
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('stalled');
				expect(decision.detail).toContain('50%');
			}
		});
	});

	describe('priority ordering', () => {
		it('checks completion before deadlock before max-iterations before stall', () => {
			// A single record that simultaneously completes AND deadlocks AND hits a
			// cap of 1 -> completion wins.
			const history = [rec(1, 100, { complete: true, deadlock: true })];
			const decision = evaluateGoalExit(history, config({ maxIterations: 1 }));
			expect(decision.action).toBe('stop');
			if (decision.action === 'stop') {
				expect(decision.reason).toBe('completed');
			}
		});
	});
});

describe('resolveGoalIterationProgress', () => {
	it('keeps the reported value at full precision and rounds only the display', () => {
		expect(resolveGoalIterationProgress({ exactProgress: 48.35 }, [], 0)).toEqual({
			reported: 48.35,
			display: 48,
		});
	});

	it('carries the previous raw value forward when no marker was reported', () => {
		expect(resolveGoalIterationProgress({ exactProgress: null }, [rec(1, 48.27)], 48)).toEqual({
			reported: 48.27,
			display: 48,
		});
		expect(resolveGoalIterationProgress({ exactProgress: null }, [], 0)).toEqual({
			reported: 0,
			display: 0,
		});
	});

	it('never lets the display slide backward on a dip', () => {
		expect(resolveGoalIterationProgress({ exactProgress: 35 }, [rec(1, 55)], 55)).toEqual({
			reported: 35,
			display: 55,
		});
	});
});

describe('evaluateGoalExit with fractional progress', () => {
	it('does not stall when every iteration rounds to the same whole percent but climbs', () => {
		const history = [rec(1, 48.27), rec(2, 48.29), rec(3, 48.31)];
		expect(evaluateGoalExit(history, config()).action).toBe('continue');
	});
});

describe('summarizeGoalLoops', () => {
	it('reports no delta and no streak before any loop finishes', () => {
		expect(summarizeGoalLoops([], 10, 0)).toEqual({
			maxIterations: 10,
			lastDelta: null,
			flatStreak: 0,
			flatLimit: GOAL_STALL_FLAT_LIMIT,
			completedActiveMs: 0,
		});
	});

	it('measures the first loop against a 0% start', () => {
		const stats = summarizeGoalLoops([rec(1, 12)], null, 60_000);
		expect(stats.lastDelta).toBe(12);
		expect(stats.flatStreak).toBe(0);
		expect(stats.maxIterations).toBeNull();
		expect(stats.completedActiveMs).toBe(60_000);
	});

	it('reports the raw gain of the last loop, including a dip', () => {
		expect(summarizeGoalLoops([rec(1, 30), rec(2, 36)], null, 0).lastDelta).toBe(6);
		expect(summarizeGoalLoops([rec(1, 30), rec(2, 27)], null, 0).lastDelta).toBe(-3);
	});

	it('counts trailing loops that did not raise progress and resets on a rise', () => {
		expect(summarizeGoalLoops([rec(1, 10), rec(2, 20), rec(3, 20)], null, 0).flatStreak).toBe(1);
		expect(summarizeGoalLoops([rec(1, 20), rec(2, 20), rec(3, 25)], null, 0).flatStreak).toBe(0);
	});

	it('carries a silent loop forward as flat, the way the evaluator does', () => {
		const stats = summarizeGoalLoops([rec(1, 40), rec(2, null)], null, 0);
		expect(stats.lastDelta).toBe(0);
		expect(stats.flatStreak).toBe(1);
	});

	it('reaches the flat limit exactly when the evaluator stops the run as stalled', () => {
		const history = [rec(1, 50)];
		for (let i = 2; i <= STALL_THRESHOLD + 1; i++) {
			const stats = summarizeGoalLoops(history, null, 0);
			const stalled = evaluateGoalExit(history, config()).action === 'stop';
			expect(stats.flatStreak >= stats.flatLimit).toBe(stalled);
			history.push(rec(i, 50));
		}
	});
});
