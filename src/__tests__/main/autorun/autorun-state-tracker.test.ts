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

	it('releases a provisional claim without emitting a completion edge', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);

		expect(tracker.tryClaimStart('a')).toBe(true);
		expect(tracker.releaseStartClaim('a')).toBe(true);
		expect(tracker.isRunning('a')).toBe(false);
		expect(tracker.getRunningSince('a')).toBeUndefined();
		expect(listener).not.toHaveBeenCalled();
		expect(tracker.tryClaimStart('a')).toBe(true);
	});

	it('does not let a stale rollback clear a promoted running state', () => {
		expect(tracker.tryClaimStart('a')).toBe(true);
		tracker.update('a', { isRunning: true, totalTasks: 3 });

		expect(tracker.releaseStartClaim('a')).toBe(false);
		expect(tracker.isRunning('a')).toBe(true);
		expect(tracker.getState('a')).toEqual({ isRunning: true, totalTasks: 3 });
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

describe('AutoRunStateTracker - reclaiming a run after its owner reloads (#1470)', () => {
	let tracker: AutoRunStateTracker;
	const owner = { instanceId: 'tab-1', config: { documents: [] }, folderPath: '/docs' };
	const running = { isRunning: true, completedTasks: 2, totalTasks: 5, loopIteration: 1 };

	beforeEach(() => {
		tracker = new AutoRunStateTracker();
	});

	function startOwnedRun(agentId = 'a'): void {
		expect(tracker.tryClaimStart(agentId, owner)).toBe(true);
		tracker.update(agentId, running);
	}

	it('returns a running run only to the client that started it', () => {
		startOwnedRun();
		expect(tracker.takeOrphanedRuns('tab-2')).toEqual([]);
		expect(tracker.takeOrphanedRuns('tab-1')).toEqual([
			{ agentId: 'a', config: owner.config, folderPath: '/docs', state: running },
		]);
	});

	it('does not return a claim that never published a run', () => {
		expect(tracker.tryClaimStart('a', owner)).toBe(true);
		expect(tracker.takeOrphanedRuns('tab-1')).toEqual([]);
	});

	it('does not return a finished run', () => {
		startOwnedRun();
		tracker.update('a', null);
		expect(tracker.takeOrphanedRuns('tab-1')).toEqual([]);
	});

	it('holds a reclaimed run against other clients until its owner restarts it', () => {
		startOwnedRun();
		tracker.takeOrphanedRuns('tab-1');

		expect(tracker.tryClaimStart('a')).toBe(false);
		expect(tracker.tryClaimStart('a', { ...owner, instanceId: 'tab-2' })).toBe(false);
		expect(tracker.isRunning('a')).toBe(true);

		expect(tracker.tryClaimStart('a', owner)).toBe(true);
	});

	it('keeps the original start time across the restart', () => {
		startOwnedRun();
		const since = tracker.getRunningSince('a');
		tracker.takeOrphanedRuns('tab-1');
		tracker.tryClaimStart('a', owner);
		expect(tracker.getRunningSince('a')).toBe(since);
	});

	it('restarting does not emit a finality edge; the restarted run ending does', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);
		startOwnedRun();
		tracker.takeOrphanedRuns('tab-1');
		tracker.tryClaimStart('a', owner);
		tracker.update('a', { isRunning: true, completedTasks: 3, totalTasks: 5 });
		expect(listener).not.toHaveBeenCalled();

		tracker.update('a', null);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('releasing a restarted run that found no work left still ends the run', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);
		startOwnedRun();
		tracker.takeOrphanedRuns('tab-1');
		tracker.tryClaimStart('a', owner);

		expect(tracker.releaseStartClaim('a')).toBe(true);
		expect(listener).toHaveBeenCalledWith('a', { tasksCompleted: 2, tasksTotal: 5 });
		expect(tracker.isRunning('a')).toBe(false);
	});

	it('hands the run back again if the owner reloads before restarting it', () => {
		startOwnedRun();
		tracker.takeOrphanedRuns('tab-1');
		expect(tracker.takeOrphanedRuns('tab-1')).toHaveLength(1);

		// ...and again after a restart that had not published yet, with the
		// state the original loop last published rather than the placeholder.
		tracker.tryClaimStart('a', owner);
		expect(tracker.takeOrphanedRuns('tab-1')).toEqual([
			expect.objectContaining({ agentId: 'a', state: running }),
		]);
	});

	it('cancels the reclaim when the original loop turns out to be alive', () => {
		startOwnedRun();
		tracker.takeOrphanedRuns('tab-1');
		tracker.update('a', { ...running, completedTasks: 3 });
		expect(tracker.tryClaimStart('a', owner)).toBe(false);
	});

	it('abandoning a reclaim ends the run and frees the agent', () => {
		const listener = vi.fn();
		tracker.onFinal(listener);
		startOwnedRun();
		tracker.takeOrphanedRuns('tab-1');

		expect(tracker.abandonReclaim('a', 'tab-2')).toBe(false);
		expect(tracker.abandonReclaim('a', 'tab-1')).toBe(true);
		expect(listener).toHaveBeenCalledWith('a', { tasksCompleted: 2, tasksTotal: 5 });
		expect(tracker.isRunning('a')).toBe(false);
		expect(tracker.takeOrphanedRuns('tab-1')).toEqual([]);
		expect(tracker.tryClaimStart('a')).toBe(true);
	});

	it('cannot abandon a run that was not handed back', () => {
		startOwnedRun();
		expect(tracker.abandonReclaim('a', 'tab-1')).toBe(false);
		expect(tracker.isRunning('a')).toBe(true);
	});
});
