/**
 * Humanized durations - the one ladder every "how long was that?" string in
 * Maestro renders from.
 *
 * Before this module there were roughly a dozen hand-rolled copies of the same
 * loop (divide by 86400000, then 3600000, then 60000, then 1000; pick the top
 * one or two; glue on a suffix). They all drifted from each other in the
 * details that matter: where the ladder stops, whether a zero unit is padded or
 * dropped, whether a countdown rounds up, and what a sub-second span prints.
 * Those differences are real product decisions, so this module does not flatten
 * them - it turns them into named options on a single engine.
 *
 * The rule: never write another unit ladder. Either call one of the presets
 * below, or call `humanizeDuration` with the ladder you need.
 *
 * Calendar math is deliberately approximate. A year is 365 days and a month is
 * the average Gregorian month (30.44 days), because these strings answer "how
 * long roughly?" and never drive scheduling. Anything that needs true calendar
 * arithmetic (a real due date, a wake time) must use Date, not this module.
 */

/** Rungs on the ladder, largest to smallest. */
export type DurationUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

/**
 * How a unit is labelled:
 * - `short`: `2h`, `3d` - dense pills, chart axes, tables.
 * - `long`: `2 hours`, `3 days` - prose read inside a sentence.
 * - `caps`: `2H`, `3D` - the Left Bar's uppercase stat style.
 */
export type DurationStyle = 'short' | 'long' | 'caps';

interface UnitSpec {
	readonly ms: number;
	readonly short: string;
	readonly caps: string;
	readonly long: string;
}

// `mo` rather than `m` for month: `m` is already minute, and a string that can
// mean either 60 seconds or 30 days is worse than no string at all.
const UNITS: Record<DurationUnit, UnitSpec> = {
	year: { ms: 31_536_000_000, short: 'y', caps: 'Y', long: 'year' },
	month: { ms: 2_629_746_000, short: 'mo', caps: 'MO', long: 'month' },
	week: { ms: 604_800_000, short: 'w', caps: 'W', long: 'week' },
	day: { ms: 86_400_000, short: 'd', caps: 'D', long: 'day' },
	hour: { ms: 3_600_000, short: 'h', caps: 'H', long: 'hour' },
	minute: { ms: 60_000, short: 'm', caps: 'M', long: 'minute' },
	second: { ms: 1_000, short: 's', caps: 'S', long: 'second' },
};

/** Milliseconds in one of each unit. Exported so callers can compare spans without redefining `const DAY = 86400000`. */
export const DURATION_MS: Readonly<Record<DurationUnit, number>> = {
	year: UNITS.year.ms,
	month: UNITS.month.ms,
	week: UNITS.week.ms,
	day: UNITS.day.ms,
	hour: UNITS.hour.ms,
	minute: UNITS.minute.ms,
	second: UNITS.second.ms,
};

/** Every rung: spans that can run to months or years (snooze gaps, lifetime totals). */
export const DURATION_LADDER_FULL = [
	'year',
	'month',
	'week',
	'day',
	'hour',
	'minute',
	'second',
] as const satisfies readonly DurationUnit[];

/** Weeks and months omitted, so long spans keep counting in days: `400d`, not `1y 1mo`. */
export const DURATION_LADDER_DAYS = [
	'day',
	'hour',
	'minute',
	'second',
] as const satisfies readonly DurationUnit[];

/** Hour-capped: a 30-hour span reads `30h`, not `1d 6h`. Right for run times, wrong for calendar gaps. */
export const DURATION_LADDER_HOURS = [
	'hour',
	'minute',
	'second',
] as const satisfies readonly DurationUnit[];

export interface HumanizeDurationOptions {
	/** Rungs to use, largest first. Defaults to the full ladder. */
	units?: readonly DurationUnit[];
	/** How many rungs to print, largest first. Default 2. */
	maxUnits?: number;
	/** Label style. Default `short`. */
	style?: DurationStyle;
	/** Glue between rungs. Default a space; prose usually wants `', '`. */
	separator?: string;
	/**
	 * Print a rung even when its value is zero, once a larger rung has printed:
	 * `2h 0m` instead of `2h`. Steady width for tables and tickers; noise in
	 * prose. Leading zeros are still skipped unless `keepLeadingZero` is also set.
	 */
	keepZeroUnits?: boolean;
	/**
	 * With `keepZeroUnits`, also print a zero of the first unit on the provided
	 * ladder: `0m 3s` instead of `3s`. Off by default because most surfaces do
	 * not want a leading `0h` / `0d`. The live thinking ticker is the case that
	 * needs a steady `0m` prefix below one hour.
	 */
	keepLeadingZero?: boolean;
	/**
	 * Print at most the leading rung and the one immediately below it, so a
	 * near-exact span stays round: `1h` rather than `1h 59s`, `1y` rather than
	 * `1y 3d`. This is how durations are said out loud - "an hour and a half",
	 * never "an hour and fifty-nine seconds" - and it suits summary lines where
	 * a stray trailing rung reads as false precision.
	 *
	 * Without it the two largest non-zero rungs print however far apart they sit,
	 * which is what a report of elapsed time wants. Overrides `maxUnits`.
	 */
	adjacentUnits?: boolean;
	/**
	 * Rounding into the smallest rung. Default `floor` (elapsed time: 59.9s of
	 * work is not a minute). Countdowns want `ceil` so a live ticker never shows
	 * `0s` while there is still time on the clock.
	 */
	round?: 'floor' | 'ceil';
	/** Printed when the span is below the smallest rung. Defaults to a zero of that rung (`0s`). */
	fallback?: string;
}

function renderUnit(value: number, unit: UnitSpec, style: DurationStyle): string {
	if (style === 'long') return `${value} ${unit.long}${value === 1 ? '' : 's'}`;
	return `${value}${style === 'caps' ? unit.caps : unit.short}`;
}

/**
 * Render a millisecond span as a human-readable duration.
 *
 * Walks the ladder largest-first, skips leading zeros, and prints the first
 * `maxUnits` rungs that survive. Negative and non-finite input collapses to the
 * fallback rather than throwing, because these values come from clock deltas
 * and a clock that jumped backwards should not blank a whole panel.
 *
 * @param ms - Span in milliseconds
 * @param options - Ladder, unit budget, and label style
 * @returns Formatted duration (e.g. `"2h 15m"`, `"3 days, 4 hours"`, `"<1M"`)
 */
export function humanizeDuration(ms: number, options: HumanizeDurationOptions = {}): string {
	const {
		units,
		maxUnits = 2,
		style = 'short',
		separator = ' ',
		keepZeroUnits = false,
		keepLeadingZero = false,
		adjacentUnits = false,
		round = 'floor',
		fallback,
	} = options;

	const ladder = units && units.length > 0 ? units : DURATION_LADDER_FULL;
	const smallest = UNITS[ladder[ladder.length - 1]];
	const budget = Math.max(1, Math.floor(maxUnits));

	// Quantize to the smallest rung up front so `floor`/`ceil` is decided once,
	// rather than per-rung where rounding would compound down the ladder.
	const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
	const quantize = round === 'ceil' ? Math.ceil : Math.floor;
	let remaining = quantize(safe / smallest.ms) * smallest.ms;

	const parts: string[] = [];
	let leadIndex = -1;
	for (let i = 0; i < ladder.length; i++) {
		if (parts.length >= budget) break;
		const unit = UNITS[ladder[i]];
		const value = Math.floor(remaining / unit.ms);
		// Interior zeros print only when padding. Leading zeros print only when
		// both keepZeroUnits and keepLeadingZero are set (live tickers).
		if (value === 0 && !(keepZeroUnits && (parts.length > 0 || keepLeadingZero))) continue;
		if (parts.length === 0) leadIndex = i;
		else if (adjacentUnits && i !== leadIndex + 1) break;
		parts.push(renderUnit(value, unit, style));
		remaining -= value * unit.ms;
	}

	if (parts.length === 0) return fallback ?? renderUnit(0, smallest, style);
	return parts.join(separator);
}

/**
 * Hour-capped, zero-padded: `"0s"`, `"45s"`, `"5m 30s"`, `"2h 15m"`, `"30h 0m"`.
 *
 * The default for dashboards and stat cards. Padding keeps a column of these
 * from jittering between one and two segments as values tick over.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatDurationHuman(ms: number): string {
	return humanizeDuration(ms, { units: DURATION_LADDER_HOURS, keepZeroUnits: true });
}

/**
 * Like `formatDurationHuman` but drops the seconds segment once the span
 * reaches a minute: `"45s"`, `"5m"`, `"2h 15m"`. For summary lines where
 * second-level precision is noise.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatDurationCompact(ms: number): string {
	const belowAMinute = !Number.isFinite(ms) || ms < DURATION_MS.minute;
	return humanizeDuration(ms, {
		units: belowAMinute ? ['second'] : ['hour', 'minute'],
		keepZeroUnits: true,
	});
}

/**
 * Full English words, hour-capped: `"45 seconds"`, `"5 minutes 30 seconds"`,
 * `"1 hour 15 minutes"`. Zero segments are dropped, since prose reading
 * "1 hour 0 minutes" is worse than "1 hour".
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatDurationVerbose(ms: number): string {
	return humanizeDuration(ms, {
		units: DURATION_LADDER_HOURS,
		style: 'long',
		adjacentUnits: true,
	});
}

/**
 * Day-capped, up to four segments, zeros dropped: `"5s"`, `"2m 30s"`,
 * `"1h 15m 20s"`, `"3d 2h 15m"`. Seconds are dropped once the span reaches a
 * day, where they are false precision.
 *
 * Sub-second spans print raw milliseconds, which is why this is the toast and
 * progress formatter: those routinely measure work that finishes instantly.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatDurationParts(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return humanizeDuration(ms, {
		units: ms >= DURATION_MS.day ? ['day', 'hour', 'minute'] : DURATION_LADDER_DAYS,
		maxUnits: 4,
	});
}

/**
 * Two largest non-zero units across a ladder that runs to years:
 * `"45s"`, `"5m 30s"`, `"2h 15m"`, `"6d 7h"`, `"3w 2d"`, `"1y 7w"`.
 *
 * Months are skipped here so the ladder reads as an even progression of
 * exact units; use `formatDurationWords` when months are wanted.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatDurationLong(ms: number): string {
	return humanizeDuration(ms, {
		units: ['year', 'week', 'day', 'hour', 'minute', 'second'],
		adjacentUnits: true,
	});
}

/**
 * The prose sibling of `formatDurationLong`, with months: `"1 day, 12 hours"`,
 * `"2 months, 1 week"`, `"1 year, 1 month"`.
 *
 * Use wherever a duration is read as part of a sentence rather than scanned in
 * a table. A span of months is meaningless as a raw seconds count.
 *
 * @param ms - Duration in milliseconds
 * @param maxUnits - How many units to show, largest first (default 2)
 * @returns Formatted duration
 */
export function formatDurationWords(ms: number, maxUnits: number = 2): string {
	if (!Number.isFinite(ms) || ms < 1000) return 'less than a second';
	return humanizeDuration(ms, { maxUnits, style: 'long', separator: ', ' });
}

/**
 * Uppercase and day-capped for dense stat pills: `"<1M"`, `"5M"`, `"2H 30M"`,
 * `"1D"`. Once a span passes a day only the day count is shown - at that scale
 * the hours are not what the pill is communicating.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatActiveTime(ms: number): string {
	return humanizeDuration(ms, {
		units: ['day', 'hour', 'minute'],
		maxUnits: Number.isFinite(ms) && ms >= DURATION_MS.day ? 1 : 2,
		style: 'caps',
		fallback: '<1M',
	});
}

/**
 * `formatDurationHuman` with millisecond precision below a second:
 * `"500ms"`, `"30s"`, `"5m 12s"`, `"1h 10m"`.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatElapsedTime(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return formatDurationHuman(ms);
}

/**
 * Live ticker that always shows seconds, with zeros padded after the lead:
 * `"0m 0s"`, `"0m 3s"`, `"1h 0m 5s"`, `"1d 1h 1m 1s"`.
 *
 * The thinking-status pill uses this so a three-second wait does not jump from
 * `0m 3s` to `3s` (or drop the minutes column). Ladder starts at minutes below
 * an hour, hours below a day, then days - so a short wait never prints `0d`.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatElapsedTicker(ms: number): string {
	const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
	return humanizeDuration(safe, {
		units: elapsedTickerLadder(safe),
		keepZeroUnits: true,
		keepLeadingZero: true,
		maxUnits: 4,
	});
}

/**
 * `formatElapsedTicker` without the padded lead: `"3s"`, `"1m 0s"`, `"20m 4s"`,
 * `"1h 2m 5s"`.
 *
 * For an inline counter sitting inside a sentence or a chip, where a bare
 * seconds count is the natural reading below a minute but `1203s` is not a
 * duration anyone can read past it. Same ladder as the ticker, so a chip and
 * the ticker beside it agree on segments once both are past a minute.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatElapsedTickerCompact(ms: number): string {
	const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
	return humanizeDuration(safe, {
		units: elapsedTickerLadder(safe),
		keepZeroUnits: true,
		maxUnits: 4,
	});
}

/**
 * Ladder for the live tickers: minutes below an hour, hours below a day, then
 * days - so a short wait never prints a `0d` / `0h` segment it will not reach.
 */
function elapsedTickerLadder(ms: number): readonly DurationUnit[] {
	if (ms >= DURATION_MS.day) return DURATION_LADDER_DAYS;
	if (ms >= DURATION_MS.hour) return DURATION_LADDER_HOURS;
	return ['minute', 'second'];
}

/**
 * Single-decimal with one unit, for compact CLI columns:
 * `"500ms"`, `"5.2s"`, `"3.1m"`, `"1.5h"`.
 *
 * The odd one out: it trades the unit ladder for a decimal so every value
 * occupies about the same width, which is what keeps a terminal table aligned.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration
 */
export function formatDurationDecimal(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}
