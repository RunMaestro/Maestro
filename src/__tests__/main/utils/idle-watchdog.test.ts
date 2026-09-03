import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleWatchdog } from '../../../main/utils/idle-watchdog';

const IDLE_MS = 10 * 60 * 1000;
const MAX_MS = 30 * 60 * 1000;

describe('createIdleWatchdog', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('fires onIdle after the silence budget with no activity', () => {
		const onIdle = vi.fn();
		createIdleWatchdog({ idleMs: IDLE_MS, onIdle });

		vi.advanceTimersByTime(IDLE_MS - 1);
		expect(onIdle).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	// The whole reason this module exists: a plain setTimeout armed once measures
	// total duration, so a busy process and a dead one look identical to it.
	it('never fires while touched inside the budget, however long the run', () => {
		const onIdle = vi.fn();
		const dog = createIdleWatchdog({ idleMs: IDLE_MS, onIdle });

		// Two hours of steady work, a heartbeat every nine minutes.
		for (let elapsed = 0; elapsed < 2 * 60 * 60 * 1000; elapsed += 9 * 60 * 1000) {
			vi.advanceTimersByTime(9 * 60 * 1000);
			dog.touch();
		}

		expect(onIdle).not.toHaveBeenCalled();
	});

	it('fires once the touches stop, measuring from the last one', () => {
		const onIdle = vi.fn();
		const dog = createIdleWatchdog({ idleMs: IDLE_MS, onIdle });

		vi.advanceTimersByTime(IDLE_MS - 60_000);
		dog.touch();
		vi.advanceTimersByTime(IDLE_MS - 60_000);
		expect(onIdle).not.toHaveBeenCalled();

		vi.advanceTimersByTime(60_000);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it('stops a chattering run at the hard ceiling, which touching cannot postpone', () => {
		const onIdle = vi.fn();
		const onMax = vi.fn();
		const dog = createIdleWatchdog({ idleMs: IDLE_MS, maxMs: MAX_MS, onIdle, onMax });

		// Output every five minutes forever: the idle budget never expires.
		for (let elapsed = 0; elapsed < MAX_MS; elapsed += 5 * 60 * 1000) {
			vi.advanceTimersByTime(5 * 60 * 1000);
			dog.touch();
		}

		expect(onMax).toHaveBeenCalledTimes(1);
		expect(onIdle).not.toHaveBeenCalled();
	});

	it('falls back to onIdle at the ceiling when no onMax is given', () => {
		const onIdle = vi.fn();
		const dog = createIdleWatchdog({ idleMs: IDLE_MS, maxMs: MAX_MS, onIdle });

		for (let elapsed = 0; elapsed < MAX_MS; elapsed += 5 * 60 * 1000) {
			vi.advanceTimersByTime(5 * 60 * 1000);
			dog.touch();
		}

		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it('reports one outcome even when both budgets would come due', () => {
		const onIdle = vi.fn();
		const onMax = vi.fn();
		// Ceiling and silence budget expire at the same instant.
		createIdleWatchdog({ idleMs: MAX_MS, maxMs: MAX_MS, onIdle, onMax });

		vi.advanceTimersByTime(MAX_MS * 2);

		expect(onIdle.mock.calls.length + onMax.mock.calls.length).toBe(1);
	});

	it('does not fire after disarm', () => {
		const onIdle = vi.fn();
		const onMax = vi.fn();
		const dog = createIdleWatchdog({ idleMs: IDLE_MS, maxMs: MAX_MS, onIdle, onMax });

		dog.disarm();
		vi.advanceTimersByTime(MAX_MS * 2);

		expect(onIdle).not.toHaveBeenCalled();
		expect(onMax).not.toHaveBeenCalled();
	});

	it('is idempotent on disarm and inert on a late touch', () => {
		const onIdle = vi.fn();
		const dog = createIdleWatchdog({ idleMs: IDLE_MS, onIdle });

		dog.disarm();
		dog.disarm();
		// Output can arrive from a process that was already given up on; re-arming
		// then would resurrect a timer nobody is waiting for.
		dog.touch();
		vi.advanceTimersByTime(IDLE_MS * 2);

		expect(onIdle).not.toHaveBeenCalled();
	});

	it('ignores a touch that lands after it has already fired', () => {
		const onIdle = vi.fn();
		const dog = createIdleWatchdog({ idleMs: IDLE_MS, onIdle });

		vi.advanceTimersByTime(IDLE_MS);
		expect(onIdle).toHaveBeenCalledTimes(1);

		dog.touch();
		vi.advanceTimersByTime(IDLE_MS * 2);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it('runs unbounded when no ceiling is configured', () => {
		const onIdle = vi.fn();
		const dog = createIdleWatchdog({ idleMs: IDLE_MS, onIdle });

		for (let elapsed = 0; elapsed < 6 * 60 * 60 * 1000; elapsed += 5 * 60 * 1000) {
			vi.advanceTimersByTime(5 * 60 * 1000);
			dog.touch();
		}

		expect(onIdle).not.toHaveBeenCalled();
	});
});
