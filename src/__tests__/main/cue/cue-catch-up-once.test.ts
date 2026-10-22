/**
 * After a sleep or pause, a missed time window runs once: the reconciler's
 * catch-up and the trigger source's own timer must not both run it.
 *
 * Which of the two fires first, and whether the timer is overdue on resume,
 * depends on what stopped the process:
 *  - SIGSTOP, a VM pause, or Windows sleep: the monotonic timer clock keeps
 *    running, so on resume every due timer fires at once.
 *  - A Linux or macOS suspend: the monotonic clock stops too, so a timer
 *    still has its remaining delay to wait after resume.
 *
 * The wall clock (`Date`) and the timer clock move separately here, so both
 * behaviors can be modeled: `wallMs` is what `Date` reports, and the fake
 * timers only advance when a test advances them. Uses the real trigger
 * sources, session registry and reconciler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCueHeartbeatTriggerSource } from '../../../main/cue/triggers/cue-heartbeat-trigger-source';
import { createCueScheduledTriggerSource } from '../../../main/cue/triggers/cue-scheduled-trigger-source';
import {
	createCueSessionRegistry,
	type CueSessionRegistry,
} from '../../../main/cue/cue-session-registry';
import { reconcileMissedTimeEvents } from '../../../main/cue/cue-reconciler';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { CueTriggerSource } from '../../../main/cue/triggers/cue-trigger-source';
import type { SessionInfo } from '../../../shared/types';

const SESSION: SessionInfo = {
	id: 'session-1',
	name: 'Test',
	toolType: 'claude-code',
	cwd: '/p',
	projectRoot: '/p',
};

const RealDate = Date;
let wallMs = 0;

/** `Date` that reads `wallMs`, independent of the fake timer clock. */
class WallDate extends RealDate {
	constructor(...args: unknown[]) {
		if (args.length === 0) super(wallMs);
		else super(...(args as [string | number | Date]));
	}
	static now(): number {
		return wallMs;
	}
}

/** Both clocks run, as they do while the process is awake. */
function elapse(ms: number): void {
	for (let left = ms; left > 0; ) {
		const step = Math.min(1000, left);
		wallMs += step;
		vi.advanceTimersByTime(step);
		left -= step;
	}
}

interface Harness {
	runs: Array<{ wallMs: number; reconciled: boolean }>;
	registry: CueSessionRegistry;
	source: CueTriggerSource;
	reconcile: (sleepStartMs: number) => void;
}

function setUp(sub: CueSubscription, create: typeof createCueHeartbeatTriggerSource): Harness {
	const runs: Harness['runs'] = [];
	const record = (event: CueEvent) =>
		runs.push({ wallMs, reconciled: event.payload.reconciled === true });
	const registry = createCueSessionRegistry();
	const source = create({
		session: SESSION,
		subscription: sub,
		registry,
		enabled: () => true,
		onLog: vi.fn(),
		emit: record,
	});
	if (!source) throw new Error('no trigger source');
	source.start();

	const reconcile = (sleepStartMs: number) =>
		reconcileMissedTimeEvents({
			sleepStartMs,
			wakeTimeMs: Date.now(),
			sessions: new Map([
				[
					SESSION.id,
					{ config: { subscriptions: [sub], settings: {} } as never, sessionName: 'Test' },
				],
			]),
			onDispatch: (_sessionId, _sub, event) => record(event),
			onLog: vi.fn(),
			firedRecord: registry,
		});

	return { runs, registry, source, reconcile };
}

const MIN = 60_000;

describe('one run per missed window after a sleep or pause', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		vi.stubGlobal('Date', WallDate);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	describe('time.heartbeat, 2-minute interval, paused 150s', () => {
		const sub: CueSubscription = {
			name: 'beat',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 2,
		};
		const T0 = new RealDate(2026, 9, 8, 10, 0, 0).getTime();

		let h: Harness;
		let lastHeartbeatMs: number;

		beforeEach(() => {
			wallMs = T0;
			h = setUp(sub, createCueHeartbeatTriggerSource);
			// Runs at start, the process is awake for a minute, then it pauses.
			elapse(1 * MIN);
			lastHeartbeatMs = wallMs;
			wallMs += 150_000;
		});

		afterEach(() => h.source.stop());

		/** After resume: one run every interval, and nothing in between. */
		function expectCadenceFrom(lastRunMs: number) {
			const before = h.runs.length;
			elapse(lastRunMs + 2 * MIN - 1000 - wallMs);
			expect(h.runs.length).toBe(before);
			elapse(1000);
			expect(h.runs.length).toBe(before + 1);
			expect(h.runs[before].wallMs).toBe(lastRunMs + 2 * MIN);
			elapse(2 * MIN);
			expect(h.runs.length).toBe(before + 2);
		}

		it('timer overdue on resume, catch-up first: runs once', () => {
			h.reconcile(lastHeartbeatMs);
			vi.advanceTimersToNextTimer(); // the overdue interval, 13 ms later in the live run

			expect(h.runs.map((r) => r.reconciled)).toEqual([false, true]);
			expectCadenceFrom(T0 + 3.5 * MIN);
		});

		it('timer overdue on resume, timer first: runs once', () => {
			vi.advanceTimersToNextTimer();
			h.reconcile(lastHeartbeatMs);

			expect(h.runs.map((r) => r.reconciled)).toEqual([false, false]);
			expectCadenceFrom(T0 + 3.5 * MIN);
		});

		it('timer not overdue on resume (suspend stopped the timer clock): runs once', () => {
			h.reconcile(lastHeartbeatMs);
			// The interval still had a minute to wait when the clock stopped.
			elapse(1 * MIN);

			expect(h.runs.map((r) => r.reconciled)).toEqual([false, true]);
			expectCadenceFrom(T0 + 3.5 * MIN);
		});

		it('timer not overdue on resume, timer first: runs once', () => {
			// A resume handler that runs later than the timer's remaining wait.
			elapse(1 * MIN);
			h.reconcile(lastHeartbeatMs);

			expect(h.runs.map((r) => r.reconciled)).toEqual([false, false]);
			expectCadenceFrom(T0 + 4.5 * MIN);
		});

		it('still catches up when the last run was more than an interval before the wake', () => {
			h.reconcile(lastHeartbeatMs);
			expect(h.runs.at(-1)).toEqual({ wallMs: T0 + 3.5 * MIN, reconciled: true });
		});
	});

	it('time.heartbeat with no sleep keeps its interval', () => {
		wallMs = new RealDate(2026, 9, 8, 10, 0, 0).getTime();
		const start = wallMs;
		const h = setUp(
			{ name: 'beat', event: 'time.heartbeat', enabled: true, prompt: 'p', interval_minutes: 2 },
			createCueHeartbeatTriggerSource
		);
		elapse(10 * MIN);
		expect(h.runs.map((r) => (r.wallMs - start) / MIN)).toEqual([0, 2, 4, 6, 8, 10]);
		h.source.stop();
	});

	describe('time.scheduled at 09:00, waking inside the 09:00 minute', () => {
		const sub: CueSubscription = {
			name: 'daily',
			event: 'time.scheduled',
			enabled: true,
			prompt: 'p',
			schedule_times: ['09:00'],
		};
		const at = (h: number, m: number, s: number) => new RealDate(2026, 9, 8, h, m, s).getTime();

		let h: Harness;

		afterEach(() => h.source.stop());

		it('timer overdue on resume, catch-up first: runs once', () => {
			wallMs = at(8, 58, 0);
			h = setUp(sub, createCueScheduledTriggerSource);
			elapse(10_000);
			wallMs = at(9, 0, 20);
			h.reconcile(at(8, 58, 10));
			vi.advanceTimersToNextTimer();

			expect(h.runs.map((r) => r.reconciled)).toEqual([true]);
		});

		it('timer overdue on resume, timer first: runs once', () => {
			wallMs = at(8, 58, 0);
			h = setUp(sub, createCueScheduledTriggerSource);
			elapse(10_000);
			wallMs = at(9, 0, 20);
			vi.advanceTimersToNextTimer();
			h.reconcile(at(8, 58, 10));

			expect(h.runs.map((r) => r.reconciled)).toEqual([false]);
		});

		it('timer not overdue on resume, timer first: runs once', () => {
			wallMs = at(8, 57, 35);
			h = setUp(sub, createCueScheduledTriggerSource);
			elapse(20_000);
			// Paused at 08:57:55 with the poll 40s away; resumes at 09:00:05.
			wallMs = at(9, 0, 5);
			elapse(40_000);
			h.reconcile(at(8, 57, 55));

			expect(h.runs.map((r) => r.reconciled)).toEqual([false]);
		});

		it('timer not overdue on resume, catch-up first: runs once', () => {
			wallMs = at(8, 57, 35);
			h = setUp(sub, createCueScheduledTriggerSource);
			elapse(20_000);
			wallMs = at(9, 0, 5);
			h.reconcile(at(8, 57, 55));
			elapse(MIN);

			expect(h.runs.map((r) => r.reconciled)).toEqual([true]);
		});

		it('a slot before the wake minute is caught up as before', () => {
			wallMs = at(8, 58, 0);
			h = setUp(sub, createCueScheduledTriggerSource);
			elapse(10_000);
			wallMs = at(9, 5, 0);
			h.reconcile(at(8, 58, 10));
			vi.advanceTimersToNextTimer();
			elapse(5 * MIN);

			expect(h.runs.map((r) => r.reconciled)).toEqual([true]);
		});
	});
});
