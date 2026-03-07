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
					event: 'time.interval',
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
		expect(dispatched[0].event.type).toBe('time.interval');
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
					event: 'time.interval',
					enabled: true,
					prompt: 'long check',
					interval_minutes: 120,
				},
			]),
			sessionName: 'Test Session',
		});

		// Sleep for 30 minutes — interval is 2 hours, so 0 missed
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
					event: 'time.interval',
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
					event: 'time.interval',
					enabled: true,
					prompt: 'fast check',
					interval_minutes: 10,
				},
				{
					name: 'slow-timer',
					event: 'time.interval',
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
					event: 'time.interval',
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
		// file-watcher: skipped (not time.interval)
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
					event: 'time.interval',
					enabled: true,
					prompt: 'check',
					interval_minutes: 5,
				},
			]),
			sessionName: 'Test',
		});

		const sleepDuration = 60 * 60 * 1000; // 1 hour
		const config = makeConfig({
			sleepStartMs: Date.now() - sleepDuration,
			wakeTimeMs: Date.now(),
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
					event: 'time.interval',
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
					event: 'time.interval',
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
					event: 'time.interval',
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
					event: 'time.interval',
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
});
