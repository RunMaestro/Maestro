/**
 * @file autorun-state-tracker.test.ts
 * @description Phase 2 finality signal: the main-process mirror of Auto Run
 * state, including the `null` clear path the web broadcaster misses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
	AutoRunStateTracker,
	getAutoRunStateTracker,
	resetAutoRunStateTracker,
} from '../../../main/autorun/autorun-state-tracker';

describe('AutoRunStateTracker', () => {
	let tracker: AutoRunStateTracker;

	beforeEach(() => {
		tracker = new AutoRunStateTracker();
	});

	it('tracks running state per agent', () => {
		expect(tracker.isRunning('a')).toBe(false);
		tracker.update('a', { isRunning: true });
		expect(tracker.isRunning('a')).toBe(true);
		expect(tracker.isRunning('b')).toBe(false);
	});

	it('allows only one caller to claim a simultaneous start', () => {
		expect(tracker.tryClaimStart('a')).toBe(true);
		expect(tracker.tryClaimStart('a')).toBe(false);
		expect(tracker.tryClaimStart('b')).toBe(true);
	});

	it('allows a new claim after the previous run clears', () => {
		expect(tracker.tryClaimStart('a')).toBe(true);
		tracker.update('a', null);
		expect(tracker.tryClaimStart('a')).toBe(true);
	});

	it('emits the running -> not-running edge exactly once', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);

		tracker.update('a', { isRunning: true, completedTasks: 0, totalTasks: 3 });
		tracker.update('a', { isRunning: true, completedTasks: 1, totalTasks: 3 });
		tracker.update('a', { isRunning: true, completedTasks: 2, totalTasks: 3 });
		expect(listener).not.toHaveBeenCalled();

		tracker.update('a', { isRunning: false, completedTasks: 3, totalTasks: 3 });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith('a', { tasksCompleted: 3, tasksTotal: 3 });

		// A repeat of the not-running state is not a new edge.
		tracker.update('a', { isRunning: false, completedTasks: 3, totalTasks: 3 });
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('treats a null state as the end of the run', () => {
		// The renderer clears Auto Run state to null when a batch ends, which the
		// web broadcaster's transition detection never sees.
		const listener = vi.fn();
		tracker.onFinal(listener);
		tracker.update('a', { isRunning: true, completedTasks: 1, totalTasks: 2 });
		tracker.update('a', null);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith('a', { tasksCompleted: 1, tasksTotal: 2 });
		expect(tracker.isRunning('a')).toBe(false);
	});

	it('does not emit for a null state when nothing was running', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);
		tracker.update('a', null);
		expect(listener).not.toHaveBeenCalled();
	});

	it('prefers the multi-document task totals when present', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);
		tracker.update('a', {
			isRunning: true,
			completedTasks: 2,
			totalTasks: 4,
			completedTasksAcrossAllDocs: 9,
			totalTasksAcrossAllDocs: 12,
		});
		tracker.update('a', null);
		expect(listener).toHaveBeenCalledWith('a', { tasksCompleted: 9, tasksTotal: 12 });
	});

	it('isolates agents from one another', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);
		tracker.update('a', { isRunning: true });
		tracker.update('b', { isRunning: true });
		tracker.update('b', null);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith('b', {});
		expect(tracker.isRunning('a')).toBe(true);
	});

	it('survives a throwing listener', () => {
		const good = vi.fn();
		tracker.onFinal(() => {
			throw new Error('boom');
		});
		tracker.onFinal(good);
		tracker.update('a', { isRunning: true });
		expect(() => tracker.update('a', null)).not.toThrow();
		expect(good).toHaveBeenCalled();
	});

	it('unsubscribes cleanly', () => {
		const listener = vi.fn();
		const off = tracker.onFinal(listener);
		off();
		tracker.update('a', { isRunning: true });
		tracker.update('a', null);
		expect(listener).not.toHaveBeenCalled();
	});

	it('clear() forgets an agent without emitting an edge', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);
		tracker.update('a', { isRunning: true });
		tracker.clear('a');
		expect(listener).not.toHaveBeenCalled();
		expect(tracker.isRunning('a')).toBe(false);
	});
});

describe('getAutoRunStateTracker', () => {
	it('returns a process-wide singleton', () => {
		resetAutoRunStateTracker();
		const first = getAutoRunStateTracker();
		expect(getAutoRunStateTracker()).toBe(first);
		resetAutoRunStateTracker();
		expect(getAutoRunStateTracker()).not.toBe(first);
	});
});
