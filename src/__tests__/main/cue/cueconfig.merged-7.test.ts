// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/cue/cue-reconciler.test.ts
// Source: src/__tests__/main/cue/cue-filter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileMissedTimeEvents } from '../../../main/cue/cue-reconciler';
import type { ReconcileConfig, ReconcileSessionInfo } from '../../../main/cue/cue-reconciler';
import type { CueConfig, CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import { matchesFilter, describeFilter } from '../../../main/cue/cue-filter';
// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));
// Source: src/__tests__/main/cue/cue-reconciler.test.ts
describe('', () => {
	function createConfig(subscriptions: CueSubscription[]): CueConfig {
		return {
			subscriptions,
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		};
	}
	describe('reconcileMissedTimeEvents', () => {
		let dispatched: Array<{
			sessionId: string;
			sub: CueSubscription;
			event: CueEvent;
		}>;
		let logged: Array<{
			level: string;
			message: string;
		}>;
		beforeEach(() => {
			dispatched = [];
			logged = [];
		});
		function makeConfig(overrides: Partial<ReconcileConfig> = {}): ReconcileConfig {
			return {
				sleepStartMs: Date.now() - 60 * 60 * 1000, // 1 hour ago
				wakeTimeMs: Date.now(),
				sessions: new Map(),
				onDispatch: (sessionId, sub, event) => {
					dispatched.push({ sessionId, sub, event });
				},
				onLog: (level, message) => {
					logged.push({ level, message });
				},
				...overrides,
			};
		}
		it('skips heartbeats but still catches up scheduled slots when skipHeartbeats is set', () => {
			// At engine start each heartbeat already fires once; a catch-up on top
			// of it ran the same subscription twice within a second.
			const sessions = new Map<string, ReconcileSessionInfo>();
			const hour = new Date(Date.now() - 30 * 60 * 1000);
			const hhmm = `${String(hour.getHours()).padStart(2, '0')}:${String(hour.getMinutes()).padStart(2, '0')}`;
			sessions.set('session-1', {
				config: createConfig([
					{ name: 'hb', event: 'time.heartbeat', enabled: true, prompt: 'x', interval_minutes: 15 },
					{
						name: 'daily',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'x',
						schedule_times: [hhmm],
					},
				]),
				sessionName: 'Test Session',
			});
			reconcileMissedTimeEvents(makeConfig({ sessions, skipHeartbeats: true }));
			expect(dispatched.map((d) => d.sub.name)).toEqual(['daily']);
		});
		it('should fire one catch-up event for a missed interval', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'every-15m',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'check status',
						interval_minutes: 15,
					},
				]),
				sessionName: 'Test Session',
			});
			// Sleep for 1 hour means 4 intervals of 15m were missed
			const config = makeConfig({
				sleepStartMs: Date.now() - 60 * 60 * 1000,
				wakeTimeMs: Date.now(),
				sessions,
			});
			reconcileMissedTimeEvents(config);
			// Should fire exactly one catch-up event (not 4)
			expect(dispatched).toHaveLength(1);
			expect(dispatched[0].sessionId).toBe('session-1');
			expect(dispatched[0].event.type).toBe('time.heartbeat');
			expect(dispatched[0].event.triggerName).toBe('every-15m');
			expect(dispatched[0].event.payload.reconciled).toBe(true);
			expect(dispatched[0].event.payload.missedCount).toBe(4);
		});
		it('should skip when no intervals were missed', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'every-2h',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'long check',
						interval_minutes: 120,
					},
				]),
				sessionName: 'Test Session',
			});
			// Sleep for 30 minutes - interval is 2 hours, so 0 missed
			const config = makeConfig({
				sleepStartMs: Date.now() - 30 * 60 * 1000,
				wakeTimeMs: Date.now(),
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(dispatched).toHaveLength(0);
		});
		it('should not reconcile file.changed subscriptions', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'file-watcher',
						event: 'file.changed',
						enabled: true,
						prompt: 'check files',
						watch: 'src/**/*.ts',
					},
				]),
				sessionName: 'Test Session',
			});
			const config = makeConfig({
				sleepStartMs: Date.now() - 60 * 60 * 1000,
				wakeTimeMs: Date.now(),
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(dispatched).toHaveLength(0);
		});
		it('should not reconcile agent.completed subscriptions', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'chain-reaction',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'other-agent',
					},
				]),
				sessionName: 'Test Session',
			});
			const config = makeConfig({
				sleepStartMs: Date.now() - 60 * 60 * 1000,
				wakeTimeMs: Date.now(),
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(dispatched).toHaveLength(0);
		});
		it('should skip disabled subscriptions', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'disabled-timer',
						event: 'time.heartbeat',
						enabled: false,
						prompt: 'disabled',
						interval_minutes: 5,
					},
				]),
				sessionName: 'Test Session',
			});
			const config = makeConfig({
				sleepStartMs: Date.now() - 60 * 60 * 1000,
				wakeTimeMs: Date.now(),
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(dispatched).toHaveLength(0);
		});
		it('should handle multiple sessions with multiple subscriptions', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'fast-timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'fast check',
						interval_minutes: 10,
					},
					{
						name: 'slow-timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'slow check',
						interval_minutes: 60,
					},
					{
						name: 'file-watcher',
						event: 'file.changed',
						enabled: true,
						prompt: 'watch files',
						watch: '*.ts',
					},
				]),
				sessionName: 'Session A',
			});
			sessions.set('session-2', {
				config: createConfig([
					{
						name: 'another-timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'another check',
						interval_minutes: 30,
					},
				]),
				sessionName: 'Session B',
			});
			// 90 minutes of sleep
			const config = makeConfig({
				sleepStartMs: Date.now() - 90 * 60 * 1000,
				wakeTimeMs: Date.now(),
				sessions,
			});
			reconcileMissedTimeEvents(config);
			// fast-timer: 90/10 = 9 missed → 1 catch-up
			// slow-timer: 90/60 = 1 missed → 1 catch-up
			// file-watcher: skipped (not time.heartbeat)
			// another-timer: 90/30 = 3 missed → 1 catch-up
			expect(dispatched).toHaveLength(3);
			const fastTimer = dispatched.find((d) => d.event.triggerName === 'fast-timer');
			expect(fastTimer?.event.payload.missedCount).toBe(9);
			const slowTimer = dispatched.find((d) => d.event.triggerName === 'slow-timer');
			expect(slowTimer?.event.payload.missedCount).toBe(1);
			const anotherTimer = dispatched.find((d) => d.event.triggerName === 'another-timer');
			expect(anotherTimer?.event.payload.missedCount).toBe(3);
			expect(anotherTimer?.sessionId).toBe('session-2');
		});
		it('should include sleepDurationMs in the event payload', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'check',
						interval_minutes: 5,
					},
				]),
				sessionName: 'Test',
			});
			const sleepDuration = 60 * 60 * 1000; // 1 hour
			const wakeTimeMs = Date.now();
			const config = makeConfig({
				sleepStartMs: wakeTimeMs - sleepDuration,
				wakeTimeMs,
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(dispatched[0].event.payload.sleepDurationMs).toBe(sleepDuration);
		});
		it('should do nothing with zero gap', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'check',
						interval_minutes: 5,
					},
				]),
				sessionName: 'Test',
			});
			const now = Date.now();
			const config = makeConfig({
				sleepStartMs: now,
				wakeTimeMs: now,
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(dispatched).toHaveLength(0);
		});
		it('should do nothing with negative gap', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'check',
						interval_minutes: 5,
					},
				]),
				sessionName: 'Test',
			});
			const now = Date.now();
			const config = makeConfig({
				sleepStartMs: now,
				wakeTimeMs: now - 1000, // Wake before sleep (shouldn't happen, but edge case)
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(dispatched).toHaveLength(0);
		});
		it('should log reconciliation for each fired catch-up', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'my-timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'check',
						interval_minutes: 10,
					},
				]),
				sessionName: 'Test',
			});
			const config = makeConfig({
				sleepStartMs: Date.now() - 60 * 60 * 1000,
				wakeTimeMs: Date.now(),
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(logged.some((l) => l.message.includes('Reconciling "my-timer"'))).toBe(true);
			expect(logged.some((l) => l.message.includes('6 interval(s) missed'))).toBe(true);
		});
		it('should skip subscriptions with zero interval_minutes', () => {
			const sessions = new Map<string, ReconcileSessionInfo>();
			sessions.set('session-1', {
				config: createConfig([
					{
						name: 'zero-interval',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'check',
						interval_minutes: 0,
					},
				]),
				sessionName: 'Test',
			});
			const config = makeConfig({
				sleepStartMs: Date.now() - 60 * 60 * 1000,
				wakeTimeMs: Date.now(),
				sessions,
			});
			reconcileMissedTimeEvents(config);
			expect(dispatched).toHaveLength(0);
		});
		describe('time.scheduled reconciliation', () => {
			// Build a (sleepStartMs, wakeTimeMs) pair that brackets a single 09:00
			// local-time slot, regardless of when the test runs. We anchor "wake" at
			// 10:00 today and "sleep start" at 08:00 today so 09:00 today is the
			// only candidate.
			function bracketTodayAt9am(): {
				sleepStartMs: number;
				wakeTimeMs: number;
			} {
				const wake = new Date();
				wake.setHours(10, 0, 0, 0);
				const sleepStart = new Date(wake);
				sleepStart.setHours(8, 0, 0, 0);
				return { sleepStartMs: sleepStart.getTime(), wakeTimeMs: wake.getTime() };
			}
			it('fires one catch-up for a single missed scheduled slot', () => {
				const { sleepStartMs, wakeTimeMs } = bracketTodayAt9am();
				const sessions = new Map<string, ReconcileSessionInfo>();
				sessions.set('session-1', {
					config: createConfig([
						{
							name: 'daily-standup',
							event: 'time.scheduled',
							enabled: true,
							prompt: 'run standup',
							schedule_times: ['09:00'],
						},
					]),
					sessionName: 'Test',
				});
				const config = makeConfig({ sleepStartMs, wakeTimeMs, sessions });
				reconcileMissedTimeEvents(config);
				expect(dispatched).toHaveLength(1);
				expect(dispatched[0].event.type).toBe('time.scheduled');
				expect(dispatched[0].event.triggerName).toBe('daily-standup');
				expect(dispatched[0].event.payload).toMatchObject({
					reconciled: true,
					missedCount: 1,
					matched_time: '09:00',
				});
			});
			it('fires one catch-up for the MOST RECENT slot when multiple are missed', () => {
				// Sleep across a full week with a daily 09:00 schedule - should fire
				// once for the most recent 09:00, not once per day.
				const wake = new Date();
				wake.setHours(10, 0, 0, 0);
				const sleepStart = new Date(wake);
				sleepStart.setDate(sleepStart.getDate() - 5);
				sleepStart.setHours(8, 0, 0, 0);
				const sessions = new Map<string, ReconcileSessionInfo>();
				sessions.set('session-1', {
					config: createConfig([
						{
							name: 'daily-09',
							event: 'time.scheduled',
							enabled: true,
							prompt: 'daily',
							schedule_times: ['09:00'],
						},
					]),
					sessionName: 'Test',
				});
				const config = makeConfig({
					sleepStartMs: sleepStart.getTime(),
					wakeTimeMs: wake.getTime(),
					sessions,
				});
				reconcileMissedTimeEvents(config);
				expect(dispatched).toHaveLength(1);
				expect(dispatched[0].event.payload.missedCount).toBe(6); // 6 daily 09:00 slots in 5d gap
				const mostRecentMs = dispatched[0].event.payload.mostRecentSlotMs as number;
				// Most-recent slot should be today's 09:00.
				const todayAt9 = new Date(wake);
				todayAt9.setHours(9, 0, 0, 0);
				expect(mostRecentMs).toBe(todayAt9.getTime());
			});
			it('respects schedule_days filter', () => {
				// Schedule only fires on Wednesday. Pick a Tuesday 10:00 wake with
				// Tuesday 08:00 sleep start so the candidate Tue 09:00 should be
				// filtered out.
				const wake = new Date();
				// Walk to next Tuesday so the test is deterministic regardless of
				// the day it runs.
				while (wake.getDay() !== 2) wake.setDate(wake.getDate() + 1);
				wake.setHours(10, 0, 0, 0);
				const sleepStart = new Date(wake);
				sleepStart.setHours(8, 0, 0, 0);
				const sessions = new Map<string, ReconcileSessionInfo>();
				sessions.set('session-1', {
					config: createConfig([
						{
							name: 'wed-only',
							event: 'time.scheduled',
							enabled: true,
							prompt: 'wed only',
							schedule_times: ['09:00'],
							schedule_days: ['wed'],
						},
					]),
					sessionName: 'Test',
				});
				const config = makeConfig({
					sleepStartMs: sleepStart.getTime(),
					wakeTimeMs: wake.getTime(),
					sessions,
				});
				reconcileMissedTimeEvents(config);
				expect(dispatched).toHaveLength(0);
			});
			it('does not double-fire when wake lands exactly on a slot boundary', () => {
				// If wakeTimeMs == slot timestamp, the live trigger source will fire
				// it on its next 60s tick - the reconciler must not also fire.
				const wake = new Date();
				wake.setHours(9, 0, 0, 0); // wake AT 09:00 exactly
				const sleepStart = new Date(wake);
				sleepStart.setHours(7, 0, 0, 0);
				const sessions = new Map<string, ReconcileSessionInfo>();
				sessions.set('session-1', {
					config: createConfig([
						{
							name: 'at-9',
							event: 'time.scheduled',
							enabled: true,
							prompt: 'at 9',
							schedule_times: ['09:00'],
						},
					]),
					sessionName: 'Test',
				});
				const config = makeConfig({
					sleepStartMs: sleepStart.getTime(),
					wakeTimeMs: wake.getTime(),
					sessions,
				});
				reconcileMissedTimeEvents(config);
				expect(dispatched).toHaveLength(0);
			});
			it('skips disabled time.scheduled subscriptions', () => {
				const { sleepStartMs, wakeTimeMs } = bracketTodayAt9am();
				const sessions = new Map<string, ReconcileSessionInfo>();
				sessions.set('session-1', {
					config: createConfig([
						{
							name: 'off',
							event: 'time.scheduled',
							enabled: false,
							prompt: 'off',
							schedule_times: ['09:00'],
						},
					]),
					sessionName: 'Test',
				});
				reconcileMissedTimeEvents(makeConfig({ sleepStartMs, wakeTimeMs, sessions }));
				expect(dispatched).toHaveLength(0);
			});
			it('skips when schedule_times is empty', () => {
				const { sleepStartMs, wakeTimeMs } = bracketTodayAt9am();
				const sessions = new Map<string, ReconcileSessionInfo>();
				sessions.set('session-1', {
					config: createConfig([
						{
							name: 'empty',
							event: 'time.scheduled',
							enabled: true,
							prompt: 'empty',
							schedule_times: [],
						},
					]),
					sessionName: 'Test',
				});
				reconcileMissedTimeEvents(makeConfig({ sleepStartMs, wakeTimeMs, sessions }));
				expect(dispatched).toHaveLength(0);
			});
			it('ignores invalid HH:MM strings in schedule_times', () => {
				const { sleepStartMs, wakeTimeMs } = bracketTodayAt9am();
				const sessions = new Map<string, ReconcileSessionInfo>();
				sessions.set('session-1', {
					config: createConfig([
						{
							name: 'bad-time',
							event: 'time.scheduled',
							enabled: true,
							prompt: 'bad',
							schedule_times: ['25:99', 'abc', '09:00'],
						},
					]),
					sessionName: 'Test',
				});
				reconcileMissedTimeEvents(makeConfig({ sleepStartMs, wakeTimeMs, sessions }));
				// Only 09:00 is a valid candidate inside the bracket → exactly one fire.
				expect(dispatched).toHaveLength(1);
				expect(dispatched[0].event.payload.matched_time).toBe('09:00');
			});
		});
	});
});
// Source: src/__tests__/main/cue/cue-filter.test.ts
describe('', () => {
	describe('cue-filter', () => {
		describe('matchesFilter', () => {
			describe('exact string matching', () => {
				it('matches exact string values', () => {
					expect(matchesFilter({ extension: '.ts' }, { extension: '.ts' })).toBe(true);
				});
				it('rejects non-matching string values', () => {
					expect(matchesFilter({ extension: '.js' }, { extension: '.ts' })).toBe(false);
				});
				it('coerces payload value to string for comparison', () => {
					expect(matchesFilter({ count: 42 }, { count: '42' })).toBe(true);
				});
			});
			describe('negation (!value)', () => {
				it('matches when value does not equal', () => {
					expect(matchesFilter({ status: 'active' }, { status: '!archived' })).toBe(true);
				});
				it('rejects when value equals the negated term', () => {
					expect(matchesFilter({ status: 'archived' }, { status: '!archived' })).toBe(false);
				});
			});
			describe('numeric comparisons', () => {
				it('matches greater than', () => {
					expect(matchesFilter({ size: 1500 }, { size: '>1000' })).toBe(true);
				});
				it('rejects not greater than', () => {
					expect(matchesFilter({ size: 500 }, { size: '>1000' })).toBe(false);
				});
				it('rejects equal for greater than', () => {
					expect(matchesFilter({ size: 1000 }, { size: '>1000' })).toBe(false);
				});
				it('matches less than', () => {
					expect(matchesFilter({ priority: 3 }, { priority: '<5' })).toBe(true);
				});
				it('rejects not less than', () => {
					expect(matchesFilter({ priority: 7 }, { priority: '<5' })).toBe(false);
				});
				it('matches greater than or equal', () => {
					expect(matchesFilter({ score: 100 }, { score: '>=100' })).toBe(true);
					expect(matchesFilter({ score: 101 }, { score: '>=100' })).toBe(true);
				});
				it('rejects less than for >=', () => {
					expect(matchesFilter({ score: 99 }, { score: '>=100' })).toBe(false);
				});
				it('matches less than or equal', () => {
					expect(matchesFilter({ count: 10 }, { count: '<=10' })).toBe(true);
					expect(matchesFilter({ count: 9 }, { count: '<=10' })).toBe(true);
				});
				it('rejects greater than for <=', () => {
					expect(matchesFilter({ count: 11 }, { count: '<=10' })).toBe(false);
				});
				it('handles string payload values with numeric comparison', () => {
					expect(matchesFilter({ size: '1500' }, { size: '>1000' })).toBe(true);
				});
			});
			describe('glob pattern matching', () => {
				it('matches simple glob patterns', () => {
					expect(matchesFilter({ path: 'file.ts' }, { path: '*.ts' })).toBe(true);
				});
				it('rejects non-matching glob patterns', () => {
					expect(matchesFilter({ path: 'file.js' }, { path: '*.ts' })).toBe(false);
				});
				it('matches complex glob patterns', () => {
					expect(
						matchesFilter({ path: 'src/components/Button.tsx' }, { path: 'src/**/*.tsx' })
					).toBe(true);
				});
				it('rejects non-matching complex patterns', () => {
					expect(matchesFilter({ path: 'test/Button.tsx' }, { path: 'src/**/*.tsx' })).toBe(false);
				});
			});
			describe('boolean matching', () => {
				it('matches true boolean', () => {
					expect(matchesFilter({ active: true }, { active: true })).toBe(true);
				});
				it('rejects false when expecting true', () => {
					expect(matchesFilter({ active: false }, { active: true })).toBe(false);
				});
				it('matches false boolean', () => {
					expect(matchesFilter({ active: false }, { active: false })).toBe(true);
				});
				it('rejects true when expecting false', () => {
					expect(matchesFilter({ active: true }, { active: false })).toBe(false);
				});
			});
			describe('numeric equality', () => {
				it('matches exact numeric values', () => {
					expect(matchesFilter({ exitCode: 0 }, { exitCode: 0 })).toBe(true);
				});
				it('rejects non-matching numeric values', () => {
					expect(matchesFilter({ exitCode: 1 }, { exitCode: 0 })).toBe(false);
				});
			});
			describe('dot-notation nested access', () => {
				it('resolves nested payload fields', () => {
					const payload = { source: { status: 'completed' } };
					expect(matchesFilter(payload, { 'source.status': 'completed' })).toBe(true);
				});
				it('returns false for missing nested path', () => {
					const payload = { source: {} };
					expect(matchesFilter(payload, { 'source.status': 'completed' })).toBe(false);
				});
				it('handles deeply nested access', () => {
					const payload = { a: { b: { c: 'deep' } } };
					expect(matchesFilter(payload, { 'a.b.c': 'deep' })).toBe(true);
				});
			});
			describe('AND logic', () => {
				it('requires all conditions to pass', () => {
					const payload = { extension: '.ts', changeType: 'change', path: 'src/index.ts' };
					const filter = { extension: '.ts', changeType: 'change' };
					expect(matchesFilter(payload, filter)).toBe(true);
				});
				it('fails if any condition does not pass', () => {
					const payload = { extension: '.js', changeType: 'change' };
					const filter = { extension: '.ts', changeType: 'change' };
					expect(matchesFilter(payload, filter)).toBe(false);
				});
			});
			describe('missing payload fields', () => {
				it('fails when payload field is undefined', () => {
					expect(matchesFilter({}, { extension: '.ts' })).toBe(false);
				});
				it('fails when nested payload field is undefined', () => {
					expect(matchesFilter({ source: {} }, { 'source.missing': 'value' })).toBe(false);
				});
			});
			describe('NaN handling in numeric comparisons', () => {
				it('rejects non-numeric payload value with > filter', () => {
					expect(matchesFilter({ size: 'abc' }, { size: '>5' })).toBe(false);
				});
				it('rejects non-numeric payload value with >= filter', () => {
					expect(matchesFilter({ size: 'abc' }, { size: '>=5' })).toBe(false);
				});
				it('rejects non-numeric payload value with < filter', () => {
					expect(matchesFilter({ size: 'abc' }, { size: '<5' })).toBe(false);
				});
				it('rejects non-numeric payload value with <= filter', () => {
					expect(matchesFilter({ size: 'abc' }, { size: '<=5' })).toBe(false);
				});
				it('rejects non-numeric threshold in >= filter', () => {
					expect(matchesFilter({ size: 100 }, { size: '>=abc' })).toBe(false);
				});
				it('rejects non-numeric threshold in > filter', () => {
					expect(matchesFilter({ size: 100 }, { size: '>abc' })).toBe(false);
				});
				it('rejects non-numeric threshold in < filter', () => {
					expect(matchesFilter({ size: 100 }, { size: '<abc' })).toBe(false);
				});
				it('rejects non-numeric threshold in <= filter', () => {
					expect(matchesFilter({ size: 100 }, { size: '<=abc' })).toBe(false);
				});
				it('rejects empty string payload value with numeric filter', () => {
					expect(matchesFilter({ size: '' }, { size: '>0' })).toBe(false);
				});
				it('rejects empty string payload that would coerce to 0 with >=0 filter', () => {
					// Number('') === 0, but empty string is not a valid numeric operand
					expect(matchesFilter({ size: '' }, { size: '>=0' })).toBe(false);
				});
				it('rejects null payload value with numeric filter', () => {
					expect(matchesFilter({ size: null }, { size: '>=0' })).toBe(false);
				});
				it('rejects whitespace-only string with numeric filter', () => {
					expect(matchesFilter({ size: '  ' }, { size: '>0' })).toBe(false);
				});
				it('rejects Infinity payload value with numeric filter', () => {
					expect(matchesFilter({ size: Infinity }, { size: '>0' })).toBe(false);
				});
				it('rejects -Infinity payload value with numeric filter', () => {
					expect(matchesFilter({ size: -Infinity }, { size: '>0' })).toBe(false);
				});
				it('rejects NaN payload value with numeric filter', () => {
					expect(matchesFilter({ size: NaN }, { size: '>0' })).toBe(false);
				});
				it('rejects NaN threshold in filter expression', () => {
					expect(matchesFilter({ size: 100 }, { size: '>NaN' })).toBe(false);
				});
				it('rejects empty threshold in filter expression', () => {
					// filterValue '>=' sliced to '' → Number('') = 0, but should reject
					expect(matchesFilter({ size: 5 }, { size: '>=' })).toBe(false);
				});
				it('handles boolean payload coercion with numeric filter', () => {
					// Number(true) === 1, so true > 0 should pass
					expect(matchesFilter({ active: true }, { active: '>0' })).toBe(true);
					// Number(false) === 0, so false > 0 should fail
					expect(matchesFilter({ active: false }, { active: '>0' })).toBe(false);
				});
			});
			describe('empty filter', () => {
				it('matches everything when filter is empty', () => {
					expect(matchesFilter({ any: 'value' }, {})).toBe(true);
					expect(matchesFilter({}, {})).toBe(true);
				});
			});
		});
		describe('combined filter conditions', () => {
			it('combined numeric + glob in same filter object', () => {
				expect(
					matchesFilter({ size: 1500, path: 'src/app.ts' }, { size: '>1000', path: 'src/**/*.ts' })
				).toBe(true);
				expect(
					matchesFilter({ size: 500, path: 'src/app.ts' }, { size: '>1000', path: 'src/**/*.ts' })
				).toBe(false);
			});
		});
		describe('unicode handling', () => {
			it('matches unicode strings exactly', () => {
				expect(matchesFilter({ name: '日本語' }, { name: '日本語' })).toBe(true);
				expect(matchesFilter({ name: '日本語' }, { name: '中文' })).toBe(false);
			});
		});
		describe('deep dot notation', () => {
			it('resolves 4-level deep path', () => {
				expect(matchesFilter({ a: { b: { c: { d: 'found' } } } }, { 'a.b.c.d': 'found' })).toBe(
					true
				);
			});
			it('returns false for partial path', () => {
				expect(matchesFilter({ a: { b: 42 } }, { 'a.b.c': 'anything' })).toBe(false);
			});
		});
		describe('describeFilter', () => {
			it('describes exact string match', () => {
				expect(describeFilter({ extension: '.ts' })).toBe('extension == ".ts"');
			});
			it('describes negation', () => {
				expect(describeFilter({ status: '!archived' })).toBe('status != archived');
			});
			it('describes greater than', () => {
				expect(describeFilter({ size: '>1000' })).toBe('size > 1000');
			});
			it('describes less than', () => {
				expect(describeFilter({ priority: '<5' })).toBe('priority < 5');
			});
			it('describes greater than or equal', () => {
				expect(describeFilter({ score: '>=100' })).toBe('score >= 100');
			});
			it('describes less than or equal', () => {
				expect(describeFilter({ count: '<=10' })).toBe('count <= 10');
			});
			it('describes glob pattern', () => {
				expect(describeFilter({ path: '*.ts' })).toBe('path matches *.ts');
			});
			it('describes boolean', () => {
				expect(describeFilter({ active: true })).toBe('active is true');
			});
			it('describes numeric equality', () => {
				expect(describeFilter({ exitCode: 0 })).toBe('exitCode == 0');
			});
			it('joins multiple conditions with AND', () => {
				const result = describeFilter({ extension: '.ts', status: '!archived' });
				expect(result).toBe('extension == ".ts" AND status != archived');
			});
		});
	});
});
