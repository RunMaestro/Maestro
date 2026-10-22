/**
 * Computer History - `--since` / `--until` / `--for` parsing (pure).
 *
 * Durations reuse the Cue scheduler's `parseScheduleDuration` (`30s`, `20m`,
 * `2h`, `1d`) and add weeks (`1w`), which a recall window needs and a Cue
 * heartbeat does not. Absolute values are ISO-8601 or epoch numbers.
 */

import { parseScheduleDuration } from '../cue/scheduled-tasks';

const WEEK_MS = 7 * 86_400_000;

/** Parse a bare duration (`30m`, `2h`, `1d`, `1w`) to milliseconds, or null. */
export function parseDurationInput(input: string): number | null {
	const trimmed = input.trim().toLowerCase();
	const week = /^(\d+)w$/.exec(trimmed);
	if (week) return parseInt(week[1], 10) * WEEK_MS;
	return parseScheduleDuration(trimmed);
}

/**
 * Parse a point in time: a duration means "that long ago", otherwise ISO-8601
 * or an epoch (seconds or milliseconds, by magnitude). Null when unparseable.
 */
export function parseTimeInput(input: string, nowMs: number): number | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const duration = parseDurationInput(trimmed);
	if (duration !== null) return nowMs - duration;
	if (/^\d+$/.test(trimmed)) {
		const n = Number(trimmed);
		if (!Number.isFinite(n)) return null;
		return n >= 1e12 ? n : n * 1000;
	}
	const ms = Date.parse(trimmed);
	return Number.isNaN(ms) ? null : ms;
}
