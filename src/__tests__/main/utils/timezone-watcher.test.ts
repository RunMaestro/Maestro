/**
 * Tests for the system timezone watcher.
 *
 * Covers offset math through ICU, both drift-detection signals (zone ID moved /
 * V8's cached offset went stale), the `TZ`-is-pinned opt-out, and the fact that
 * applying a change actually moves `Date` in this process.
 *
 * Every test that lets the watcher apply a zone restores the original `TZ`
 * afterwards - these assignments are process-global and would otherwise leak
 * into unrelated suites.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	createTimeZoneWatcher,
	offsetMinutesForZone,
	TIMEZONE_POLL_INTERVAL_MS,
} from '../../../main/utils/timezone-watcher';

const JANUARY = new Date('2026-01-15T12:00:00Z');
const JULY = new Date('2026-07-15T12:00:00Z');

describe('offsetMinutesForZone', () => {
	it('returns getTimezoneOffset()-style minutes for zones west of UTC', () => {
		expect(offsetMinutesForZone('America/Chicago', JANUARY)).toBe(360); // UTC-6
		expect(offsetMinutesForZone('America/Los_Angeles', JANUARY)).toBe(480); // UTC-8
	});

	it('returns negative minutes for zones east of UTC', () => {
		expect(offsetMinutesForZone('Asia/Tokyo', JANUARY)).toBe(-540); // UTC+9
	});

	it('handles half-hour offsets', () => {
		expect(offsetMinutesForZone('Asia/Kolkata', JANUARY)).toBe(-330); // UTC+5:30
	});

	it('returns 0 for UTC', () => {
		expect(offsetMinutesForZone('UTC', JANUARY)).toBe(0);
	});

	it('follows DST for the given instant', () => {
		expect(offsetMinutesForZone('America/Chicago', JULY)).toBe(300); // UTC-5 in summer
	});

	it('returns null for an unknown zone', () => {
		expect(offsetMinutesForZone('Not/AZone', JANUARY)).toBeNull();
	});
});

/**
 * The watcher compares the *machine's* real zone against what V8 reports, so
 * tests must start from wherever this machine actually is (developer laptop in
 * CST, CI container in UTC) and move somewhere else. Hard-coding a "home" zone
 * would register as drift the moment CI runs in a different one.
 */
const HOME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const AWAY_ZONE = HOME_ZONE === 'Asia/Tokyo' ? 'America/Chicago' : 'Asia/Tokyo';
const AWAY_OFFSET = offsetMinutesForZone(AWAY_ZONE, new Date())!;

describe('createTimeZoneWatcher', () => {
	let originalTz: string | undefined;

	beforeEach(() => {
		originalTz = process.env.TZ;
		delete process.env.TZ;
	});

	afterEach(() => {
		vi.useRealTimers();
		// Assign the machine's own zone back before deleting, so V8's date cache
		// is reset explicitly. Relying on `delete` alone would leave the next test
		// (and any later suite in this worker) reading the clock in whichever zone
		// the last test moved to.
		process.env.TZ = HOME_ZONE;
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	});

	it('reports no change when the system zone matches the applied zone', () => {
		const onChange = vi.fn();
		const watcher = createTimeZoneWatcher({ onChange, readSystemZone: () => HOME_ZONE });

		expect(watcher.check()).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('applies the new zone to the process when the zone ID moves', () => {
		let systemZone = HOME_ZONE;
		const onChange = vi.fn();
		const watcher = createTimeZoneWatcher({ onChange, readSystemZone: () => systemZone });

		systemZone = AWAY_ZONE;
		const change = watcher.check();

		expect(change).not.toBeNull();
		expect(change?.previousZone).toBe(HOME_ZONE);
		expect(change?.zone).toBe(AWAY_ZONE);
		expect(change?.offsetMinutes).toBe(AWAY_OFFSET);
		expect(onChange).toHaveBeenCalledWith(change);

		// The process really moved - not just the watcher's bookkeeping.
		expect(process.env.TZ).toBe(AWAY_ZONE);
		expect(new Date().getTimezoneOffset()).toBe(AWAY_OFFSET);
		expect(watcher.currentZone()).toBe(AWAY_ZONE);
	});

	it('detects a stale V8 cache even when the zone ID is unchanged', () => {
		const onChange = vi.fn();
		const onLog = vi.fn();
		const staleByAnHour = new Date().getTimezoneOffset() + 60;
		const watcher = createTimeZoneWatcher({
			onChange,
			onLog,
			readSystemZone: () => HOME_ZONE,
			// Stand-in for ICU disagreeing with V8's cached offset. The zone ID
			// never moves, so only the offset signal can catch this.
			offsetMinutesFor: () => staleByAnHour,
		});

		const change = watcher.check();

		expect(change).not.toBeNull();
		expect(change?.zone).toBe(HOME_ZONE);
		expect(process.env.TZ).toBe(HOME_ZONE);
		expect(onChange).toHaveBeenCalledOnce();
		// Re-applying the zone can't satisfy a fabricated offset, so the
		// "applied but Date disagrees" guard fires - which is the point of having
		// it rather than silently trusting the reassignment.
		expect(onLog.mock.calls.some(([, message]) => message.includes('still reports offset'))).toBe(
			true
		);
	});

	it('reports nothing on a second check once the change has been applied', () => {
		let systemZone = HOME_ZONE;
		const onChange = vi.fn();
		const watcher = createTimeZoneWatcher({ onChange, readSystemZone: () => systemZone });

		systemZone = AWAY_ZONE;
		expect(watcher.check()).not.toBeNull();
		expect(watcher.check()).toBeNull();
		expect(onChange).toHaveBeenCalledOnce();
	});

	it('stays inert and logs once when TZ was pinned before launch', () => {
		process.env.TZ = 'UTC';
		const onChange = vi.fn();
		const onLog = vi.fn();
		const watcher = createTimeZoneWatcher({
			onChange,
			onLog,
			readSystemZone: () => AWAY_ZONE,
		});

		expect(watcher.isPinned()).toBe(true);
		expect(watcher.check()).toBeNull();
		expect(watcher.check()).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
		expect(onLog).toHaveBeenCalledOnce();
		expect(onLog.mock.calls[0][1]).toContain('pinned');
		// The pinned value survives untouched.
		expect(process.env.TZ).toBe('UTC');
	});

	it('ignores an unreadable system zone rather than guessing', () => {
		const onChange = vi.fn();
		const watcher = createTimeZoneWatcher({
			onChange,
			readSystemZone: () => null,
		});

		expect(watcher.check()).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('polls on an interval until stopped', () => {
		vi.useFakeTimers();
		let systemZone = HOME_ZONE;
		const onChange = vi.fn();
		const watcher = createTimeZoneWatcher({ onChange, readSystemZone: () => systemZone });

		watcher.start();
		expect(onChange).not.toHaveBeenCalled();

		systemZone = AWAY_ZONE;
		vi.advanceTimersByTime(TIMEZONE_POLL_INTERVAL_MS);
		expect(onChange).toHaveBeenCalledOnce();

		watcher.stop();
		systemZone = HOME_ZONE;
		vi.advanceTimersByTime(TIMEZONE_POLL_INTERVAL_MS * 3);
		expect(onChange).toHaveBeenCalledOnce();
	});

	it('start() is idempotent', () => {
		vi.useFakeTimers();
		let systemZone = HOME_ZONE;
		const onChange = vi.fn();
		const watcher = createTimeZoneWatcher({ onChange, readSystemZone: () => systemZone });

		watcher.start();
		watcher.start();

		systemZone = AWAY_ZONE;
		vi.advanceTimersByTime(TIMEZONE_POLL_INTERVAL_MS);
		expect(onChange).toHaveBeenCalledOnce();

		watcher.stop();
	});
});
