/**
 * Tests for the time.heartbeat trigger source.
 *
 * Pins down the fire-immediately + on-interval behaviour, idempotent
 * start/stop, filter integration, nextTriggerAt projection, and the
 * enabled() gate that prevents fires after the engine is disabled.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCueHeartbeatTriggerSource } from '../../../../main/cue/triggers/cue-heartbeat-trigger-source';
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
		name: 'beat',
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'do work',
		interval_minutes: 5,
		...overrides,
	};
}

describe('cue-heartbeat-trigger-source', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns null when interval_minutes is missing', () => {
		const source = createCueHeartbeatTriggerSource({
			session: makeSession(),
			subscription: makeSub({ interval_minutes: undefined }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		});
		expect(source).toBeNull();
	});

	it('returns null when interval_minutes is zero or negative', () => {
		const ctx = {
			session: makeSession(),
			subscription: makeSub({ interval_minutes: 0 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		};
		expect(createCueHeartbeatTriggerSource(ctx)).toBeNull();
		expect(
			createCueHeartbeatTriggerSource({
				...ctx,
				subscription: makeSub({ interval_minutes: -1 }),
			})
		).toBeNull();
	});

	it('fires immediately on start', () => {
		const emit = vi.fn();
		const source = createCueHeartbeatTriggerSource({
			session: makeSession(),
			subscription: makeSub({ interval_minutes: 1 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();

		expect(emit).toHaveBeenCalledOnce();
		const event = emit.mock.calls[0][0] as CueEvent;
		expect(event.type).toBe('time.heartbeat');
		expect(event.payload.interval_minutes).toBe(1);

		source.stop();
	});

	it('fires again on each interval tick', () => {
		const emit = vi.fn();
		const source = createCueHeartbeatTriggerSource({
			session: makeSession(),
			subscription: makeSub({ interval_minutes: 1 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		expect(emit).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60_000);
		expect(emit).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(60_000);
		expect(emit).toHaveBeenCalledTimes(3);

		source.stop();
	});

	it('does not fire when enabled() returns false', () => {
		const emit = vi.fn();
		let enabled = true;
		const source = createCueHeartbeatTriggerSource({
			session: makeSession(),
			subscription: makeSub({ interval_minutes: 1 }),
			registry: createCueSessionRegistry(),
			enabled: () => enabled,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		expect(emit).toHaveBeenCalledTimes(1); // immediate fire

		// Disable before the next tick — the timer callback short-circuits.
		enabled = false;
		vi.advanceTimersByTime(60_000);
		expect(emit).toHaveBeenCalledTimes(1);

		source.stop();
	});

	it('honours the subscription filter', () => {
		const emit = vi.fn();
		const onLog = vi.fn();
		const source = createCueHeartbeatTriggerSource({
			session: makeSession(),
			subscription: makeSub({
				interval_minutes: 1,
				// payload.interval_minutes is always set to 1 by createCueEvent —
				// this filter requires "2" so the event will never match.
				filter: { interval_minutes: 2 },
			}),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit,
		})!;

		source.start();
		expect(emit).not.toHaveBeenCalled();
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));

		source.stop();
	});

	it('stop() clears the interval and prevents further fires', () => {
		const emit = vi.fn();
		const source = createCueHeartbeatTriggerSource({
			session: makeSession(),
			subscription: makeSub({ interval_minutes: 1 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		expect(emit).toHaveBeenCalledTimes(1);

		source.stop();
		vi.advanceTimersByTime(60_000 * 5);
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('start() and stop() are both idempotent', () => {
		const emit = vi.fn();
		const source = createCueHeartbeatTriggerSource({
			session: makeSession(),
			subscription: makeSub({ interval_minutes: 1 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		source.start(); // second call is a no-op (timer already exists)
		expect(emit).toHaveBeenCalledTimes(1);

		source.stop();
		expect(() => source.stop()).not.toThrow();
	});

	it('nextTriggerAt() reports a future timestamp after start, null after stop', () => {
		vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
		const source = createCueHeartbeatTriggerSource({
			session: makeSession(),
			subscription: makeSub({ interval_minutes: 5 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		expect(source.nextTriggerAt()).toBeNull();

		source.start();
		const next = source.nextTriggerAt();
		expect(next).not.toBeNull();
		// 5 minutes after the system time.
		expect(next).toBeGreaterThan(Date.now());
		expect(next).toBeLessThanOrEqual(Date.now() + 5 * 60_000);

		source.stop();
		expect(source.nextTriggerAt()).toBeNull();
	});
});
