/**
 * Tests for the presence.return / presence.leave trigger source.
 *
 * Drives a real CuePresenceMonitor through a fake OS signal provider so the
 * thresholds are exercised end to end: away_minutes gating, the settle
 * window, carrying a dropped return's absence forward, and dropping a leave
 * whose timer was frozen across a system sleep.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCuePresenceTriggerSource } from '../../../../main/cue/triggers/cue-presence-trigger-source';
import { createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import {
	installCuePresenceProvider,
	resetCuePresenceMonitor,
	type PresenceSignal,
	type PresenceSignalProvider,
} from '../../../../main/cue/cue-presence-monitor';
import type { CueEvent, CueSubscription } from '../../../../main/cue/cue-types';
import type { SessionInfo } from '../../../../shared/types';

const MIN = 60_000;

function makeSession(): SessionInfo {
	return { id: 'session-1', name: 'Test', toolType: 'claude-code', cwd: '/p', projectRoot: '/p' };
}

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'welcome-back',
		event: 'presence.return',
		enabled: true,
		prompt: 'catch me up',
		away_minutes: 30,
		...overrides,
	};
}

function installFakeProvider() {
	let idleSeconds = 0;
	let listener: ((signal: PresenceSignal) => void) | null = null;
	const provider: PresenceSignalProvider = {
		getSystemIdleSeconds: () => idleSeconds,
		subscribe: (l) => {
			listener = l;
			return () => {
				listener = null;
			};
		},
	};
	installCuePresenceProvider(provider);
	return {
		setIdleSeconds(value: number) {
			idleSeconds = value;
		},
		signal(signal: PresenceSignal) {
			listener?.(signal);
		},
	};
}

function startSource(sub: CueSubscription, enabled = () => true) {
	const emit = vi.fn<(event: CueEvent) => void>();
	const onLog = vi.fn();
	const source = createCuePresenceTriggerSource({
		session: makeSession(),
		subscription: sub,
		registry: createCueSessionRegistry(),
		enabled,
		onLog,
		emit,
	});
	if (!source) throw new Error('expected a source');
	source.start();
	return { source, emit, onLog };
}

describe('cue-presence-trigger-source', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-07T09:00:00Z'));
	});

	afterEach(() => {
		resetCuePresenceMonitor();
		vi.useRealTimers();
	});

	it('returns null and says why when no presence provider is installed', () => {
		const onLog = vi.fn();
		const source = createCuePresenceTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit: vi.fn(),
		});
		expect(source).toBeNull();
		expect(onLog).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('no presence signal source')
		);
	});

	describe('presence.return', () => {
		it('fires on return from an absence at least away_minutes long', () => {
			const os = installFakeProvider();
			const { emit } = startSource(makeSub());

			os.signal('lock-screen');
			vi.advanceTimersByTime(45 * MIN);
			os.signal('unlock-screen');

			expect(emit).toHaveBeenCalledTimes(1);
			const event = emit.mock.calls[0][0];
			expect(event.type).toBe('presence.return');
			expect(event.payload).toMatchObject({
				presence: 'return',
				reason: 'unlock',
				away_minutes: 45,
				away_since: '2026-10-07T09:00:00.000Z',
			});
		});

		it('does not fire for a short break', () => {
			const os = installFakeProvider();
			const { emit } = startSource(makeSub());

			os.signal('lock-screen');
			vi.advanceTimersByTime(5 * MIN);
			os.signal('unlock-screen');
			expect(emit).not.toHaveBeenCalled();
		});

		it('defaults away_minutes when it is omitted', () => {
			const os = installFakeProvider();
			const { emit } = startSource(makeSub({ away_minutes: undefined }));

			os.signal('lock-screen');
			vi.advanceTimersByTime(9 * MIN);
			os.signal('unlock-screen');
			expect(emit).not.toHaveBeenCalled();

			os.signal('lock-screen');
			vi.advanceTimersByTime(11 * MIN);
			os.signal('unlock-screen');
			expect(emit).toHaveBeenCalledTimes(1);
		});

		it('with settle_minutes, waits and fires only if the user stays', () => {
			const os = installFakeProvider();
			const { emit, source } = startSource(makeSub({ settle_minutes: 5 }));

			os.signal('lock-screen');
			vi.advanceTimersByTime(60 * MIN);
			os.signal('unlock-screen');
			expect(emit).not.toHaveBeenCalled();
			expect(source.nextTriggerAt()).toBe(Date.now() + 5 * MIN);

			vi.advanceTimersByTime(5 * MIN);
			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit.mock.calls[0][0].payload).toMatchObject({ away_minutes: 60 });
		});

		it('drops a settling return when the user leaves again, and carries the absence forward', () => {
			const os = installFakeProvider();
			const { emit } = startSource(makeSub({ settle_minutes: 5 }));

			os.signal('lock-screen');
			vi.advanceTimersByTime(120 * MIN);
			os.signal('unlock-screen'); // a glance...
			vi.advanceTimersByTime(MIN);
			os.signal('lock-screen'); // ...and gone again
			vi.advanceTimersByTime(10 * MIN);
			expect(emit).not.toHaveBeenCalled();

			// The 2-minute second absence alone would not qualify; the original
			// two hours still count.
			os.signal('unlock-screen');
			vi.advanceTimersByTime(5 * MIN);
			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit.mock.calls[0][0].payload).toMatchObject({
				away_since: '2026-10-07T09:00:00.000Z',
				away_minutes: 131,
			});
		});

		it('does not emit while the engine is disabled', () => {
			const os = installFakeProvider();
			const { emit } = startSource(makeSub(), () => false);
			os.signal('lock-screen');
			vi.advanceTimersByTime(45 * MIN);
			os.signal('unlock-screen');
			expect(emit).not.toHaveBeenCalled();
		});

		it('respects the subscription filter', () => {
			const os = installFakeProvider();
			const { emit } = startSource(makeSub({ filter: { reason: 'input' } }));
			os.signal('lock-screen');
			vi.advanceTimersByTime(45 * MIN);
			os.signal('unlock-screen');
			expect(emit).not.toHaveBeenCalled();
		});

		it('stops listening on stop()', () => {
			const os = installFakeProvider();
			const { emit, source } = startSource(makeSub());
			source.stop();
			os.signal('lock-screen');
			vi.advanceTimersByTime(45 * MIN);
			os.signal('unlock-screen');
			expect(emit).not.toHaveBeenCalled();
		});
	});

	describe('presence.leave', () => {
		it('fires once the user has been away away_minutes, counted from the last input', () => {
			const os = installFakeProvider();
			const { emit, source } = startSource(
				makeSub({ name: 'stepped-away', event: 'presence.leave', away_minutes: 15 })
			);

			os.setIdleSeconds(60);
			os.signal('lock-screen');
			expect(source.nextTriggerAt()).toBe(Date.now() + 14 * MIN);
			vi.advanceTimersByTime(14 * MIN - 1);
			expect(emit).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit.mock.calls[0][0]).toMatchObject({
				type: 'presence.leave',
				payload: { presence: 'leave', reason: 'lock', away_minutes: 15 },
			});
		});

		it('is cancelled by a return before the threshold', () => {
			const os = installFakeProvider();
			const { emit } = startSource(makeSub({ event: 'presence.leave', away_minutes: 15 }));

			os.signal('lock-screen');
			vi.advanceTimersByTime(10 * MIN);
			os.signal('unlock-screen');
			vi.advanceTimersByTime(30 * MIN);
			expect(emit).not.toHaveBeenCalled();
		});

		it('drops a leave whose timer slept through the threshold', () => {
			const os = installFakeProvider();
			const { emit, onLog } = startSource(makeSub({ event: 'presence.leave', away_minutes: 15 }));

			os.signal('suspend');
			// The process is frozen while the machine sleeps: the clock jumps two
			// hours before the 15-minute timer gets a chance to run.
			vi.setSystemTime(Date.now() + 120 * MIN);
			vi.advanceTimersByTime(15 * MIN);
			expect(emit).not.toHaveBeenCalled();
			expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('slept through'));
		});
	});
});
