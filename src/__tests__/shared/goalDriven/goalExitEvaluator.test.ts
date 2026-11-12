/**
 * Tests for the Goal-Driven exit evaluator.
 *
 * @file src/shared/goalDriven/goalExitEvaluator.ts
 */

import { describe, it, expect } from 'vitest';
import { evaluateGoalExit } from '../../../shared/goalDriven/goalExitEvaluator';
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
