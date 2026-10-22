/**
 * Prompt cadence - how often the user prompts an agent through Maestro.
 *
 * A PROMPT is an interactive turn: a `query_events` row whose source is not
 * `'auto'` (the same split `delegation.ts` draws). Auto Run tasks are excluded
 * because nobody typed them, and Cue runs never land in `query_events` at all.
 * That is the difference from the dashboard's "Queries", which counts every
 * agent turn including Auto Run.
 *
 * The per-day figures are CALENDAR-true, which a rolling window is not: a
 * "week" is the last seven local days including today, zero days included, so
 * an average per day really divides by days rather than by days that happened
 * to have activity. Today is still in progress, so it counts toward the total,
 * the active-day count and the streaks, but is left out of every per-day
 * distribution (average, median, min, weekday averages); otherwise each
 * morning would drag the average down and report today as the quietest day.
 *
 * Computed in the main process from raw prompt timestamps so the dashboard and
 * `maestro-cli stats` report the same numbers. Pure and import-free apart from
 * its siblings, so the CLI bundle and tests can use it.
 */

import { percentilesFromSorted, emptyPercentiles, type DurationPercentiles } from './percentiles';
import { addLocalDays, parseLocalYmd, toLocalYmd } from './localDay';
import type { StatsTimeRange } from './stats-types';

/**
 * Two prompts further apart than this belong to different working stretches.
 * The gap between them is a break, not prompting cadence, so it is left out of
 * the time-between-prompts distribution.
 */
export const PROMPT_STRETCH_BREAK_MS = 30 * 60 * 1000;

/** Calendar days (today included) each bounded range covers. */
export const PROMPT_WINDOW_DAYS: Record<Exclude<StatsTimeRange, 'all'>, number> = {
	day: 1,
	week: 7,
	month: 30,
	quarter: 90,
	year: 365,
};

/** One local calendar day and how many prompts were sent on it. */
export interface PromptDay {
	date: string;
	count: number;
}

export interface PromptCadence {
	/** Prompts sent in the window, today included. */
	total: number;
	/** First day of the window (local `YYYY-MM-DD`). Empty when there is no history. */
	windowStart: string;
	/** Last day of the window: today. */
	windowEnd: string;
	/** Calendar days in the window, today included. */
	calendarDays: number;
	/** Days with at least one prompt, today included. */
	activeDays: number;
	/**
	 * Complete days the per-day distribution covers: the window minus today, or
	 * just today when it is the only day there is.
	 */
	sampleDays: number;
	/** Mean prompts per complete calendar day, zero days included. */
	avgPerDay: number;
	/** Mean prompts per complete day that had any. */
	avgPerActiveDay: number;
	/** Distribution of prompts per complete calendar day (zero days included). */
	perDay: DurationPercentiles;
	/** Day with the most prompts, today included. */
	busiestDay: PromptDay | null;
	/** Complete day with the fewest prompts among days that had any. */
	quietestActiveDay: PromptDay | null;
	/** Consecutive days with a prompt, ending today (or yesterday, if today has none yet). */
	currentStreak: number;
	/** Longest run of consecutive days with a prompt in the window. */
	longestStreak: number;
	/** Prompts by local hour of day, index 0-23. */
	byHour: number[];
	/** Hour of day with the most prompts, or null without data. */
	peakHour: number | null;
	/** Single clock hour with the most prompts in the window. */
	busiestHour: { date: string; hour: number; count: number } | null;
	/** Mean prompts per complete calendar day for each weekday, index 0 = Sunday. */
	avgByWeekday: number[];
	/** Working stretches: runs of prompts with no break longer than `PROMPT_STRETCH_BREAK_MS`. */
	stretches: number;
	/** Time between consecutive prompts within a stretch (ms). */
	gapMs: DurationPercentiles;
	/** Every calendar day in the window, oldest first, zero days included. */
	days: PromptDay[];
}

export interface PromptCadenceInput {
	/** Epoch ms of every prompt in the window, any order. */
	timestamps: number[];
	/** First calendar day of the window (local `YYYY-MM-DD`), or null when there is no history. */
	windowStart: string | null;
	/** Defaults to now. Injected by tests. */
	now?: number;
}

/**
 * The local day the window opens on: N calendar days back including today for
 * a bounded range, the first prompt ever for 'all'. Never earlier than the
 * first prompt ever, so a week-old install does not average a month over
 * three weeks in which Maestro did not exist.
 */
export function promptWindowStart(
	range: StatsTimeRange,
	firstPromptAt: number | null,
	now: number = Date.now()
): string | null {
	if (firstPromptAt === null) return null;
	const first = toLocalYmd(firstPromptAt);
	if (range === 'all') return first;
	const rangeStart = addLocalDays(toLocalYmd(now), -(PROMPT_WINDOW_DAYS[range] - 1));
	return rangeStart > first ? rangeStart : first;
}

/** Epoch ms of local midnight on a `YYYY-MM-DD`, the SQL lower bound for the window. */
export function localDayStartMs(ymd: string): number {
	return parseLocalYmd(ymd)?.getTime() ?? 0;
}

export function emptyPromptCadence(now: number = Date.now()): PromptCadence {
	return {
		total: 0,
		windowStart: '',
		windowEnd: toLocalYmd(now),
		calendarDays: 0,
		activeDays: 0,
		sampleDays: 0,
		avgPerDay: 0,
		avgPerActiveDay: 0,
		perDay: emptyPercentiles(),
		busiestDay: null,
		quietestActiveDay: null,
		currentStreak: 0,
		longestStreak: 0,
		byHour: new Array(24).fill(0),
		peakHour: null,
		busiestHour: null,
		avgByWeekday: new Array(7).fill(0),
		stretches: 0,
		gapMs: emptyPercentiles(),
		days: [],
	};
}

function mean(values: number[]): number {
	return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

export function computePromptCadence({
	timestamps,
	windowStart,
	now = Date.now(),
}: PromptCadenceInput): PromptCadence {
	const today = toLocalYmd(now);
	if (!windowStart || windowStart > today) return emptyPromptCadence(now);

	const startMs = localDayStartMs(windowStart);
	const sorted = timestamps.filter((t) => Number.isFinite(t) && t >= startMs).sort((a, b) => a - b);

	// Bucket by local day and hour in one pass.
	const perDate = new Map<string, number>();
	const perClockHour = new Map<string, number>();
	const byHour = new Array<number>(24).fill(0);
	for (const t of sorted) {
		const d = new Date(t);
		const date = toLocalYmd(d);
		const hour = d.getHours();
		perDate.set(date, (perDate.get(date) ?? 0) + 1);
		byHour[hour] += 1;
		const key = `${date}|${hour}`;
		perClockHour.set(key, (perClockHour.get(key) ?? 0) + 1);
	}

	// Dense calendar, oldest first.
	const days: PromptDay[] = [];
	for (let date = windowStart; date <= today; date = addLocalDays(date, 1)) {
		days.push({ date, count: perDate.get(date) ?? 0 });
	}

	const complete = days.length > 1 ? days.slice(0, -1) : days;
	const completeCounts = complete.map((d) => d.count);
	const activeComplete = complete.filter((d) => d.count > 0);

	let busiestDay: PromptDay | null = null;
	for (const day of days) {
		if (day.count > 0 && (!busiestDay || day.count > busiestDay.count)) busiestDay = day;
	}
	let quietestActiveDay: PromptDay | null = null;
	for (const day of activeComplete) {
		if (!quietestActiveDay || day.count < quietestActiveDay.count) quietestActiveDay = day;
	}

	let longestStreak = 0;
	let run = 0;
	for (const day of days) {
		run = day.count > 0 ? run + 1 : 0;
		longestStreak = Math.max(longestStreak, run);
	}
	// Today with no prompt yet does not break a streak - the day is not over.
	let currentStreak = 0;
	const tail = days.length > 0 && days[days.length - 1].count === 0 ? days.slice(0, -1) : days;
	for (let i = tail.length - 1; i >= 0 && tail[i].count > 0; i--) currentStreak++;

	let peakHour: number | null = null;
	byHour.forEach((count, hour) => {
		if (count > 0 && (peakHour === null || count > byHour[peakHour])) peakHour = hour;
	});

	let busiestHour: PromptCadence['busiestHour'] = null;
	for (const [key, count] of perClockHour) {
		if (!busiestHour || count > busiestHour.count) {
			const [date, hour] = key.split('|');
			busiestHour = { date, hour: Number(hour), count };
		}
	}

	const weekdayTotals = new Array<number>(7).fill(0);
	const weekdayDays = new Array<number>(7).fill(0);
	for (const day of complete) {
		const weekday = parseLocalYmd(day.date)?.getDay() ?? 0;
		weekdayTotals[weekday] += day.count;
		weekdayDays[weekday] += 1;
	}

	const gaps: number[] = [];
	let stretches = sorted.length > 0 ? 1 : 0;
	for (let i = 1; i < sorted.length; i++) {
		const gap = sorted[i] - sorted[i - 1];
		if (gap > PROMPT_STRETCH_BREAK_MS) stretches++;
		else gaps.push(gap);
	}
	gaps.sort((a, b) => a - b);

	return {
		total: sorted.length,
		windowStart,
		windowEnd: today,
		calendarDays: days.length,
		activeDays: days.filter((d) => d.count > 0).length,
		sampleDays: complete.length,
		avgPerDay: mean(completeCounts),
		avgPerActiveDay: mean(activeComplete.map((d) => d.count)),
		perDay: percentilesFromSorted([...completeCounts].sort((a, b) => a - b)),
		busiestDay,
		quietestActiveDay,
		currentStreak,
		longestStreak,
		byHour,
		peakHour,
		busiestHour,
		avgByWeekday: weekdayTotals.map((total, i) =>
			weekdayDays[i] > 0 ? total / weekdayDays[i] : 0
		),
		stretches,
		gapMs: percentilesFromSorted(gaps),
		days,
	};
}
