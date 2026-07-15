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
 *    reached", "quota exceeded", "resets at …"). Backing off in seconds is
 *    pointless; the quota resets on a clock. If we can parse a reset time from
 *    the error we wait until then; otherwise we wait 1h and retry every hour.
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
/** Fallback wait for token exhaustion when no reset time can be parsed: 1h. */
export const TOKEN_EXHAUSTION_FALLBACK_DELAY_MS = 60 * 60 * 1000;
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
 */
const AVAILABILITY_RE =
	/overloaded|\b529\b|\b503\b|\b502\b|\b500\b|service\s+(?:unavailable|overloaded)|temporarily\s+(?:unavailable|overloaded)|too\s+many\s+requests|rate\s+limit|\b429\b|try\s+again/i;

/** The minimal shape {@link classifyRetryableError} needs from an AgentError. */
export interface ClassifiableError {
	type: AgentErrorType;
	message: string;
	recoverable: boolean;
	/** Optional structured payload from the agent; may carry a reset/retry hint. */
	parsedJson?: unknown;
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

	const message = error.message ?? '';
	if (TOKEN_EXHAUSTION_RE.test(message)) return 'token-exhaustion';
	if (AVAILABILITY_RE.test(message) || error.type === 'network_error') return 'availability';
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
 * Best-effort: reads a structured retry/reset hint from `parsedJson`, then falls
 * back to a `retry after N seconds/minutes` phrase in the message. When nothing
 * parseable is found returns `now + 1h` (the hourly fallback). We deliberately
 * do NOT parse wall-clock phrases like "resets at 3pm" - timezone/locale
 * ambiguity makes a wrong guess worse than the reliable hourly poll.
 *
 * @param error the failing error
 * @param now   current epoch ms (injectable for tests)
 */
export function tokenExhaustionResetAt(error: ClassifiableError, now: number): number {
	const fromJson = parseResetFromJson(error.parsedJson, now);
	if (fromJson !== undefined) return fromJson + RESET_TIME_BUFFER_MS;

	const fromMessage = parseRetryAfterFromMessage(error.message ?? '', now);
	if (fromMessage !== undefined) return fromMessage + RESET_TIME_BUFFER_MS;

	return now + TOKEN_EXHAUSTION_FALLBACK_DELAY_MS;
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

function parseResetFromJson(parsedJson: unknown, now: number): number | undefined {
	if (!parsedJson || typeof parsedJson !== 'object') return undefined;
	const record = parsedJson as Record<string, unknown>;
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
