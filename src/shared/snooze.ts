/**
 * Snooze time parsing and formatting.
 *
 * Powers the "snooze this tab" flow: the user types something human ("1d",
 * "2 weeks", "next friday 3pm", "aug 5") and we resolve it to an absolute
 * timestamp. Kept in `shared/` (no DOM, no Electron) so the renderer, the CLI,
 * and tests all resolve snooze text identically.
 *
 * Deliberately hand-rolled rather than pulling in a natural-language date
 * dependency: the vocabulary here is small and closed, and the modal shows a
 * live preview of whatever we resolved, so an unparsed phrase is visible to the
 * user before they commit rather than silently landing on the wrong day.
 *
 * Every helper takes an explicit `now` so tests are deterministic and callers
 * can resolve against a fixed instant.
 */

/** Hour of day (local) that date-only inputs ("tomorrow", "aug 5") resolve to. */
export const SNOOZE_DEFAULT_HOUR = 9;

/** Hour of day (local) that "tonight" / "this evening" resolve to. */
export const SNOOZE_EVENING_HOUR = 18;

/** How far ahead "later today" pushes. */
const LATER_TODAY_MS = 3 * 60 * 60 * 1000;

/** Smallest snooze we accept. Anything shorter is almost certainly a typo. */
export const MIN_SNOOZE_MS = 60 * 1000;

export type SnoozeParseResult = { ok: true; at: number } | { ok: false; error: string };

const MS = {
	minute: 60 * 1000,
	hour: 60 * 60 * 1000,
	day: 24 * 60 * 60 * 1000,
	week: 7 * 24 * 60 * 60 * 1000,
} as const;

const WEEKDAYS: Record<string, number> = {
	sunday: 0,
	sun: 0,
	monday: 1,
	mon: 1,
	tuesday: 2,
	tue: 2,
	tues: 2,
	wednesday: 3,
	wed: 3,
	thursday: 4,
	thu: 4,
	thur: 4,
	thurs: 4,
	friday: 5,
	fri: 5,
	saturday: 6,
	sat: 6,
};

const MONTHS: Record<string, number> = {
	january: 0,
	jan: 0,
	february: 1,
	feb: 1,
	march: 2,
	mar: 2,
	april: 3,
	apr: 3,
	may: 4,
	june: 5,
	jun: 5,
	july: 6,
	jul: 6,
	august: 7,
	aug: 7,
	september: 8,
	sep: 8,
	sept: 8,
	october: 9,
	oct: 9,
	november: 10,
	nov: 10,
	december: 11,
	dec: 11,
};

/** Unit aliases for duration expressions ("2 weeks", "10h", "90 min"). */
const DURATION_UNITS: Array<{ match: RegExp; ms: number }> = [
	{ match: /^(?:mo|mon|month|months)$/, ms: 30 * MS.day },
	{ match: /^(?:m|min|mins|minute|minutes)$/, ms: MS.minute },
	{ match: /^(?:h|hr|hrs|hour|hours)$/, ms: MS.hour },
	{ match: /^(?:d|day|days)$/, ms: MS.day },
	{ match: /^(?:w|wk|wks|week|weeks)$/, ms: MS.week },
	{ match: /^(?:y|yr|yrs|year|years)$/, ms: 365 * MS.day },
];

/**
 * Set the local time-of-day on a date, zeroing seconds and milliseconds so
 * snoozes land on a clean minute boundary.
 */
function atTime(date: Date, hours: number, minutes = 0): Date {
	const next = new Date(date);
	next.setHours(hours, minutes, 0, 0);
	return next;
}

function startOfDay(date: Date): Date {
	return atTime(date, 0, 0);
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

/**
 * Parse a bare time-of-day ("3pm", "15:30", "9:05am", "noon", "midnight").
 * Returns null when the text isn't a time at all.
 */
function parseTimeOfDay(raw: string): { hours: number; minutes: number } | null {
	const text = raw.trim().toLowerCase();
	if (!text) return null;
	if (text === 'noon' || text === 'midday') return { hours: 12, minutes: 0 };
	if (text === 'midnight') return { hours: 0, minutes: 0 };
	if (text === 'morning') return { hours: SNOOZE_DEFAULT_HOUR, minutes: 0 };
	if (text === 'afternoon') return { hours: 13, minutes: 0 };
	if (text === 'evening' || text === 'tonight') return { hours: SNOOZE_EVENING_HOUR, minutes: 0 };

	const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
	if (!match) return null;

	let hours = parseInt(match[1], 10);
	const minutes = match[2] ? parseInt(match[2], 10) : 0;
	const meridiem = match[3];

	if (minutes > 59) return null;
	if (meridiem) {
		if (hours < 1 || hours > 12) return null;
		if (meridiem === 'pm' && hours !== 12) hours += 12;
		if (meridiem === 'am' && hours === 12) hours = 0;
	} else if (hours > 23) {
		return null;
	}

	return { hours, minutes };
}

/**
 * Split a trailing time-of-day off an expression.
 * "next friday 3pm" -> { head: "next friday", time: 15:00 }
 * "tomorrow at 9am"  -> { head: "tomorrow",    time: 09:00 }
 * "3pm"              -> { head: "",            time: 15:00 }
 *
 * A bare number is NOT accepted as the trailing time: in "aug 5" the trailing
 * token is a day-of-month, not 5 o'clock. Only unambiguous times (with a colon,
 * a meridiem, or a name like "noon") get split off.
 */
function splitTrailingTime(text: string): {
	head: string;
	time: { hours: number; minutes: number } | null;
} {
	const withoutAt = text.replace(/\s+at\s+/g, ' ');
	const tokens = withoutAt.split(/\s+/).filter(Boolean);

	// Try the last one or two tokens as a time ("3 pm" splits into two tokens).
	// `take === tokens.length` is allowed so a bare time leaves an empty head.
	for (const take of [2, 1]) {
		if (tokens.length < take) continue;
		const candidate = tokens.slice(-take).join('');
		if (/^\d+$/.test(candidate)) continue;
		const time = parseTimeOfDay(candidate);
		if (time) {
			return { head: tokens.slice(0, tokens.length - take).join(' '), time };
		}
	}
	return { head: withoutAt.trim(), time: null };
}

/**
 * Parse a pure duration expression, possibly compound ("1d 4h", "2 weeks").
 * Returns the total offset in milliseconds, or null if any segment isn't a
 * duration (so "next friday" cleanly falls through to the calendar rules).
 */
function parseDurationMs(text: string): number | null {
	const normalized = text.replace(/^in\s+/, '').trim();
	if (!normalized) return null;

	// Match "<number><unit>" pairs, tolerating a space between them.
	const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
	let total = 0;
	let matched = 0;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(normalized)) !== null) {
		const value = parseFloat(match[1]);
		const unitText = match[2];
		const unit = DURATION_UNITS.find((u) => u.match.test(unitText));
		if (!unit) return null;
		total += value * unit.ms;
		matched += 1;
	}

	if (matched === 0) return null;

	// Reject leftovers like "2 weeks from bob": once the duration pairs are
	// removed, only separators ("and", commas, spaces) may remain.
	const leftover = normalized
		.replace(/(\d+(?:\.\d+)?)\s*([a-z]+)/g, ' ')
		.replace(/\band\b|,/g, ' ')
		.trim();
	if (leftover.length > 0) return null;

	return total;
}

/**
 * Resolve calendar keywords ("tomorrow", "next week", "this weekend", "monday").
 * `time` is the explicit time-of-day the user gave, if any.
 */
function parseKeyword(
	head: string,
	time: { hours: number; minutes: number } | null,
	now: Date
): Date | null {
	const text = head.trim();
	const defaultHour = time?.hours ?? SNOOZE_DEFAULT_HOUR;
	const defaultMinute = time?.minutes ?? 0;

	if (text === 'later' || text === 'later today') {
		return time ? atTime(now, time.hours, time.minutes) : new Date(now.getTime() + LATER_TODAY_MS);
	}

	if (text === 'tonight' || text === 'this evening') {
		return atTime(now, time?.hours ?? SNOOZE_EVENING_HOUR, defaultMinute);
	}

	if (text === 'today') {
		return atTime(now, defaultHour, defaultMinute);
	}

	if (text === 'tomorrow' || text === 'tmrw') {
		return atTime(addDays(now, 1), defaultHour, defaultMinute);
	}

	if (text === 'this weekend' || text === 'weekend') {
		// Saturday of the current week; if it's already the weekend, next Saturday.
		const day = now.getDay();
		const delta = day === 6 || day === 0 ? (day === 6 ? 7 : 6) : 6 - day;
		return atTime(addDays(now, delta), defaultHour, defaultMinute);
	}

	if (text === 'next week') {
		// The upcoming Monday, not Monday-of-the-week-after - "next week" on a
		// Wednesday means five days out, not twelve.
		return atTime(nextWeekday(now, 1, false), defaultHour, defaultMinute);
	}

	if (text === 'next month') {
		const next = new Date(now);
		next.setMonth(next.getMonth() + 1, 1);
		return atTime(next, defaultHour, defaultMinute);
	}

	if (text === 'next year') {
		const next = new Date(now);
		next.setFullYear(next.getFullYear() + 1, 0, 1);
		return atTime(next, defaultHour, defaultMinute);
	}

	// Weekday, optionally prefixed with "next" / "this".
	const weekdayMatch = /^(?:(next|this|on)\s+)?([a-z]+)$/.exec(text);
	if (weekdayMatch) {
		const weekday = WEEKDAYS[weekdayMatch[2]];
		if (weekday !== undefined) {
			const forceNextWeek = weekdayMatch[1] === 'next';
			return atTime(nextWeekday(now, weekday, forceNextWeek), defaultHour, defaultMinute);
		}
	}

	return null;
}

/**
 * The next occurrence of `weekday` strictly after today.
 * With `forceNextWeek`, "next monday" always skips into the following week even
 * when today is a Monday, matching how people say it.
 */
function nextWeekday(now: Date, weekday: number, forceNextWeek: boolean): Date {
	const today = now.getDay();
	let delta = (weekday - today + 7) % 7;
	if (delta === 0) delta = 7;
	if (forceNextWeek && delta < 7 && today !== weekday) {
		// "next friday" on a Wednesday means the Friday of next week.
		delta += 7;
	}
	return addDays(startOfDay(now), delta);
}

/**
 * Parse absolute date forms: ISO (2026-08-05), US slash (8/5, 12/25/2026),
 * and month-name (aug 5, august 5 2026, 5 august).
 */
function parseAbsoluteDate(
	head: string,
	time: { hours: number; minutes: number } | null,
	now: Date
): Date | null {
	const text = head.trim();
	const hours = time?.hours ?? SNOOZE_DEFAULT_HOUR;
	const minutes = time?.minutes ?? 0;

	// ISO: 2026-08-05
	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
	if (iso) {
		return buildDate(
			parseInt(iso[1], 10),
			parseInt(iso[2], 10) - 1,
			parseInt(iso[3], 10),
			hours,
			minutes
		);
	}

	// US slash: 8/5 or 12/25/2026 (month first - Maestro's users are US-centric
	// and the modal previews the resolved date, so the ambiguity is visible).
	const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(text);
	if (slash) {
		const month = parseInt(slash[1], 10) - 1;
		const day = parseInt(slash[2], 10);
		let year = slash[3] ? parseInt(slash[3], 10) : now.getFullYear();
		if (slash[3] && slash[3].length === 2) year += 2000;
		const built = buildDate(year, month, day, hours, minutes);
		// A bare month/day that already passed means next year.
		if (built && !slash[3] && built.getTime() < now.getTime()) {
			return buildDate(year + 1, month, day, hours, minutes);
		}
		return built;
	}

	// Month name: "aug 5", "august 5 2026", "5 aug"
	const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:(?:st|nd|rd|th))?(?:,?\s+(\d{4}))?$/.exec(text);
	const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/.exec(text);
	const named = monthFirst
		? { month: monthFirst[1], day: monthFirst[2], year: monthFirst[3] }
		: dayFirst
			? { month: dayFirst[2], day: dayFirst[1], year: dayFirst[3] }
			: null;

	if (named) {
		const month = MONTHS[named.month];
		if (month !== undefined) {
			const day = parseInt(named.day, 10);
			const year = named.year ? parseInt(named.year, 10) : now.getFullYear();
			const built = buildDate(year, month, day, hours, minutes);
			if (built && !named.year && built.getTime() < now.getTime()) {
				return buildDate(year + 1, month, day, hours, minutes);
			}
			return built;
		}
	}

	return null;
}

/**
 * Build a local Date, rejecting overflow (e.g. Feb 31 rolling into March).
 */
function buildDate(
	year: number,
	month: number,
	day: number,
	hours: number,
	minutes: number
): Date | null {
	if (month < 0 || month > 11 || day < 1 || day > 31) return null;
	const date = new Date(year, month, day, hours, minutes, 0, 0);
	if (date.getMonth() !== month || date.getDate() !== day) return null;
	return date;
}

/**
 * Resolve free-form snooze text to an absolute timestamp.
 *
 * Accepts durations ("1d", "10h", "2 weeks", "1d 4h"), calendar keywords
 * ("tomorrow", "next week", "next month", "this weekend"), weekdays
 * ("friday", "next mon 3pm"), bare times ("3pm" - today if still ahead, else
 * tomorrow), and absolute dates ("2026-08-05", "aug 5", "12/25 6pm").
 *
 * @param input - Raw user text
 * @param now   - Instant to resolve relative expressions against
 * @returns The resolved timestamp, or a human-readable error
 */
export function parseSnoozeInput(input: string, now: number = Date.now()): SnoozeParseResult {
	const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
	if (!text) return { ok: false, error: 'Enter a time like "2h", "tomorrow", or "aug 5"' };

	const nowDate = new Date(now);

	// Pure duration ("in 2 hours", "1d 4h"). Checked first so "1 month" reads as
	// a duration rather than falling into the month-name branch.
	const durationMs = parseDurationMs(text);
	if (durationMs !== null) {
		return finalize(now + durationMs, now);
	}

	// Whole-text keywords first. "tonight" is also a valid time-of-day name, and
	// the keyword reading (6pm *today*, which correctly fails once it's past)
	// must win over the bare-time reading (which would roll to tomorrow).
	const wholeTextKeyword = parseKeyword(text, null, nowDate);
	if (wholeTextKeyword) return finalize(wholeTextKeyword.getTime(), now);

	const { head, time } = splitTrailingTime(text);

	// A bare time with no date ("3pm") means today, or tomorrow if already past.
	if (!head && time) {
		let target = atTime(nowDate, time.hours, time.minutes);
		if (target.getTime() <= now) target = addDays(target, 1);
		return finalize(target.getTime(), now);
	}

	const keyword = parseKeyword(head, time, nowDate);
	if (keyword) return finalize(keyword.getTime(), now);

	const absolute = parseAbsoluteDate(head, time, nowDate);
	if (absolute) return finalize(absolute.getTime(), now);

	return { ok: false, error: `Couldn't read "${input.trim()}" as a date or duration` };
}

function finalize(at: number, now: number): SnoozeParseResult {
	if (!Number.isFinite(at)) {
		return { ok: false, error: 'That resolves to an invalid date' };
	}
	if (at - now < MIN_SNOOZE_MS) {
		return { ok: false, error: 'Pick a time at least a minute from now' };
	}
	// Round down to the minute so the preview and the fire time agree.
	return { ok: true, at: Math.floor(at / MS.minute) * MS.minute };
}

/**
 * Quick-pick presets shown as buttons in the snooze modal.
 * Each resolves through {@link parseSnoozeInput} so the buttons and typed input
 * can never disagree about what "tomorrow" means.
 */
export const SNOOZE_PRESETS: Array<{ id: string; label: string; expression: string }> = [
	{ id: 'later', label: 'Later today', expression: 'later today' },
	{ id: 'tonight', label: 'This evening', expression: 'tonight' },
	{ id: 'tomorrow', label: 'Tomorrow', expression: 'tomorrow' },
	{ id: 'weekend', label: 'This weekend', expression: 'this weekend' },
	{ id: 'nextWeek', label: 'Next week', expression: 'next week' },
	{ id: 'nextMonth', label: 'Next month', expression: 'next month' },
];

/**
 * Absolute display for a snooze target, e.g. "Tue, Aug 5 at 9:00 AM".
 * Includes the year when the target falls outside the current year.
 */
export function formatSnoozeTarget(at: number, now: number = Date.now()): string {
	const date = new Date(at);
	const includeYear = date.getFullYear() !== new Date(now).getFullYear();
	const day = date.toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(includeYear ? { year: 'numeric' } : {}),
	});
	const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	return `${day} at ${time}`;
}

/**
 * Coarse relative countdown for list rows, e.g. "in 3 days", "in 2 hours".
 * Returns "now" once the target has passed (a wake that hasn't swept yet).
 */
export function formatSnoozeCountdown(at: number, now: number = Date.now()): string {
	const delta = at - now;
	if (delta <= 0) return 'now';
	if (delta < MS.hour) {
		const minutes = Math.max(1, Math.round(delta / MS.minute));
		return `in ${minutes} min`;
	}
	if (delta < MS.day) {
		const hours = Math.round(delta / MS.hour);
		return `in ${hours} hour${hours === 1 ? '' : 's'}`;
	}
	const days = Math.round(delta / MS.day);
	if (days < 14) return `in ${days} day${days === 1 ? '' : 's'}`;
	const weeks = Math.round(days / 7);
	if (weeks < 9) return `in ${weeks} weeks`;
	const months = Math.round(days / 30);
	return `in ${months} month${months === 1 ? '' : 's'}`;
}
