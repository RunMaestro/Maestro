/**
 * Tests for the Cue Time Event Reconciler (cue-reconciler.ts).
 *
 * Tests cover:
 * - Missed interval calculation
 * - Single catch-up event per subscription (no flooding)
 * - Skipping file.changed and agent.completed events
 * - Skipping disabled subscriptions
 * - Reconciled payload metadata (reconciled: true, missedCount)
 * - Zero-gap and negative-gap edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { reconcileMissedTimeEvents } from '../../../main/cue/cue-reconciler';
import type { ReconcileConfig, ReconcileSessionInfo } from '../../../main/cue/cue-reconciler';
import type { CueConfig, CueEvent, CueSubscription } from '../../../main/cue/cue-types';

function createConfig(subscriptions: CueSubscription[]): CueConfig {
	return {
		subscriptions,
		settings: { timeout_minutes: 30, timeout_on_fail: 'break', max_concurrent: 1, queue_size: 10 },
	};
}

describe('reconcileMissedTimeEvents', () => {
	let dispatched: Array<{ sessionId: string; sub: CueSubscription; event: CueEvent }>;
	let logged: Array<{ level: string; message: string }>;

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
		function bracketTodayAt9am(): { sleepStartMs: number; wakeTimeMs: number } {
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
