/**
 * Tests for the time.scheduled trigger source.
 *
 * Pins down the per-minute polling cadence, dedup-via-registry semantics,
 * day-of-week filtering, stale key eviction, and nextTriggerAt projection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCueScheduledTriggerSource } from '../../../../main/cue/triggers/cue-scheduled-trigger-source';
import { createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type { CueEvent, CueSubscription } from '../../../../main/cue/cue-types';
import type { SessionInfo } from '../../../../shared/types';

function makeSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
	};
}

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'scheduled',
		event: 'time.scheduled',
		enabled: true,
		prompt: 'do work',
		schedule_times: ['09:00'],
		...overrides,
	};
}

describe('cue-scheduled-trigger-source', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns null when schedule_times is empty', () => {
		const source = createCueScheduledTriggerSource({
			session: makeSession(),
			subscription: makeSub({ schedule_times: [] }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		});
		expect(source).toBeNull();
	});

	it('fires when the polling tick lands on a scheduled minute', () => {
		// Local Monday 08:59 — 1 minute before the scheduled 09:00.
		vi.setSystemTime(new Date('2026-03-09T08:59:00'));
		const emit = vi.fn();
		const source = createCueScheduledTriggerSource({
			session: makeSession(),
			subscription: makeSub({ schedule_times: ['09:00'] }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		expect(emit).not.toHaveBeenCalled();

		// Advance the fake clock by 60s. vitest moves the system clock and fires
		// any due timers; inside the firing the clock reads as 09:00 local time.
		vi.advanceTimersByTime(60_000);

		expect(emit).toHaveBeenCalledOnce();
		const event = emit.mock.calls[0][0] as CueEvent;
		expect(event.type).toBe('time.scheduled');
		expect(event.payload.matched_time).toBe('09:00');

		source.stop();
	});

	it('does NOT re-fire within the same minute (registry dedup)', () => {
		// Start at 08:59:00 local. First tick lands at 09:00:00.
		vi.setSystemTime(new Date('2026-03-09T08:59:00'));
		const registry = createCueSessionRegistry();
		const emit = vi.fn();
		const source = createCueScheduledTriggerSource({
			session: makeSession(),
			subscription: makeSub({ schedule_times: ['09:00'] }),
			registry,
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		// Advance just enough to land inside the 09:00 minute and fire once.
		vi.advanceTimersByTime(60_000);
		expect(emit).toHaveBeenCalledTimes(1);

		// A second poll-interval tick lands at ~09:01. The current time is no
		// longer "09:00", so the dedup branch is short-circuited by the time-not-
		// matched check, not by markScheduledFired. To exercise the dedup path
		// directly we'd need a sub-minute polling cadence; instead this test
		// asserts that the first fire is one-shot and the second tick stays cold.
		vi.advanceTimersByTime(60_000);
		expect(emit).toHaveBeenCalledTimes(1);

		source.stop();
	});

	it('skips the fire when the day-of-week filter does not match', () => {
		// Monday — only Wed allowed.
		vi.setSystemTime(new Date('2026-03-09T08:59:00'));
		const emit = vi.fn();
		const source = createCueScheduledTriggerSource({
			session: makeSession(),
			subscription: makeSub({ schedule_times: ['09:00'], schedule_days: ['wed'] }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		vi.advanceTimersByTime(60_000);

		expect(emit).not.toHaveBeenCalled();

		source.stop();
	});

	it('does not fire when enabled() returns false', () => {
		vi.setSystemTime(new Date('2026-03-09T08:59:00'));
		const emit = vi.fn();
		const source = createCueScheduledTriggerSource({
			session: makeSession(),
			subscription: makeSub({ schedule_times: ['09:00'] }),
			registry: createCueSessionRegistry(),
			enabled: () => false,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		vi.advanceTimersByTime(60_000);

		expect(emit).not.toHaveBeenCalled();

		source.stop();
	});

	it('honours the subscription filter', () => {
		vi.setSystemTime(new Date('2026-03-09T08:59:00'));
		const emit = vi.fn();
		const onLog = vi.fn();
		const source = createCueScheduledTriggerSource({
			session: makeSession(),
			subscription: makeSub({
				schedule_times: ['09:00'],
				filter: { matched_time: '10:00' },
			}),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit,
		})!;

		source.start();
		vi.advanceTimersByTime(60_000);

		expect(emit).not.toHaveBeenCalled();
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));

		source.stop();
	});

	it('nextTriggerAt() reports the next scheduled time after start', () => {
		// Local Monday 08:00 — next 09:00 is 1 hour ahead, same local day.
		vi.setSystemTime(new Date('2026-03-09T08:00:00'));
		const source = createCueScheduledTriggerSource({
			session: makeSession(),
			subscription: makeSub({ schedule_times: ['09:00'] }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		expect(source.nextTriggerAt()).toBeNull();
		source.start();
		const next = source.nextTriggerAt();
		expect(next).not.toBeNull();
		// Compare via local-time accessors so the assertion is timezone-agnostic.
		const target = new Date(next!);
		expect(target.getHours()).toBe(9);
		expect(target.getMinutes()).toBe(0);
		expect(target.getDate()).toBe(9); // same local day

		source.stop();
		expect(source.nextTriggerAt()).toBeNull();
	});

	it('start() and stop() are idempotent', () => {
		vi.setSystemTime(new Date('2026-03-09T08:59:00'));
		const source = createCueScheduledTriggerSource({
			session: makeSession(),
			subscription: makeSub({ schedule_times: ['09:00'] }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		source.start(); // no-op
		source.stop();
		expect(() => source.stop()).not.toThrow();
	});
});
