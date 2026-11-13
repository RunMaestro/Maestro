// Related Cue tests; each source keeps its own hooks and state.
// Source: src/__tests__/main/cue/triggers/cue-heartbeat-trigger-source.test.ts
// Source: src/__tests__/main/cue/triggers/cue-once-trigger-source.test.ts
// Source: src/__tests__/main/cue/triggers/cue-scheduled-trigger-source.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCueHeartbeatTriggerSource } from '../../../../main/cue/triggers/cue-heartbeat-trigger-source';
import { createCueSessionRegistry as s0_createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type {
	CueEvent as S0_CueEvent,
	CueSubscription as S0_CueSubscription,
} from '../../../../main/cue/cue-types';
import type { SessionInfo as S0_SessionInfo } from '../../../../shared/types';
import { createCueOnceTriggerSource } from '../../../../main/cue/triggers/cue-once-trigger-source';
import { createCueSessionRegistry as s1_createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type {
	CueEvent as S1_CueEvent,
	CueSubscription as S1_CueSubscription,
} from '../../../../main/cue/cue-types';
import type { SessionInfo as S1_SessionInfo } from '../../../../shared/types';
import { createCueScheduledTriggerSource } from '../../../../main/cue/triggers/cue-scheduled-trigger-source';
import { createCueSessionRegistry as s2_createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type {
	CueEvent as S2_CueEvent,
	CueSubscription as S2_CueSubscription,
} from '../../../../main/cue/cue-types';
import type { SessionInfo as S2_SessionInfo } from '../../../../shared/types';
describe('cue-heartbeat-trigger-source', () => {
	function makeSession(): S0_SessionInfo {
		return {
			id: 'session-1',
			name: 'Test',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
		};
	}
	function makeSub(overrides: Partial<S0_CueSubscription> = {}): S0_CueSubscription {
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
				registry: s0_createCueSessionRegistry(),
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
				registry: s0_createCueSessionRegistry(),
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
				registry: s0_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
			})!;
			source.start();
			expect(emit).toHaveBeenCalledOnce();
			const event = emit.mock.calls[0][0] as S0_CueEvent;
			expect(event.type).toBe('time.heartbeat');
			expect(event.payload.interval_minutes).toBe(1);
			source.stop();
		});
		it('fires again on each interval tick', () => {
			const emit = vi.fn();
			const source = createCueHeartbeatTriggerSource({
				session: makeSession(),
				subscription: makeSub({ interval_minutes: 1 }),
				registry: s0_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
			})!;
			source.start();
			expect(emit).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(60000);
			expect(emit).toHaveBeenCalledTimes(2);
			vi.advanceTimersByTime(60000);
			expect(emit).toHaveBeenCalledTimes(3);
			source.stop();
		});
		it('does not fire when enabled() returns false', () => {
			const emit = vi.fn();
			let enabled = true;
			const source = createCueHeartbeatTriggerSource({
				session: makeSession(),
				subscription: makeSub({ interval_minutes: 1 }),
				registry: s0_createCueSessionRegistry(),
				enabled: () => enabled,
				onLog: vi.fn(),
				emit,
			})!;
			source.start();
			expect(emit).toHaveBeenCalledTimes(1); // immediate fire
			// Disable before the next tick - the timer callback short-circuits.
			enabled = false;
			vi.advanceTimersByTime(60000);
			expect(emit).toHaveBeenCalledTimes(1);
			source.stop();
		});
		it('reports skipped intervals after a delayed timer and evaluates only once', () => {
			const emit = vi.fn();
			const onLog = vi.fn();
			const source = createCueHeartbeatTriggerSource({
				session: makeSession(),
				subscription: makeSub({ interval_minutes: 1 }),
				registry: s0_createCueSessionRegistry(),
				enabled: () => true,
				onLog,
				emit,
			})!;
			source.start();
			emit.mockClear();
			vi.setSystemTime(Date.now() + 3 * 60000);
			vi.advanceTimersByTime(60000);
			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit.mock.calls[0][0].payload.missedCount).toBe(3);
			expect(onLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('missed 3 heartbeat interval(s)')
			);
			// A missed heartbeat (sleep/wake) must not carry the payload that raises
			// the sticky "Cue trigger health" toast.
			expect(onLog.mock.calls.some(([, , data]) => data?.type === 'triggerHealthWarning')).toBe(
				false
			);
			source.stop();
		});
		it('honours the subscription filter', () => {
			const emit = vi.fn();
			const onLog = vi.fn();
			const source = createCueHeartbeatTriggerSource({
				session: makeSession(),
				subscription: makeSub({
					interval_minutes: 1,
					// payload.interval_minutes is always set to 1 by createCueEvent -
					// this filter requires "2" so the event will never match.
					filter: { interval_minutes: 2 },
				}),
				registry: s0_createCueSessionRegistry(),
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
				registry: s0_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
			})!;
			source.start();
			expect(emit).toHaveBeenCalledTimes(1);
			source.stop();
			vi.advanceTimersByTime(60000 * 5);
			expect(emit).toHaveBeenCalledTimes(1);
		});
		it('start() and stop() are both idempotent', () => {
			const emit = vi.fn();
			const source = createCueHeartbeatTriggerSource({
				session: makeSession(),
				subscription: makeSub({ interval_minutes: 1 }),
				registry: s0_createCueSessionRegistry(),
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
				registry: s0_createCueSessionRegistry(),
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
			expect(next).toBeLessThanOrEqual(Date.now() + 5 * 60000);
			source.stop();
			expect(source.nextTriggerAt()).toBeNull();
		});
	});
});
describe('cue-once-trigger-source', () => {
	function makeSession(): S1_SessionInfo {
		return {
			id: 'session-1',
			name: 'Test',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
		};
	}
	function makeSub(overrides: Partial<S1_CueSubscription> = {}): S1_CueSubscription {
		return {
			name: 'once-task',
			event: 'time.once',
			enabled: true,
			prompt: 'do work',
			fire_at: '2026-03-09T09:00:00Z',
			...overrides,
		};
	}
	describe('cue-once-trigger-source', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		it('fires exactly once when fire_at is in the past on first poll', () => {
			// Pin "now" 5 minutes after the scheduled fire, well inside the default
			// 6-hour grace window.
			vi.setSystemTime(new Date('2026-03-09T09:05:00Z'));
			const emit = vi.fn();
			const requestSelfDestruct = vi.fn();
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z' }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct,
			})!;
			source.start();
			expect(emit).toHaveBeenCalledOnce();
			const event = emit.mock.calls[0][0] as S1_CueEvent;
			expect(event.type).toBe('time.once');
			expect(event.payload.fire_at).toBe('2026-03-09T09:00:00Z');
			expect(event.payload.grace_minutes).toBe(360);
			expect(requestSelfDestruct).not.toHaveBeenCalled();
			// Subsequent ticks must not double-fire - the source stops its own timer
			// after firing.
			vi.advanceTimersByTime(60000);
			expect(emit).toHaveBeenCalledTimes(1);
			source.stop();
		});
		it('does not fire when fire_at is in the future, and nextTriggerAt() reports the target', () => {
			vi.setSystemTime(new Date('2026-03-09T08:00:00Z'));
			const emit = vi.fn();
			const requestSelfDestruct = vi.fn();
			const targetIso = '2026-03-09T09:00:00Z';
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: targetIso }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct,
			})!;
			source.start();
			expect(emit).not.toHaveBeenCalled();
			expect(requestSelfDestruct).not.toHaveBeenCalled();
			expect(source.nextTriggerAt()).toBe(Date.parse(targetIso));
			// Advance just one 30s tick - still in the future, still no fire.
			vi.advanceTimersByTime(30000);
			expect(emit).not.toHaveBeenCalled();
			source.stop();
		});
		it('self-destructs WITHOUT firing when fire_at is past the grace window', () => {
			// 2 hours past fire_at; grace_minutes is 60 → missed-grace path.
			vi.setSystemTime(new Date('2026-03-09T11:00:00Z'));
			const emit = vi.fn();
			const requestSelfDestruct = vi.fn();
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z', grace_minutes: 60 }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct,
			})!;
			source.start();
			expect(emit).not.toHaveBeenCalled();
			expect(requestSelfDestruct).toHaveBeenCalledOnce();
			expect(requestSelfDestruct).toHaveBeenCalledWith('once-task', 'missed-grace');
			source.stop();
		});
		it('grace_minutes: 0 disables late fires - self-destructs without firing when fire_at is in the past', () => {
			// 1 minute past fire_at; grace_minutes: 0 disables the missed-fire rescue
			// entirely, so any past fire_at on first poll triggers self-destruct.
			vi.setSystemTime(new Date('2026-03-09T09:01:00Z'));
			const emit = vi.fn();
			const requestSelfDestruct = vi.fn();
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z', grace_minutes: 0 }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct,
			})!;
			source.start();
			expect(emit).not.toHaveBeenCalled();
			expect(requestSelfDestruct).toHaveBeenCalledOnce();
			expect(requestSelfDestruct).toHaveBeenCalledWith('once-task', 'missed-grace');
			source.stop();
		});
		it('idempotent fire - registry dedup prevents double-emit on repeat checkAndFire', () => {
			vi.setSystemTime(new Date('2026-03-09T09:05:00Z'));
			const emit = vi.fn();
			const registry = s1_createCueSessionRegistry();
			// Pre-mark the once-key as fired (simulates a hot-reload that re-creates
			// the source while another instance has already claimed the dedup slot).
			// The key includes fire_at, so pre-mark with the same instant the source uses.
			expect(registry.markOnceFired('session-1', 'once-task', '2026-03-09T09:00:00Z')).toBe(true);
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z' }),
				registry,
				enabled: () => true,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct: vi.fn(),
			})!;
			source.start();
			// markOnceFired returned false → the new source stops itself without emitting.
			expect(emit).not.toHaveBeenCalled();
			vi.advanceTimersByTime(30000);
			expect(emit).not.toHaveBeenCalled();
			source.stop();
		});
		it('self-destructs (without emitting) when the fire-time filter does not match', () => {
			// At fire time the sub is consumed (markOnceFired) but the filter rejects
			// the event. It can never fire, so it must request self-destruct rather
			// than leave a stranded YAML entry.
			vi.setSystemTime(new Date('2026-03-09T09:05:00Z'));
			const emit = vi.fn();
			const requestSelfDestruct = vi.fn();
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({
					fire_at: '2026-03-09T09:00:00Z',
					filter: { nonexistent_field: 'never-matches' },
				}),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct,
			})!;
			source.start();
			expect(emit).not.toHaveBeenCalled();
			expect(requestSelfDestruct).toHaveBeenCalledOnce();
			expect(requestSelfDestruct).toHaveBeenCalledWith('once-task', 'filtered');
			source.stop();
		});
		it('re-fires a same-named sub when fire_at differs (dedup keyed by instance)', () => {
			// A prior time.once fired and self-destructed; the user schedules a new
			// one reusing the name. The dedup key includes fire_at, so the fresh
			// instance must still fire within the same process.
			vi.setSystemTime(new Date('2026-03-09T11:00:00Z'));
			const registry = s1_createCueSessionRegistry();
			const firstEmit = vi.fn();
			const first = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z' }),
				registry,
				enabled: () => true,
				onLog: vi.fn(),
				emit: firstEmit,
				requestSelfDestruct: vi.fn(),
			})!;
			first.start();
			expect(firstEmit).toHaveBeenCalledOnce();
			first.stop();
			const secondEmit = vi.fn();
			const second = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T10:00:00Z' }),
				registry,
				enabled: () => true,
				onLog: vi.fn(),
				emit: secondEmit,
				requestSelfDestruct: vi.fn(),
			})!;
			second.start();
			expect(secondEmit).toHaveBeenCalledOnce();
			second.stop();
		});
		it('returns null and logs once when fire_at is an unparseable string', () => {
			const onLog = vi.fn();
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: 'not-a-real-date' }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog,
				emit: vi.fn(),
				requestSelfDestruct: vi.fn(),
			});
			expect(source).toBeNull();
			expect(onLog).toHaveBeenCalledOnce();
			expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('unparseable fire_at'));
		});
		it('returns null when fire_at is missing entirely', () => {
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: undefined }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit: vi.fn(),
				requestSelfDestruct: vi.fn(),
			});
			expect(source).toBeNull();
		});
		it('does not fire when enabled() returns false', () => {
			vi.setSystemTime(new Date('2026-03-09T09:05:00Z'));
			const emit = vi.fn();
			const requestSelfDestruct = vi.fn();
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z' }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => false,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct,
			})!;
			source.start();
			expect(emit).not.toHaveBeenCalled();
			expect(requestSelfDestruct).not.toHaveBeenCalled();
			source.stop();
		});
		it('start() and stop() are idempotent', () => {
			vi.setSystemTime(new Date('2026-03-09T08:00:00Z'));
			const emit = vi.fn();
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z' }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct: vi.fn(),
			})!;
			source.start();
			source.start(); // no-op
			expect(emit).not.toHaveBeenCalled();
			source.stop();
			expect(() => source.stop()).not.toThrow();
		});
		it('fires on a later poll tick once fire_at arrives', () => {
			// Start before fire_at, then advance the fake clock past it.
			vi.setSystemTime(new Date('2026-03-09T08:59:00Z'));
			const emit = vi.fn();
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z' }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
				requestSelfDestruct: vi.fn(),
			})!;
			source.start();
			expect(emit).not.toHaveBeenCalled();
			// First 30s tick: 08:59:30 - still in the future.
			vi.advanceTimersByTime(30000);
			expect(emit).not.toHaveBeenCalled();
			// Second tick: 09:00:00 - fire.
			vi.advanceTimersByTime(30000);
			expect(emit).toHaveBeenCalledOnce();
			// Third tick: timer already cleared, no further fires.
			vi.advanceTimersByTime(30000);
			expect(emit).toHaveBeenCalledOnce();
			source.stop();
		});
		it('nextTriggerAt() reports null after the source fires', () => {
			vi.setSystemTime(new Date('2026-03-09T09:05:00Z'));
			const source = createCueOnceTriggerSource({
				session: makeSession(),
				subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z' }),
				registry: s1_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit: vi.fn(),
				requestSelfDestruct: vi.fn(),
			})!;
			expect(source.nextTriggerAt()).toBe(Date.parse('2026-03-09T09:00:00Z'));
			source.start();
			expect(source.nextTriggerAt()).toBeNull();
			source.stop();
		});
	});
});
describe('cue-scheduled-trigger-source', () => {
	function makeSession(): S2_SessionInfo {
		return {
			id: 'session-1',
			name: 'Test',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
		};
	}
	function makeSub(overrides: Partial<S2_CueSubscription> = {}): S2_CueSubscription {
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
				registry: s2_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit: vi.fn(),
			});
			expect(source).toBeNull();
		});
		it('fires when the polling tick lands on a scheduled minute', () => {
			// Local Monday 08:59 - 1 minute before the scheduled 09:00.
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));
			const emit = vi.fn();
			const source = createCueScheduledTriggerSource({
				session: makeSession(),
				subscription: makeSub({ schedule_times: ['09:00'] }),
				registry: s2_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
			})!;
			source.start();
			expect(emit).not.toHaveBeenCalled();
			// Advance the fake clock by 60s. vitest moves the system clock and fires
			// any due timers; inside the firing the clock reads as 09:00 local time.
			vi.advanceTimersByTime(60000);
			expect(emit).toHaveBeenCalledOnce();
			const event = emit.mock.calls[0][0] as S2_CueEvent;
			expect(event.type).toBe('time.scheduled');
			expect(event.payload.matched_time).toBe('09:00');
			source.stop();
		});
		it('does NOT re-fire within the same minute (registry dedup)', () => {
			// Start at 08:59:00 local. First tick lands at 09:00:00.
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));
			const registry = s2_createCueSessionRegistry();
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
			vi.advanceTimersByTime(60000);
			expect(emit).toHaveBeenCalledTimes(1);
			// A second poll-interval tick lands at ~09:01. The current time is no
			// longer "09:00", so the dedup branch is short-circuited by the time-not-
			// matched check, not by markScheduledFired. To exercise the dedup path
			// directly we'd need a sub-minute polling cadence; instead this test
			// asserts that the first fire is one-shot and the second tick stays cold.
			vi.advanceTimersByTime(60000);
			expect(emit).toHaveBeenCalledTimes(1);
			source.stop();
		});
		it('skips the fire when the day-of-week filter does not match', () => {
			// Monday - only Wed allowed.
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));
			const emit = vi.fn();
			const source = createCueScheduledTriggerSource({
				session: makeSession(),
				subscription: makeSub({ schedule_times: ['09:00'], schedule_days: ['wed'] }),
				registry: s2_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit,
			})!;
			source.start();
			vi.advanceTimersByTime(60000);
			expect(emit).not.toHaveBeenCalled();
			source.stop();
		});
		it('does not fire when enabled() returns false', () => {
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));
			const emit = vi.fn();
			const source = createCueScheduledTriggerSource({
				session: makeSession(),
				subscription: makeSub({ schedule_times: ['09:00'] }),
				registry: s2_createCueSessionRegistry(),
				enabled: () => false,
				onLog: vi.fn(),
				emit,
			})!;
			source.start();
			vi.advanceTimersByTime(60000);
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
				registry: s2_createCueSessionRegistry(),
				enabled: () => true,
				onLog,
				emit,
			})!;
			source.start();
			vi.advanceTimersByTime(60000);
			expect(emit).not.toHaveBeenCalled();
			expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));
			source.stop();
		});
		it('nextTriggerAt() reports the next scheduled time after start', () => {
			// Local Monday 08:00 - next 09:00 is 1 hour ahead, same local day.
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));
			const source = createCueScheduledTriggerSource({
				session: makeSession(),
				subscription: makeSub({ schedule_times: ['09:00'] }),
				registry: s2_createCueSessionRegistry(),
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
		it('onTimeZoneChange() recomputes the next-fire projection', () => {
			// Local Monday 08:00, next fire 09:00 the same day.
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));
			const source = createCueScheduledTriggerSource({
				session: makeSession(),
				subscription: makeSub({ schedule_times: ['09:00'] }),
				registry: s2_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit: vi.fn(),
			})!;
			source.start();
			expect(new Date(source.nextTriggerAt()!).getDate()).toBe(9);
			// Stand-in for the wall clock jumping past today's slot, which is what a
			// zone change does. Without the recompute the projection would still
			// advertise a fire time that has already gone by.
			vi.setSystemTime(new Date('2026-03-09T10:00:00'));
			source.onTimeZoneChange!();
			const next = new Date(source.nextTriggerAt()!);
			expect(next.getHours()).toBe(9);
			expect(next.getDate()).toBe(10); // rolled to tomorrow
			source.stop();
		});
		it('onTimeZoneChange() leaves a stopped source dormant', () => {
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));
			const source = createCueScheduledTriggerSource({
				session: makeSession(),
				subscription: makeSub({ schedule_times: ['09:00'] }),
				registry: s2_createCueSessionRegistry(),
				enabled: () => true,
				onLog: vi.fn(),
				emit: vi.fn(),
			})!;
			source.onTimeZoneChange!();
			expect(source.nextTriggerAt()).toBeNull();
		});
		it('start() and stop() are idempotent', () => {
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));
			const source = createCueScheduledTriggerSource({
				session: makeSession(),
				subscription: makeSub({ schedule_times: ['09:00'] }),
				registry: s2_createCueSessionRegistry(),
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
});
