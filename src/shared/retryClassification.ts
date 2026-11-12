/**
 * Retry classification & backoff scheduling for Agent Resilience.
 *
 * When an agent turn fails with a recoverable upstream error, Maestro can
 * automatically resend the same prompt instead of making the user re-type it.
 * Two distinct failure modes get two distinct retry strategies:
 *
 *  - `'availability'` - transient upstream trouble (Anthropic/OpenAI/etc.
 *    "Overloaded", HTTP 529/5xx, "too many requests", rate-limit throttling).
 *    These clear on their own in seconds-to-minutes, so we use exponential
 *    backoff: 30s, 1m, 2m, 4m, 8m, 16m, then 30m repeating forever.
 *
 *  - `'token-exhaustion'` - the account's plan quota is depleted ("usage limit
 *    reached", "quota exceeded", "resets at …"). We POLL until it comes back:
 *    at 15s, then 60s, then once every 15 minutes for as long as the outage
 *    lasts, and exactly on the reset time when the error named one and it lands
 *    sooner than the next probe. A parsed reset is
 *    a hint about when to expect recovery, never the only moment we look - the
 *    account can be switched, the plan can roll over early, and the notice can
 *    name the wrong window. See {@link tokenExhaustionDelayMs}.
 *
 * This module is intentionally pure and dependency-free so it can run in either
 * the renderer or the main process. It classifies by MESSAGE CONTENT rather than
 * {@link AgentErrorType} because Maestro's taxonomy lumps plan-quota exhaustion
 * in with rate limits under `rate_limited` (while the `token_exhaustion` type
 * actually means the *context window* is full, which retrying can't fix).
 */

import type { AgentErrorType } from './types';

/** Which backoff strategy applies to a retryable error. */
export type RetryStrategy = 'availability' | 'token-exhaustion';

/** Base delay for the availability backoff: first retry waits 30s. */
export const AVAILABILITY_BASE_DELAY_MS = 30 * 1000;
/** Ceiling for the availability backoff: once reached, retries repeat every 30m. */
export const AVAILABILITY_MAX_DELAY_MS = 30 * 60 * 1000;
/**
 * The token-exhaustion poll cadence, written out rather than computed.
 *
 * An explicit table because the two things this schedule has to satisfy pull in
 * opposite directions, and a formula cannot express both. The first probes must
 * be quick, since the seconds right after a limit fires are when a stale notice
 * or an already-switched account is most likely. Everything after that must be
 * SLOW: a plan quota comes back on a clock measured in hours, and probing it
 * every minute is hundreds of refused requests that tell us nothing.
 *
 * A doubling ramp looks like it covers both and does not. Ramping from 15s to a
 * 15m ceiling takes seven probes and about 31 minutes to get there, so the whole
 * first half hour of a four-hour outage is spent probing - which is the
 * behaviour being fixed, just slower.
 *
 * Two quick probes, then the floor. The last entry repeats forever.
 */
export const TOKEN_EXHAUSTION_POLL_STEPS_MS: readonly number[] = [
	15 * 1000,
	60 * 1000,
	15 * 60 * 1000,
];
/** First token-exhaustion poll fires 15s after the limit is hit. */
export const TOKEN_EXHAUSTION_POLL_BASE_MS = TOKEN_EXHAUSTION_POLL_STEPS_MS[0];
/** Steady-state token-exhaustion poll: one probe every 15m, for as long as it takes. */
export const TOKEN_EXHAUSTION_POLL_MAX_MS =
	TOKEN_EXHAUSTION_POLL_STEPS_MS[TOKEN_EXHAUSTION_POLL_STEPS_MS.length - 1];
/** Small cushion added past a parsed reset time so the quota is actually back. */
export const RESET_TIME_BUFFER_MS = 5 * 1000;

/**
 * Error types we NEVER auto-retry: these need human action (re-auth, new
 * session, granting permission) and silently retrying them either loops
 * forever or hides a real problem. `token_exhaustion` here is Maestro's
 * context-window-full type - resending the same oversized prompt can't help.
 */
const NON_RETRYABLE_TYPES: ReadonlySet<AgentErrorType> = new Set<AgentErrorType>([
	'auth_expired',
	'permission_denied',
	'session_not_found',
	'hitl_gate',
	'token_exhaustion',
	'agent_crashed',
]);

/**
 * Plan/quota exhaustion phrasing. Checked BEFORE the availability pattern so a
 * message like "usage limit reached, resets at 5pm" routes to the wait-for-reset
 * strategy rather than the fast backoff.
 */
const TOKEN_EXHAUSTION_RE =
	/usage[\s-]?limit|quota\b[^.]*\bexceeded|exceeded\b[^.]*\bquota|hit your.*limit|plan\s+limit|weekly\s+limit|5[\s-]?hour\s+limit|limit\s+reached|reached your.*limit|out of (?:credits|tokens)|insufficient.*(?:quota|credit|balance)|resets?\s+(?:at|on|in)\b/i;

/**
 * Transient upstream availability / throttling phrasing. HTTP status codes use
 * word boundaries so we don't match ports or version numbers.
 *
 * `rate[\s_-]?limit` rather than `rate\s+limit`: providers send the machine tag
 * `rate_limit` (Claude Code puts exactly that in the `error` field of its
 * plan-limit message), and a whitespace-only pattern classified it as `unknown`,
 * which is not retryable - so a real 429 got no retry at all.
 *
 * `try again` REQUIRES a temporal qualifier. A bare `try\s+again` is a catch-all
 * for the closing words of an apology, and nearly every provider error ends with
 * one: a hard HTTP 400 reading "requires a newer version of Codex. Please
 * upgrade to the latest app or CLI and try again" matched on those two words
 * alone, drew "Service overloaded", and probed every 30 minutes forever - there
 * is no attempt cap - while the actionable message sat behind a banner. What a
 * genuinely transient error says is "try again LATER", so that is what is
 * matched.
 */
const AVAILABILITY_RE =
	/overloaded|\b529\b|\b503\b|\b502\b|\b500\b|service\s+(?:unavailable|overloaded)|temporarily\s+(?:unavailable|overloaded)|too\s+many\s+requests|rate[\s_-]?limit|\b429\b|try\s+again\s+(?:later|shortly|in\s+(?:a\s+(?:few|moment|bit)|\d))/i;

/**
 * HTTP statuses that describe a request no repetition can fix. 408 and 429 are
 * deliberately absent: a timeout and a throttle are the two 4xx that genuinely
 * do clear on their own, and 429 in particular has to stay available to the
 * token-exhaustion strategy.
 */
const PERMANENT_HTTP_STATUSES: ReadonlySet<number> = new Set([
	400, 401, 403, 404, 405, 409, 413, 422,
]);

/** Provider error types that name a permanent fault in the request itself. */
const PERMANENT_ERROR_TYPES: ReadonlySet<string> = new Set([
	'invalid_request_error',
	'not_found_error',
	'permission_error',
	'authentication_error',
]);

/**
 * Prose that names a permanent fault, for providers that hand us no structure.
 * Deliberately narrow: each phrase describes something the user must change -
 * the binary, the model name - rather than something that could clear on its own.
 */
const PERMANENT_FAILURE_RE =
	/invalid_request_error|requires\s+a\s+newer\s+version|upgrade\s+to\s+the\s+latest|unsupported\s+model|(?:model|engine)\s+not\s+found|unknown\s+model|no\s+such\s+model/i;

/**
 * Whether this error is permanently fatal, read STRUCTURALLY where possible.
 *
 * The prose is the last resort, not the first: a provider that tells us
 * `status: 400` and `invalid_request_error` has already answered the question,
 * and deciding it from the sentence instead is how a substring of an apology
 * came to schedule an unbounded retry loop.
 *
 * Pure and dependency-free, like the rest of this module, so both processes and
 * the CLI bundle can call it.
 */
function isPermanentFailure(error: ClassifiableError): boolean {
	const json = error.parsedJson;
	if (json && typeof json === 'object') {
		const obj = json as Record<string, unknown>;
		if (typeof obj.status === 'number' && PERMANENT_HTTP_STATUSES.has(obj.status)) return true;
		const inner = obj.error;
		if (inner && typeof inner === 'object') {
			const innerType = (inner as Record<string, unknown>).type;
			if (typeof innerType === 'string' && PERMANENT_ERROR_TYPES.has(innerType)) return true;
		}
		if (typeof obj.type === 'string' && PERMANENT_ERROR_TYPES.has(obj.type)) return true;
	}
	return classifiableTexts(error).some((text) => PERMANENT_FAILURE_RE.test(text));
}

/** The minimal shape {@link classifyRetryableError} needs from an AgentError. */
export interface ClassifiableError {
	type: AgentErrorType;
	message: string;
	recoverable: boolean;
	/** Optional structured payload from the agent; may carry a reset/retry hint. */
	parsedJson?: unknown;
	/**
	 * The provider's OWN error text, when the parser replaced `message` with a
	 * curated one from the pattern bank.
	 *
	 * Classification has to read this, not just `message`. A pattern bank entry
	 * is written for a human reading a dialog, so it is short and generic - and
	 * the two things this module needs are exactly what that rewrite destroys:
	 * the phrasing that separates a plan-quota outage from a transient throttle,
	 * and any "resets in 4h 12m" hint. Codex hit both: a 429 that also said
	 * "usage limit" came through as "Rate limited. Please wait and try again.",
	 * which reads as `'availability'` and ran a 30s backoff against a multi-hour
	 * quota outage.
	 *
	 * Display keeps using `message`, so populating this changes what Maestro
	 * DECIDES without changing what the user reads.
	 */
	raw?: { errorLine?: string };
}

/**
 * Every text this error carries, widest first.
 *
 * The provider's own line is checked BEFORE the curated message because it is
 * strictly more informative; the curated one stays in the list so an error that
 * only ever had a bank message still classifies exactly as it used to.
 */
function classifiableTexts(error: ClassifiableError): string[] {
	const texts: string[] = [];
	const rawLine = error.raw?.errorLine;
	if (typeof rawLine === 'string' && rawLine.trim() !== '') texts.push(rawLine);
	if (typeof error.message === 'string' && error.message !== '') texts.push(error.message);
	return texts;
}

/**
 * Decide which retry strategy (if any) applies to an error. Returns `null` when
 * the error should NOT be auto-retried (non-recoverable, needs human action, or
 * doesn't match a known transient pattern) - the caller then falls back to the
 * normal recovery modal.
 */
export function classifyRetryableError(error: ClassifiableError): RetryStrategy | null {
	if (!error.recoverable) return null;
	if (NON_RETRYABLE_TYPES.has(error.type)) return null;

	// Exhaustion is decided across EVERY text before availability is considered
	// for any of them, not per text in turn. A quota notice that also says "429"
	// carries both signals, and the slow poll is the safe reading: treating a
	// multi-hour outage as a transient throttle retries it every 30 seconds,
	// while the reverse merely waits a little longer than it had to.
	// Before either regex: a permanently fatal request must not be retried even
	// when its prose mentions a quota or ends in "try again". Excluding 429 from
	// the status list is what keeps a real quota throttle routed below instead.
	if (isPermanentFailure(error)) return null;

	const texts = classifiableTexts(error);
	if (texts.some((text) => TOKEN_EXHAUSTION_RE.test(text))) return 'token-exhaustion';
	if (texts.some((text) => AVAILABILITY_RE.test(text)) || error.type === 'network_error') {
		return 'availability';
	}
	return null;
}

/**
 * Delay before the next availability retry. `attempt` is 0-indexed (0 = the
 * first retry). Doubles from 30s and caps at 30m, after which every subsequent
 * attempt waits the 30m ceiling: 30s, 1m, 2m, 4m, 8m, 16m, 30m, 30m, …
 */
export function availabilityDelayMs(attempt: number): number {
	const safeAttempt = Math.max(0, Math.floor(attempt));
	// Guard the shift against absurd attempt counts (2 ** 31 overflows to a
	// negative int32 via `<<`, but ** stays a float - still clamp for sanity).
	if (safeAttempt >= 31) return AVAILABILITY_MAX_DELAY_MS;
	return Math.min(AVAILABILITY_BASE_DELAY_MS * 2 ** safeAttempt, AVAILABILITY_MAX_DELAY_MS);
}

/**
 * Absolute epoch-ms timestamp to wait until for a token-exhaustion retry.
 *
 * Best-effort, in descending order of confidence: a structured retry/reset hint
 * on `parsedJson`, a `retry after N seconds/minutes` phrase, the legacy
 * `usage limit reached|<epoch>` marker, then a wall-clock reset that names its
 * own IANA timezone ("resets 11:40am (America/Chicago)").
 *
 * Returns `undefined` when nothing parseable is found. That is a real answer,
 * not a failure: the caller polls regardless (see
 * {@link tokenExhaustionDelayMs}), so an unparsed reset costs nothing but a
 * missing "Resets at" line on the outage card. It used to return `now + 1h`,
 * which the caller then slept through in one go.
 *
 * A bare wall-clock phrase like "resets at 3pm" is still ignored: without a
 * zone the guess can be hours off. Claude Code's own notice carries the zone in
 * parentheses, which removes the ambiguity that made this unsafe. Guessing
 * early is cheap anyway - a premature retry just re-fails and reschedules.
 *
 * @param error the failing error
 * @param now   current epoch ms (injectable for tests)
 */
export function tokenExhaustionResetAt(error: ClassifiableError, now: number): number | undefined {
	const fromJson = parseResetFromJson(error.parsedJson, now);
	if (fromJson !== undefined) return fromJson + RESET_TIME_BUFFER_MS;

	// The provider's own line first: a curated bank message never carries a reset
	// hint, so for any agent whose parser rewrites `message` this is the only
	// place a "resets in 4h 12m" can still be read.
	for (const text of classifiableTexts(error)) {
		const fromMessage = parseRetryAfterFromMessage(text, now);
		if (fromMessage !== undefined) return fromMessage + RESET_TIME_BUFFER_MS;

		const fromEpochMarker = parseEpochMarkerFromMessage(text, now);
		if (fromEpochMarker !== undefined) return fromEpochMarker + RESET_TIME_BUFFER_MS;

		const fromClock = parseZonedResetFromMessage(text, now);
		if (fromClock !== undefined) return fromClock + RESET_TIME_BUFFER_MS;
	}

	return undefined;
}

/**
 * Delay before the next token-exhaustion attempt: a POLL, not a sleep.
 *
 * A depleted quota does come back on a clock, so the obvious implementation is
 * to parse the reset time and sleep until it. That is what this used to do, and
 * it is wrong in one direction that matters: it treats the provider's notice as
 * the only way the wait can end. It is not. The user can switch the agent to a
 * different account or provider, the plan can roll over early, the window named
 * in the message can be the wrong one, or the notice can simply be stale. A
 * single long sleep is blind to all of it - the observed failure was a 2h26m
 * outage that cleared "after 0 retries", meaning Maestro tried exactly once,
 * at the end, and had no idea what was true at any point in between.
 *
 * So we keep probing. Each probe is a real resend, because a real resend is the
 * only honest test of whether the quota is back - and it is nearly free when it
 * is not: the provider refuses before consuming tokens, and the outage card
 * updates in place rather than adding a transcript entry per attempt.
 *
 * Two rules:
 *
 *  1. **Never sleep past the expected reset.** When a reset time was parsed and
 *     it lands sooner than the next poll, wait exactly that long, so a known
 *     reset is met on the second rather than up to one poll interval late.
 *  2. **Otherwise poll on a fixed cadence**: 15s, 60s, then every 15 minutes for
 *     as long as it takes. The two early probes are quick because the first
 *     seconds are when a mis-parsed reset or an already-cleared limit is most
 *     likely; from the third probe on, the 15-minute floor keeps a four-hour
 *     outage to about sixteen refused requests per tab rather than 240.
 *
 * `attempt` is 0-indexed (0 = the first attempt of this outage).
 *
 * @param attempt   0-indexed attempt number within this outage
 * @param resetAt   parsed reset time, or undefined when none could be read
 * @param now       current epoch ms (injectable for tests)
 */
export function tokenExhaustionDelayMs(
	attempt: number,
	resetAt: number | undefined,
	now: number
): number {
	const safeAttempt = Math.max(0, Math.floor(attempt));
	// Straight table lookup, clamped to the last entry, which then repeats for
	// the rest of the outage. No exponent to guard against overflowing.
	const poll =
		TOKEN_EXHAUSTION_POLL_STEPS_MS[
			Math.min(safeAttempt, TOKEN_EXHAUSTION_POLL_STEPS_MS.length - 1)
		];

	if (resetAt === undefined) return poll;
	const untilReset = resetAt - now;
	// A reset already in the past tells us nothing new - keep polling.
	if (untilReset <= 0) return poll;
	return Math.min(poll, untilReset);
}

/** Recognized numeric hint fields on a structured error payload. */
const RESET_JSON_KEYS = [
	'retryAfter',
	'retry_after',
	'retryAfterSeconds',
	'resetAt',
	'resets_at',
	'resetsAt',
	'reset',
	'resetInSeconds',
	'resetsInSeconds',
] as const;

/**
 * Interpret a numeric hint as either an absolute time or an offset:
 *  - >= 1e12 → epoch milliseconds (use as-is)
 *  - >= 1e9  → epoch seconds (×1000)   [current-era epoch seconds are ~1.7e9; a
 *              relative offset would need to exceed 31 years to reach 1e9, so
 *              this cleanly separates absolute timestamps from second offsets]
 *  - otherwise → seconds from `now`
 */
function coerceResetNumber(value: number, now: number): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	if (value >= 1e12) return value; // epoch ms
	if (value >= 1e9) return value * 1000; // epoch seconds
	return now + value * 1000; // relative seconds
}

/**
 * Nested objects that carry a reset hint. Claude Code puts the authoritative
 * value at `quotaLimits.resetsAt` (epoch seconds) on its plan-limit message, so
 * a top-level-only scan misses the one field that makes the retry land on the
 * exact reset second rather than an hourly poll.
 */
const RESET_JSON_CONTAINERS = ['quotaLimits', 'quota_limits', 'rateLimit', 'rate_limit'] as const;

/** Scan one flat object for any recognized reset key. */
function scanResetKeys(record: Record<string, unknown>, now: number): number | undefined {
	for (const key of RESET_JSON_KEYS) {
		const raw = record[key];
		if (typeof raw === 'number') {
			const coerced = coerceResetNumber(raw, now);
			if (coerced !== undefined) return coerced;
		} else if (typeof raw === 'string' && raw.trim() !== '') {
			const num = Number(raw);
			if (Number.isFinite(num)) {
				const coerced = coerceResetNumber(num, now);
				if (coerced !== undefined) return coerced;
			}
		}
	}
	return undefined;
}

function parseResetFromJson(parsedJson: unknown, now: number): number | undefined {
	if (!parsedJson || typeof parsedJson !== 'object') return undefined;
	const record = parsedJson as Record<string, unknown>;

	// Prefer a nested quota container: when a provider sends both, the specific
	// one is the quota's real reset and any top-level value is a generic retry
	// hint for the request.
	for (const container of RESET_JSON_CONTAINERS) {
		const nested = record[container];
		if (nested && typeof nested === 'object') {
			const found = scanResetKeys(nested as Record<string, unknown>, now);
			if (found !== undefined) return found;
		}
	}

	return scanResetKeys(record, now);
}

/** Parse "retry after 30 seconds" / "try again in 5 minutes" style hints. */
function parseRetryAfterFromMessage(message: string, now: number): number | undefined {
	const seconds = /(?:retry after|try again in|wait)\s+(\d+)\s*(?:s|sec|secs|seconds?)\b/i.exec(
		message
	);
	if (seconds) return now + Number(seconds[1]) * 1000;

	const minutes = /(?:retry after|try again in|wait)\s+(\d+)\s*(?:m|min|mins|minutes?)\b/i.exec(
		message
	);
	if (minutes) return now + Number(minutes[1]) * 60 * 1000;

	const hours = /(?:retry after|try again in|wait)\s+(\d+)\s*(?:h|hr|hrs|hours?)\b/i.exec(message);
	if (hours) return now + Number(hours[1]) * 60 * 60 * 1000;

	return undefined;
}

/**
 * Parse Claude Code's legacy limit marker, which appends the reset epoch after a
 * pipe: "Claude AI usage limit reached|1755500000".
 */
function parseEpochMarkerFromMessage(message: string, now: number): number | undefined {
	const marker = /limit\s+reached\s*\|\s*(\d{9,13})\b/i.exec(message);
	if (!marker) return undefined;
	return coerceResetNumber(Number(marker[1]), now);
}

/**
 * Parse a reset time that names its own IANA zone, as Claude Code's notice does:
 * "You've hit your session limit - resets 11:40am (America/Chicago)".
 *
 * Resolves to the NEXT occurrence of that wall-clock time in that zone, which is
 * what every Claude plan window means (session/5-hour limits reset within the
 * day; a same-day time already past belongs to tomorrow).
 */
function parseZonedResetFromMessage(message: string, now: number): number | undefined {
	const match =
		/resets?\b[^()\n]*?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?[^()\n]*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/i.exec(
			message
		);
	if (!match) return undefined;

	const meridiem = match[3]?.toLowerCase();
	let hour = Number(match[1]);
	const minute = match[2] ? Number(match[2]) : 0;
	if (minute > 59) return undefined;
	if (meridiem) {
		if (hour < 1 || hour > 12) return undefined;
		if (meridiem === 'pm' && hour !== 12) hour += 12;
		if (meridiem === 'am' && hour === 12) hour = 0;
	} else if (hour > 23) {
		return undefined;
	}

	const timeZone = match[4];
	const target = nextZonedOccurrence(hour, minute, timeZone, now);
	// An unknown zone throws inside Intl; treat it as unparseable rather than
	// letting a typo'd notice take down the retry scheduler.
	return target;
}

/**
 * Epoch ms of the next moment at which the wall clock in `timeZone` reads
 * `hour:minute`, strictly after `now`. Returns undefined for an unusable zone.
 */
function nextZonedOccurrence(
	hour: number,
	minute: number,
	timeZone: string,
	now: number
): number | undefined {
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hour12: false,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	} catch {
		return undefined;
	}

	/** How far the zone's wall clock runs ahead of UTC at instant `utcMs`. */
	const offsetAt = (utcMs: number): number => {
		const parts = formatter.formatToParts(new Date(utcMs));
		const field = (type: string) => Number(parts.find((p) => p.type === type)?.value);
		// Some ICU builds render midnight as hour 24 under hour12:false.
		const h = field('hour') % 24;
		const asUtc = Date.UTC(
			field('year'),
			field('month') - 1,
			field('day'),
			h,
			field('minute'),
			field('second')
		);
		return asUtc - utcMs;
	};

	const firstOffset = offsetAt(now);
	if (!Number.isFinite(firstOffset)) return undefined;

	// "Today" as the zone sees it, then the requested wall time on that date.
	const localNow = new Date(now + firstOffset);
	const wallUtc = Date.UTC(
		localNow.getUTCFullYear(),
		localNow.getUTCMonth(),
		localNow.getUTCDate(),
		hour,
		minute
	);

	const DAY_MS = 24 * 60 * 60 * 1000;
	for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
		const guess = wallUtc + dayOffset * DAY_MS;
		// Two passes: the first offset may belong to the wrong side of a DST
		// transition, so re-resolve using the offset at the candidate instant.
		let candidate = guess - firstOffset;
		candidate = guess - offsetAt(candidate);
		if (candidate > now) return candidate;
	}

	return undefined;
}
