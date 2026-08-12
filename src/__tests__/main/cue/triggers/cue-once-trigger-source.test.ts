/**
 * Tests for the time.once trigger source.
 *
 * Pins down the fire-once semantics, missed-grace self-destruct path,
 * registry dedup against double-fires from poll overlap or hot reload, and the
 * invalid-fire_at safeguard that disables the source instead of crashing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCueOnceTriggerSource } from '../../../../main/cue/triggers/cue-once-trigger-source';
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
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
			requestSelfDestruct,
		})!;

		source.start();

		expect(emit).toHaveBeenCalledOnce();
		const event = emit.mock.calls[0][0] as CueEvent;
		expect(event.type).toBe('time.once');
		expect(event.payload.fire_at).toBe('2026-03-09T09:00:00Z');
		expect(event.payload.grace_minutes).toBe(360);
		expect(requestSelfDestruct).not.toHaveBeenCalled();

		// Subsequent ticks must not double-fire - the source stops its own timer
		// after firing.
		vi.advanceTimersByTime(60_000);
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
			registry: createCueSessionRegistry(),
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
		vi.advanceTimersByTime(30_000);
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
			registry: createCueSessionRegistry(),
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
			registry: createCueSessionRegistry(),
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
		const registry = createCueSessionRegistry();
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

		vi.advanceTimersByTime(30_000);
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
			registry: createCueSessionRegistry(),
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
		const registry = createCueSessionRegistry();

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
			registry: createCueSessionRegistry(),
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
			registry: createCueSessionRegistry(),
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
			registry: createCueSessionRegistry(),
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
			registry: createCueSessionRegistry(),
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
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
			requestSelfDestruct: vi.fn(),
		})!;

		source.start();
		expect(emit).not.toHaveBeenCalled();

		// First 30s tick: 08:59:30 - still in the future.
		vi.advanceTimersByTime(30_000);
		expect(emit).not.toHaveBeenCalled();

		// Second tick: 09:00:00 - fire.
		vi.advanceTimersByTime(30_000);
		expect(emit).toHaveBeenCalledOnce();

		// Third tick: timer already cleared, no further fires.
		vi.advanceTimersByTime(30_000);
		expect(emit).toHaveBeenCalledOnce();

		source.stop();
	});

	it('nextTriggerAt() reports null after the source fires', () => {
		vi.setSystemTime(new Date('2026-03-09T09:05:00Z'));
		const source = createCueOnceTriggerSource({
			session: makeSession(),
			subscription: makeSub({ fire_at: '2026-03-09T09:00:00Z' }),
			registry: createCueSessionRegistry(),
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
