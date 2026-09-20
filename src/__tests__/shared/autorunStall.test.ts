import { describe, it, expect } from 'vitest';
import {
	MAX_CONSECUTIVE_NO_CHANGES,
	describeStall,
	evaluateStall,
} from '../../shared/autorunStall';

const counts = (checked: number, unchecked: number) => ({ checked, unchecked });

describe('evaluateStall', () => {
	it('resets the counter when a task gets checked off', () => {
		const result = evaluateStall({
			before: counts(0, 3),
			after: counts(1, 2),
			consecutiveNoChangeCount: 2,
		});
		expect(result).toMatchObject({
			consecutiveNoChangeCount: 0,
			stalled: false,
			taskSetChanged: true,
		});
	});

	it('resets when the agent adds tasks without finishing one', () => {
		// Decomposing a task into subtasks is real work, even though nothing got
		// ticked. Counting it as a stall would punish the correct behavior.
		const result = evaluateStall({
			before: counts(0, 1),
			after: counts(0, 4),
			consecutiveNoChangeCount: 2,
		});
		expect(result.consecutiveNoChangeCount).toBe(0);
		expect(result.stalled).toBe(false);
	});

	it('increments when nothing about the task set moved', () => {
		const result = evaluateStall({
			before: counts(2, 3),
			after: counts(2, 3),
			consecutiveNoChangeCount: 0,
		});
		expect(result).toMatchObject({
			consecutiveNoChangeCount: 1,
			stalled: false,
			taskSetChanged: false,
		});
	});

	it('trips only on the third consecutive no-progress run', () => {
		let count = 0;
		const step = () =>
			(count = evaluateStall({
				before: counts(1, 2),
				after: counts(1, 2),
				consecutiveNoChangeCount: count,
			}).consecutiveNoChangeCount);

		step();
		step();
		expect(
			evaluateStall({ before: counts(1, 2), after: counts(1, 2), consecutiveNoChangeCount: count })
				.stalled
		).toBe(true);
		expect(MAX_CONSECUTIVE_NO_CHANGES).toBe(3);
	});

	it('trips immediately on a watchdog failure', () => {
		// The agent hung. Two more dispatches would reach the same conclusion and
		// cost two more turns to get there.
		const result = evaluateStall({
			before: counts(0, 2),
			after: counts(0, 2),
			consecutiveNoChangeCount: 0,
			watchdogFailure: true,
		});
		expect(result.stalled).toBe(true);
		expect(result.reason).toBe('agent hung or exceeded its time budget');
	});

	it('ignores prose churn: only the task set counts as progress', () => {
		// The failure this heuristic exists for. An agent that cannot do the work
		// writes "here is why I could not" into the document. A byte comparison
		// would call that progress and let the loop run forever.
		const result = evaluateStall({
			before: counts(0, 1),
			after: counts(0, 1),
			consecutiveNoChangeCount: MAX_CONSECUTIVE_NO_CHANGES - 1,
		});
		expect(result.stalled).toBe(true);
		expect(result.reason).toBe('3 consecutive runs with no progress');
	});

	it('does not count an UNCHECKED task as progress', () => {
		// Someone unticking a box is not the agent completing work.
		const result = evaluateStall({
			before: counts(2, 1),
			after: counts(1, 2),
			consecutiveNoChangeCount: 0,
		});
		expect(result.taskSetChanged).toBe(true);
		expect(result.consecutiveNoChangeCount).toBe(0);
	});

	it('leaves reason unset while the document is still healthy', () => {
		expect(
			evaluateStall({ before: counts(0, 2), after: counts(1, 1), consecutiveNoChangeCount: 0 })
				.reason
		).toBeUndefined();
	});
});

describe('describeStall', () => {
	it('names the count for an ordinary stall', () => {
		expect(describeStall(3)).toBe('3 consecutive runs with no progress');
	});

	it('names the hang for a watchdog stall', () => {
		expect(describeStall(3, true)).toBe('agent hung or exceeded its time budget');
	});
});
