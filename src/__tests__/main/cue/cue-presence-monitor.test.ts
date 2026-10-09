/**
 * Tests for the presence monitor behind presence.return / presence.leave.
 *
 * Pins down: lock/unlock and session switching are instant transitions, idle
 * time opens an absence dated at the last input, idle readings are ignored
 * while the screen is locked or the machine is suspended, resume alone is not
 * a return, and the monitor touches the OS only while something listens.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	CuePresenceMonitor,
	PRESENCE_IDLE_AWAY_MS,
	PRESENCE_POLL_AWAY_MS,
	PRESENCE_POLL_PRESENT_MS,
	createPowerMonitorPresenceProvider,
	type PresenceSignal,
	type PresenceSignalProvider,
	type PresenceTransition,
} from '../../../main/cue/cue-presence-monitor';

function makeProvider() {
	let idleSeconds = 0;
	let listener: ((signal: PresenceSignal) => void) | null = null;
	const unsubscribe = vi.fn(() => {
		listener = null;
	});
	const provider: PresenceSignalProvider = {
		getSystemIdleSeconds: vi.fn(() => idleSeconds),
		subscribe: vi.fn((l) => {
			listener = l;
			return unsubscribe;
		}),
	};
	return {
		provider,
		unsubscribe,
		setIdleSeconds(value: number) {
			idleSeconds = value;
		},
		signal(signal: PresenceSignal) {
			listener?.(signal);
		},
	};
}

describe('CuePresenceMonitor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-07T09:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not touch the OS until something subscribes, and lets go after the last unsubscribe', () => {
		const fake = makeProvider();
		const monitor = new CuePresenceMonitor(fake.provider);
		vi.advanceTimersByTime(PRESENCE_POLL_PRESENT_MS * 4);
		expect(fake.provider.subscribe).not.toHaveBeenCalled();
		expect(fake.provider.getSystemIdleSeconds).not.toHaveBeenCalled();

		const off = monitor.subscribe(vi.fn());
		expect(fake.provider.subscribe).toHaveBeenCalledTimes(1);
		off();
		expect(fake.unsubscribe).toHaveBeenCalledTimes(1);

		const reads = vi.mocked(fake.provider.getSystemIdleSeconds).mock.calls.length;
		vi.advanceTimersByTime(PRESENCE_POLL_PRESENT_MS * 4);
		expect(vi.mocked(fake.provider.getSystemIdleSeconds).mock.calls.length).toBe(reads);
	});

	it('reports a lock as away and the unlock as a return, dated at the last input', () => {
		const fake = makeProvider();
		const monitor = new CuePresenceMonitor(fake.provider);
		const seen: PresenceTransition[] = [];
		monitor.subscribe((t) => seen.push(t));

		fake.setIdleSeconds(20);
		fake.signal('lock-screen');
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ kind: 'away', reason: 'lock' });
		expect(seen[0].awaySince).toBe(Date.now() - 20_000);

		vi.advanceTimersByTime(30 * 60_000);
		fake.setIdleSeconds(0);
		fake.signal('unlock-screen');
		expect(seen).toHaveLength(2);
		expect(seen[1]).toMatchObject({ kind: 'return', reason: 'unlock' });
		if (seen[1].kind !== 'return') throw new Error('expected return');
		expect(seen[1].awayMs).toBe(30 * 60_000 + 20_000);
		expect(monitor.getSnapshot().away).toBe(false);
	});

	it('opens an absence once idle time crosses the threshold, and closes it on the next input', () => {
		const fake = makeProvider();
		const monitor = new CuePresenceMonitor(fake.provider);
		const seen: PresenceTransition[] = [];
		monitor.subscribe((t) => seen.push(t));

		fake.setIdleSeconds(PRESENCE_IDLE_AWAY_MS / 1000 - 1);
		vi.advanceTimersByTime(PRESENCE_POLL_PRESENT_MS);
		expect(seen).toHaveLength(0);

		fake.setIdleSeconds(90);
		vi.advanceTimersByTime(PRESENCE_POLL_PRESENT_MS);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ kind: 'away', reason: 'idle' });
		expect(seen[0].awaySince).toBe(Date.now() - 90_000);

		// While idle-away the monitor reads fast, so a keystroke is noticed quickly.
		fake.setIdleSeconds(92);
		vi.advanceTimersByTime(PRESENCE_POLL_AWAY_MS);
		expect(seen).toHaveLength(1);
		fake.setIdleSeconds(1);
		vi.advanceTimersByTime(PRESENCE_POLL_AWAY_MS);
		expect(seen).toHaveLength(2);
		expect(seen[1]).toMatchObject({ kind: 'return', reason: 'input' });
	});

	it('ignores idle drops while the screen is locked (typing the password is not a return)', () => {
		const fake = makeProvider();
		const monitor = new CuePresenceMonitor(fake.provider);
		const seen: PresenceTransition[] = [];
		monitor.subscribe((t) => seen.push(t));

		fake.setIdleSeconds(5);
		fake.signal('lock-screen');
		fake.setIdleSeconds(600);
		vi.advanceTimersByTime(PRESENCE_POLL_PRESENT_MS);
		fake.setIdleSeconds(0);
		vi.advanceTimersByTime(PRESENCE_POLL_PRESENT_MS * 2);
		expect(seen.map((t) => t.kind)).toEqual(['away']);

		fake.signal('unlock-screen');
		expect(seen.map((t) => t.kind)).toEqual(['away', 'return']);
	});

	it('keeps the earlier absence start when a lock follows an idle stretch', () => {
		const fake = makeProvider();
		const monitor = new CuePresenceMonitor(fake.provider);
		const seen: PresenceTransition[] = [];
		monitor.subscribe((t) => seen.push(t));

		fake.setIdleSeconds(120);
		vi.advanceTimersByTime(PRESENCE_POLL_PRESENT_MS);
		const idleStart = seen[0].awaySince;
		fake.signal('lock-screen');
		expect(seen).toHaveLength(1);
		expect(monitor.getSnapshot()).toMatchObject({
			away: true,
			awaySince: idleStart,
			hardAway: true,
		});
	});

	it('treats a resume as a return only once there is fresh input', () => {
		const fake = makeProvider();
		const monitor = new CuePresenceMonitor(fake.provider);
		const seen: PresenceTransition[] = [];
		monitor.subscribe((t) => seen.push(t));

		fake.setIdleSeconds(4);
		fake.signal('suspend');
		expect(seen[0]).toMatchObject({ kind: 'away', reason: 'suspend' });

		// A wake that nobody touched the machine for.
		vi.advanceTimersByTime(60 * 60_000);
		fake.setIdleSeconds(3600);
		fake.signal('resume');
		expect(seen).toHaveLength(1);

		fake.setIdleSeconds(0);
		vi.advanceTimersByTime(PRESENCE_POLL_AWAY_MS);
		expect(seen).toHaveLength(2);
		expect(seen[1]).toMatchObject({ kind: 'return', reason: 'input' });
	});

	it('waits for unlock after a resume when the screen locked on the way down', () => {
		const fake = makeProvider();
		const monitor = new CuePresenceMonitor(fake.provider);
		const seen: PresenceTransition[] = [];
		monitor.subscribe((t) => seen.push(t));

		fake.signal('lock-screen');
		fake.signal('suspend');
		vi.advanceTimersByTime(60 * 60_000);
		fake.setIdleSeconds(0);
		fake.signal('resume');
		vi.advanceTimersByTime(PRESENCE_POLL_PRESENT_MS);
		expect(seen.map((t) => t.kind)).toEqual(['away']);

		fake.signal('unlock-screen');
		expect(seen.map((t) => t.kind)).toEqual(['away', 'return']);
	});

	it('treats a fast-user-switch out and back like a lock and unlock', () => {
		const fake = makeProvider();
		const monitor = new CuePresenceMonitor(fake.provider);
		const seen: PresenceTransition[] = [];
		monitor.subscribe((t) => seen.push(t));

		fake.signal('session-inactive');
		fake.signal('session-active');
		expect(seen.map((t) => [t.kind, t.reason])).toEqual([
			['away', 'session-inactive'],
			['return', 'session-active'],
		]);
	});
});

describe('createPowerMonitorPresenceProvider', () => {
	it('maps powerMonitor events onto presence signals and removes every listener', () => {
		const handlers = new Map<string, () => void>();
		const powerMonitor = {
			getSystemIdleTime: vi.fn(() => 42),
			on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
			removeListener: vi.fn((event: string) => handlers.delete(event)),
		};
		const provider = createPowerMonitorPresenceProvider(powerMonitor);
		expect(provider.getSystemIdleSeconds()).toBe(42);

		const signals: PresenceSignal[] = [];
		const off = provider.subscribe((s) => signals.push(s));
		handlers.get('lock-screen')?.();
		handlers.get('user-did-resign-active')?.();
		handlers.get('user-did-become-active')?.();
		handlers.get('resume')?.();
		expect(signals).toEqual(['lock-screen', 'session-inactive', 'session-active', 'resume']);

		off();
		expect(handlers.size).toBe(0);
	});
});
