/**
 * System timezone watcher for the Electron main process.
 *
 * Why this exists: V8 caches the local timezone the first time a `Date` needs
 * it and never re-reads it on its own. Chromium notifies its *renderer*
 * processes when macOS/Windows/Linux report a timezone change, but the browser
 * (Electron main) process keeps its stale `DateCache`. Everything time-based in
 * Cue - `time.scheduled` slot matching, sleep-gap reconciliation, the
 * "next trigger" projection - runs in main against `new Date()`, so flying from
 * CST to PST used to mean the schedule kept firing on the old wall clock until
 * the app was restarted.
 *
 * The fix: poll for the real system zone and, when it moves, assign
 * `process.env.TZ`. Node's env setter calls V8's
 * `DateTimeConfigurationChangeNotification`, which drops the `DateCache` and
 * makes every subsequent `Date` correct immediately - no restart.
 *
 * Two independent detection signals, because either one alone has a blind spot:
 *  1. The zone ID. On POSIX we read the `/etc/localtime` symlink (a syscall, so
 *     nothing can cache it). Elsewhere we fall back to ICU's default zone,
 *     which Chromium *does* refresh in the browser process.
 *  2. The UTC offset. ICU's view of the current offset (fresh) compared against
 *     `Date.prototype.getTimezoneOffset()` (V8's cached view). A disagreement
 *     means the cache is stale even when the zone ID looks unchanged.
 *
 * When the user pinned `TZ` in the environment before launch, the watcher stays
 * out of the way - they asked for a fixed zone, and overwriting it would be a
 * surprise.
 */

import fs from 'fs';
import type { MainLogLevel } from '../../shared/logger-types';

/** Poll cadence. One minute matches the `time.scheduled` tick, so Cue can never
 *  be more than one tick behind the system clock's zone. */
export const TIMEZONE_POLL_INTERVAL_MS = 60_000;

export interface TimeZoneChange {
	previousZone: string;
	zone: string;
	/** Minutes to add to local time to get UTC, matching `getTimezoneOffset()`. */
	previousOffsetMinutes: number;
	offsetMinutes: number;
}

export interface TimeZoneWatcher {
	start(): void;
	stop(): void;
	/**
	 * Run one detection pass now instead of waiting for the next tick. Returns
	 * the applied change, or `null` when nothing moved. Call this on
	 * `powerMonitor` resume: a laptop that crossed timezones while asleep should
	 * be correct *before* the sleep-gap reconciler computes local slots.
	 */
	check(): TimeZoneChange | null;
	/** Zone ID currently applied to this process. */
	currentZone(): string;
	/** True when the watcher is inert because `TZ` was pinned before launch. */
	isPinned(): boolean;
}

export interface TimeZoneWatcherOptions {
	onChange?: (change: TimeZoneChange) => void;
	onLog?: (level: MainLogLevel, message: string) => void;
	intervalMs?: number;
	/** Test seam: overrides the OS-level zone lookup. */
	readSystemZone?: () => string | null;
	/** Test seam: overrides the ICU-based offset lookup. */
	offsetMinutesFor?: (zone: string, at: Date) => number | null;
}

/**
 * Reads the zone ID the operating system is currently configured for.
 *
 * POSIX first: `/etc/localtime` is a symlink into the zoneinfo tree, and
 * `readlink` is a live syscall, so this sees a change the instant the OS makes
 * it. Windows (and any POSIX box where `/etc/localtime` is a plain copy rather
 * than a symlink) falls back to ICU's default zone.
 */
export function readSystemTimeZone(): string | null {
	try {
		const target = fs.readlinkSync('/etc/localtime');
		const marker = 'zoneinfo/';
		const idx = target.lastIndexOf(marker);
		if (idx !== -1) {
			const zone = target.slice(idx + marker.length);
			if (isPlausibleZoneId(zone)) return zone;
		}
	} catch {
		// Not a symlink, or not POSIX. Fall through to ICU.
	}

	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return isPlausibleZoneId(zone) ? zone : null;
	} catch {
		return null;
	}
}

function isPlausibleZoneId(zone: string | undefined): zone is string {
	return typeof zone === 'string' && /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone);
}

/**
 * UTC offset of `zone` at `at`, in `getTimezoneOffset()` units (minutes to add
 * to local time to reach UTC, so UTC-6 is `360`). Computed through ICU, which
 * is independent of V8's `DateCache` - that independence is the whole point.
 *
 * Returns `null` when the zone ID is unknown to ICU.
 */
export function offsetMinutesForZone(zone: string, at: Date): number | null {
	let formatted: string;
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			timeZoneName: 'longOffset',
		}).formatToParts(at);
		formatted = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
	} catch {
		return null;
	}

	// "GMT" (exactly UTC), "GMT+09:00", "GMT-05:30", or the abbreviated "GMT-6".
	if (formatted === 'GMT' || formatted === 'UTC') return 0;
	const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(formatted);
	if (!match) return null;

	const sign = match[1] === '-' ? 1 : -1; // west of UTC is a POSITIVE offset here
	const hours = parseInt(match[2], 10);
	const minutes = match[3] ? parseInt(match[3], 10) : 0;
	// `|| 0` normalizes the -0 that "GMT+00:00" would otherwise produce, so the
	// value compares identically to `getTimezoneOffset()`'s plain 0.
	return sign * (hours * 60 + minutes) || 0;
}

export function createTimeZoneWatcher(options: TimeZoneWatcherOptions = {}): TimeZoneWatcher {
	const {
		onChange,
		onLog,
		intervalMs = TIMEZONE_POLL_INTERVAL_MS,
		readSystemZone = readSystemTimeZone,
		offsetMinutesFor = offsetMinutesForZone,
	} = options;

	// A TZ set before we ever ran is the user's explicit choice (containers, CI,
	// `TZ=UTC npm start`). Respect it and never poll.
	const pinned = Boolean(process.env.TZ);

	let appliedZone = readSystemZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	let timer: ReturnType<typeof setInterval> | null = null;
	let loggedPinned = false;

	function check(): TimeZoneChange | null {
		if (pinned) {
			if (!loggedPinned) {
				loggedPinned = true;
				onLog?.(
					'info',
					`[TZ] TZ is pinned to "${process.env.TZ}" in the environment - not watching for system timezone changes`
				);
			}
			return null;
		}

		const now = new Date();
		const systemZone = readSystemZone();
		if (!systemZone) return null;

		const systemOffset = offsetMinutesFor(systemZone, now);
		const v8Offset = now.getTimezoneOffset();

		// Two ways to be out of date: the zone ID moved, or V8's cached offset
		// disagrees with what the zone actually is right now (stale DateCache,
		// including a DST rollover V8 slept through).
		const zoneMoved = systemZone !== appliedZone;
		const offsetStale = systemOffset !== null && systemOffset !== v8Offset;
		if (!zoneMoved && !offsetStale) return null;

		const previousZone = appliedZone;
		const previousOffsetMinutes = v8Offset;

		// The assignment is what actually resets V8's DateCache. Everything after
		// this line sees the new zone.
		process.env.TZ = systemZone;
		appliedZone = systemZone;

		const offsetMinutes = new Date().getTimezoneOffset();
		if (systemOffset !== null && offsetMinutes !== systemOffset) {
			// Should not happen: assigning TZ is documented to take effect
			// immediately. Log loudly rather than silently reporting a bogus offset.
			onLog?.(
				'warn',
				`[TZ] Applied TZ="${systemZone}" but Date still reports offset ${offsetMinutes} (expected ${systemOffset})`
			);
		}

		const change: TimeZoneChange = {
			previousZone,
			zone: systemZone,
			previousOffsetMinutes,
			offsetMinutes,
		};

		onLog?.(
			'info',
			`[TZ] System timezone changed: ${previousZone} (UTC${formatOffset(previousOffsetMinutes)}) -> ${systemZone} (UTC${formatOffset(offsetMinutes)}). Local-time schedules now follow the new zone.`
		);
		onChange?.(change);
		return change;
	}

	return {
		start() {
			if (timer || pinned) {
				// Still emit the pinned notice once so the log explains the silence.
				if (pinned) check();
				return;
			}
			check();
			timer = setInterval(check, intervalMs);
			// Never hold the process open for a timezone poll.
			timer.unref?.();
		},

		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},

		check,
		currentZone: () => appliedZone,
		isPinned: () => pinned,
	};
}

/** `360` -> `-06:00`, matching how humans read a UTC offset. */
function formatOffset(offsetMinutes: number): string {
	const sign = offsetMinutes > 0 ? '-' : '+';
	const abs = Math.abs(offsetMinutes);
	return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
