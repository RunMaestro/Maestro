/**
 * Tests for shared/retryClassification.ts - Agent Resilience retry strategy.
 */

import { describe, it, expect } from 'vitest';
import {
	classifyRetryableError,
	availabilityDelayMs,
	tokenExhaustionResetAt,
	tokenExhaustionDelayMs,
	AVAILABILITY_BASE_DELAY_MS,
	AVAILABILITY_MAX_DELAY_MS,
	TOKEN_EXHAUSTION_POLL_BASE_MS,
	TOKEN_EXHAUSTION_POLL_MAX_MS,
	RESET_TIME_BUFFER_MS,
	type ClassifiableError,
} from '../../shared/retryClassification';
import type { AgentErrorType } from '../../shared/types';

function err(partial: Partial<ClassifiableError> & { message: string }): ClassifiableError {
	return {
		type: 'rate_limited',
		recoverable: true,
		...partial,
	};
}

/**
 * The 2026-09-16 report: Codex refused a model with a hard HTTP 400 and Maestro
 * drew "Service overloaded - auto-retrying" over it, probing every 30 minutes
 * with no attempt cap while the one actionable instruction - upgrade the CLI -
 * sat behind a dismissible banner. Nothing in the payload was ambiguous; the
 * only thing that matched was the phrase "try again" at the end of an apology.
 */
describe('a permanently fatal request is never retried', () => {
	const gpt6Astra = {
		type: 'error',
		status: 400,
		error: {
			type: 'invalid_request_error',
			message:
				"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
		},
	};

	it('does not retry the reported gpt-6-astra 400', () => {
		expect(
			classifyRetryableError(
				err({
					message:
						"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
					parsedJson: gpt6Astra,
				})
			)
		).toBeNull();
	});

	it('reads the status structurally, whatever the prose says', () => {
		// The sentence names a quota, so without the structural gate this would
		// route to the wait-for-reset strategy and wait out a limit that is not
		// the reason the request failed.
		expect(
			classifyRetryableError(
				err({ message: 'usage limit reached', parsedJson: { type: 'error', status: 400 } })
			)
		).toBeNull();
	});

	it('reads a provider error type when no status is given', () => {
		expect(
			classifyRetryableError(
				err({
					message: 'something went wrong, please try again later',
					parsedJson: { error: { type: 'invalid_request_error' } },
				})
			)
		).toBeNull();
	});

	it('falls back to prose for providers that send no structure', () => {
		for (const message of [
			'This model requires a newer version of Codex. Please try again later.',
			'Unsupported model: gpt-6-astra',
			'model not found',
		]) {
			expect(classifyRetryableError(err({ message }))).toBeNull();
		}
	});

	// The two 4xx that DO clear on their own must be untouched, and 429 in
	// particular has to stay available to the token-exhaustion strategy.
	it('leaves 408 and 429 retryable', () => {
		expect(
			classifyRetryableError(
				err({
					message: 'Request timed out. Please try again later.',
					parsedJson: { type: 'error', status: 408 },
				})
			)
		).toBe('availability');
		expect(
			classifyRetryableError(
				err({ message: 'usage limit reached', parsedJson: { type: 'error', status: 429 } })
			)
		).toBe('token-exhaustion');
	});

	// The tightened pattern must not cost us the errors it was written for.
	it('still retries real transient failures', () => {
		expect(classifyRetryableError(err({ message: 'Overloaded, please try again later' }))).toBe(
			'availability'
		);
		expect(classifyRetryableError(err({ message: 'API Error: 529 Overloaded' }))).toBe(
			'availability'
		);
		expect(
			classifyRetryableError(err({ message: 'Service is busy. Try again in a few minutes.' }))
		).toBe('availability');
	});

	// A bare "try again" is the closing words of an apology, not a signal.
	it('does not read a bare "try again" as a retry signal', () => {
		expect(
			classifyRetryableError(err({ message: 'Something broke. Please fix it and try again.' }))
		).toBeNull();
	});
});

describe('classifyRetryableError', () => {
	it('classifies overload/529/5xx/throttle messages as availability', () => {
		for (const message of [
			'API Error: 529 Overloaded',
			'API Error: Overloaded',
			'The service is currently overloaded. Please try again later.',
			'503 Service Unavailable',
			'HTTP 502 Bad Gateway',
			'Too many requests',
			'Rate limit exceeded. Please wait a moment before trying again.',
			'429 error',
		]) {
			expect(classifyRetryableError(err({ message }))).toBe('availability');
		}
	});

	it('classifies plan/quota exhaustion messages as token-exhaustion', () => {
		for (const message of [
			'Usage limit reached. Check your plan for available quota.',
			'Your API quota has been exceeded. Resume when quota resets.',
			'You have hit your weekly limit',
			'5-hour limit reached',
			'Out of credits',
			'Limit reached, resets at 5pm',
		]) {
			expect(classifyRetryableError(err({ message }))).toBe('token-exhaustion');
		}
	});

	it('prefers token-exhaustion when a message mixes quota + rate-limit language', () => {
		// "usage limit reached, resets in 1 hour" contains both signals; the quota
		// meaning must win so we wait for the reset instead of fast-backing-off.
		expect(
			classifyRetryableError(err({ message: 'Usage limit reached, rate limit, resets in 1 hour' }))
		).toBe('token-exhaustion');
	});

	it('treats network errors as availability', () => {
		expect(
			classifyRetryableError(err({ type: 'network_error', message: 'Connection reset' }))
		).toBe('availability');
	});

	it('never auto-retries errors that need human action', () => {
		const humanTypes: AgentErrorType[] = [
			'auth_expired',
			'permission_denied',
			'session_not_found',
			'hitl_gate',
			'token_exhaustion', // context-window-full: resending can't help
			'agent_crashed',
		];
		for (const type of humanTypes) {
			expect(classifyRetryableError(err({ type, message: 'overloaded' }))).toBeNull();
		}
	});

	it('returns null for non-recoverable errors', () => {
		expect(classifyRetryableError(err({ recoverable: false, message: 'overloaded' }))).toBeNull();
	});

	it('returns null for unrecognized messages', () => {
		expect(classifyRetryableError(err({ type: 'unknown', message: 'something weird' }))).toBeNull();
	});
});

describe('availabilityDelayMs', () => {
	it('follows the 30s→30m doubling schedule', () => {
		const min = 60 * 1000;
		expect(availabilityDelayMs(0)).toBe(30 * 1000); // 30s
		expect(availabilityDelayMs(1)).toBe(1 * min); // 1m
		expect(availabilityDelayMs(2)).toBe(2 * min); // 2m
		expect(availabilityDelayMs(3)).toBe(4 * min); // 4m
		expect(availabilityDelayMs(4)).toBe(8 * min); // 8m
		expect(availabilityDelayMs(5)).toBe(16 * min); // 16m
	});

	it('caps at 30m and stays there for all later attempts', () => {
		expect(availabilityDelayMs(6)).toBe(AVAILABILITY_MAX_DELAY_MS); // would be 32m → 30m
		expect(availabilityDelayMs(7)).toBe(AVAILABILITY_MAX_DELAY_MS);
		expect(availabilityDelayMs(100)).toBe(AVAILABILITY_MAX_DELAY_MS);
		expect(availabilityDelayMs(1000)).toBe(AVAILABILITY_MAX_DELAY_MS);
	});

	it('clamps negative/fractional attempts to the base', () => {
		expect(availabilityDelayMs(-5)).toBe(AVAILABILITY_BASE_DELAY_MS);
		expect(availabilityDelayMs(0.9)).toBe(AVAILABILITY_BASE_DELAY_MS);
	});
});

describe('tokenExhaustionResetAt', () => {
	const now = 1_700_000_000_000; // fixed epoch ms

	// An unreadable reset is a real answer, not a failure: the caller polls
	// either way, so `undefined` costs nothing but the card's "Resets at" line.
	// This used to return `now + 1h`, which the caller then slept through whole.
	it('returns undefined when nothing parseable is present', () => {
		expect(tokenExhaustionResetAt(err({ message: 'Usage limit reached' }), now)).toBeUndefined();
	});

	it('reads relative seconds from parsedJson retryAfter', () => {
		const e = err({ message: 'quota exceeded', parsedJson: { retryAfter: 120 } });
		expect(tokenExhaustionResetAt(e, now)).toBe(now + 120 * 1000 + RESET_TIME_BUFFER_MS);
	});

	it('reads epoch-seconds reset timestamps from parsedJson', () => {
		const resetSeconds = Math.floor(now / 1000) + 3600;
		const e = err({ message: 'quota exceeded', parsedJson: { resetsAt: resetSeconds } });
		expect(tokenExhaustionResetAt(e, now)).toBe(resetSeconds * 1000 + RESET_TIME_BUFFER_MS);
	});

	it('reads epoch-ms reset timestamps from parsedJson', () => {
		const resetMs = now + 3_600_000;
		const e = err({ message: 'quota exceeded', parsedJson: { reset: resetMs } });
		expect(tokenExhaustionResetAt(e, now)).toBe(resetMs + RESET_TIME_BUFFER_MS);
	});

	it('parses "retry after N seconds/minutes/hours" from the message', () => {
		expect(tokenExhaustionResetAt(err({ message: 'retry after 45 seconds' }), now)).toBe(
			now + 45 * 1000 + RESET_TIME_BUFFER_MS
		);
		expect(tokenExhaustionResetAt(err({ message: 'try again in 10 minutes' }), now)).toBe(
			now + 10 * 60 * 1000 + RESET_TIME_BUFFER_MS
		);
		expect(tokenExhaustionResetAt(err({ message: 'wait 2 hours' }), now)).toBe(
			now + 2 * 60 * 60 * 1000 + RESET_TIME_BUFFER_MS
		);
	});

	// Claude Code's real plan-limit message puts the authoritative reset time in a
	// NESTED container. A top-level-only scan misses it and falls back to the
	// blind hourly poll, which is what made the retry land up to an hour late.
	it('reads quotaLimits.resetsAt from the real Claude limit payload', () => {
		const resetSeconds = 1787416800;
		const e = err({
			message: "You've hit your session limit · resets 11:40am (America/Chicago)",
			parsedJson: {
				error: 'rate_limit',
				isApiErrorMessage: true,
				quotaLimits: { status: 'rejected', resetsAt: resetSeconds, rateLimitType: 'five_hour' },
			},
		});
		expect(tokenExhaustionResetAt(e, now)).toBe(resetSeconds * 1000 + RESET_TIME_BUFFER_MS);
	});

	it('prefers a nested quota reset over a generic top-level retry hint', () => {
		// A top-level retryAfter is a hint for the REQUEST; the quota container is
		// the actual window. Taking the request hint would retry into the wall.
		const resetSeconds = Math.floor(now / 1000) + 7200;
		const e = err({
			message: 'usage limit reached',
			parsedJson: { retryAfter: 30, quotaLimits: { resetsAt: resetSeconds } },
		});
		expect(tokenExhaustionResetAt(e, now)).toBe(resetSeconds * 1000 + RESET_TIME_BUFFER_MS);
	});

	it('parses the legacy "usage limit reached|<epoch>" marker', () => {
		const resetSeconds = Math.floor(now / 1000) + 1800;
		const e = err({ message: `Claude AI usage limit reached|${resetSeconds}` });
		expect(tokenExhaustionResetAt(e, now)).toBe(resetSeconds * 1000 + RESET_TIME_BUFFER_MS);
	});

	describe('zoned wall-clock reset times', () => {
		// 2026-08-22T17:22:00Z = 12:22pm America/Chicago (CDT, UTC-5).
		const noon = Date.UTC(2026, 7, 22, 17, 22);

		it('resolves a same-day reset that is still ahead', () => {
			const e = err({
				message: "You've hit your session limit · resets 2:40pm (America/Chicago)",
			});
			expect(tokenExhaustionResetAt(e, noon)).toBe(
				Date.UTC(2026, 7, 22, 19, 40) + RESET_TIME_BUFFER_MS
			);
		});

		it('rolls a reset time that has already passed to the next day', () => {
			const e = err({
				message: "You've hit your session limit · resets 11:40am (America/Chicago)",
			});
			expect(tokenExhaustionResetAt(e, noon)).toBe(
				Date.UTC(2026, 7, 23, 16, 40) + RESET_TIME_BUFFER_MS
			);
		});

		it('handles a zone other than the local one', () => {
			// 9pm Europe/London (BST, UTC+1) on the same day.
			const e = err({ message: "You've hit your 5-hour limit · resets 9pm (Europe/London)" });
			expect(tokenExhaustionResetAt(e, noon)).toBe(
				Date.UTC(2026, 7, 22, 20, 0) + RESET_TIME_BUFFER_MS
			);
		});

		it('reads no reset from a wall clock with no zone', () => {
			const e = err({ message: 'usage limit reached, resets at 3pm' });
			expect(tokenExhaustionResetAt(e, noon)).toBeUndefined();
		});

		it('reads no reset from an unknown zone', () => {
			const e = err({ message: "You've hit your session limit · resets 3pm (Not/AZone)" });
			expect(tokenExhaustionResetAt(e, noon)).toBeUndefined();
		});
	});

	it('classifies the bare machine tag "rate_limit" as availability', () => {
		// Claude Code puts exactly this in the `error` field of a 429. A
		// whitespace-only pattern missed it, leaving a real rate limit unretryable.
		for (const message of ['rate_limit', 'rate-limit', 'rate_limited']) {
			expect(classifyRetryableError(err({ type: 'unknown', message }))).toBe('availability');
		}
	});

	it('classifies the Claude CLI limit notice as token-exhaustion', () => {
		expect(
			classifyRetryableError(
				err({ message: "You've hit your session limit · resets 11:40am (America/Chicago)" })
			)
		).toBe('token-exhaustion');
	});
});

// ============================================================================
// tokenExhaustionDelayMs - the spin, not the sleep
// ============================================================================

describe('tokenExhaustionDelayMs', () => {
	const now = 1_700_000_000_000;
	const minute = 60 * 1000;
	/** The steady-state floor: every probe from the third on waits this long. */
	const floor = 15 * minute;

	it('probes twice quickly, then holds at the 15 minute floor', () => {
		// Two fast probes catch a stale notice or an account the user already
		// switched. Everything after that is a quota coming back on a clock
		// measured in hours, so it is polled at the floor and not faster.
		expect(tokenExhaustionDelayMs(0, undefined, now)).toBe(15 * 1000);
		expect(tokenExhaustionDelayMs(1, undefined, now)).toBe(minute);
		expect(tokenExhaustionDelayMs(2, undefined, now)).toBe(floor);
		expect(tokenExhaustionDelayMs(3, undefined, now)).toBe(floor);
		expect(tokenExhaustionDelayMs(500, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_MAX_MS);
	});

	// A doubling ramp to the same ceiling reaches the floor on the seventh probe,
	// roughly 31 minutes in, so the first half hour of a four-hour outage is
	// still spent probing. The floor has to arrive on probe 3, not eventually.
	it('reaches the floor by the third probe rather than ramping into it', () => {
		expect(tokenExhaustionDelayMs(2, undefined, now)).toBe(floor);
		const firstHour = [0, 1, 2, 3].map((a) => tokenExhaustionDelayMs(a, undefined, now));
		expect(firstHour.reduce((a, b) => a + b, 0)).toBeGreaterThan(30 * minute);
	});

	it('clamps negative and fractional attempts to the first probe', () => {
		expect(tokenExhaustionDelayMs(-5, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_BASE_MS);
		expect(tokenExhaustionDelayMs(0.9, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_BASE_MS);
	});

	// The whole point. A 5-hour window used to mean one attempt, five hours in;
	// an outage that cleared early - because the user swapped accounts, or the
	// notice named the wrong window - was invisible until the sleep expired.
	it('keeps polling through a reset that is hours away', () => {
		const resetAt = now + 5 * 60 * minute;
		expect(tokenExhaustionDelayMs(0, resetAt, now)).toBe(15 * 1000);
		expect(tokenExhaustionDelayMs(9, resetAt, now)).toBe(floor);
		expect(tokenExhaustionDelayMs(200, resetAt, now)).toBe(floor);
	});

	it('lands exactly on the reset when it arrives sooner than the next probe', () => {
		// 20s out at the floor: waiting the full 15 minutes would meet a known
		// reset roughly 14 minutes late, every time, for no reason.
		expect(tokenExhaustionDelayMs(5, now + 20 * 1000, now)).toBe(20 * 1000);
		expect(tokenExhaustionDelayMs(5, now + 90 * 1000, now)).toBe(90 * 1000);
	});

	// This is the guard on the clamp DIRECTION, and it is load-bearing. Clamping
	// the other way (waiting for a distant reset instead of the cadence) restores
	// the blind sleep this design replaced: the observed failure was a 2h26m
	// outage that cleared "after 0 retries" because Maestro looked exactly once,
	// at the end. A far-off reset must never stretch the wait past the floor.
	it('never waits LONGER than the floor just because a reset is far away', () => {
		expect(tokenExhaustionDelayMs(5, now + 30 * minute, now)).toBe(floor);
		expect(tokenExhaustionDelayMs(5, now + 4 * 60 * minute, now)).toBe(floor);
	});

	it('goes on polling once the reset has come and gone', () => {
		// The provider said the quota would be back and it was not. That is a
		// reason to keep asking, not to stop.
		expect(tokenExhaustionDelayMs(4, now - 60 * minute, now)).toBe(floor);
		expect(tokenExhaustionDelayMs(4, now, now)).toBe(floor);
	});

	it('never returns a delay that could stall the loop', () => {
		for (let attempt = 0; attempt < 40; attempt++) {
			for (const resetAt of [undefined, now - 1, now, now + 1, now + 10 * minute]) {
				const delay = tokenExhaustionDelayMs(attempt, resetAt, now);
				expect(delay).toBeGreaterThan(0);
				expect(delay).toBeLessThanOrEqual(TOKEN_EXHAUSTION_POLL_MAX_MS);
			}
		}
	});
});

/**
 * The provider's own error text (`raw.errorLine`).
 *
 * Codex's parser replaces `message` with the pattern bank's curated wording, so
 * before this the scheduler saw "Rate limited. Please wait and try again." for a
 * multi-hour quota outage and ran the 30s availability backoff against it. These
 * cover the decision being made off the real line while display keeps using
 * `message`.
 */
describe('classifying off the provider raw line', () => {
	it('reads exhaustion out of the raw line when the curated message hides it', () => {
		const error = err({
			// What the Codex bank rewrote it to.
			message: 'Rate limited. Please wait and try again.',
			// What Codex actually printed.
			raw: { errorLine: "429 - you've hit your usage limit for this plan" },
		});

		expect(classifyRetryableError(error)).toBe('token-exhaustion');
	});

	it('prefers exhaustion when the raw line carries both signals', () => {
		// A throttle read as a quota outage only waits too long; a quota outage
		// read as a throttle hammers the provider for hours.
		const error = err({
			message: 'Rate limit exceeded. Please wait before trying again.',
			raw: { errorLine: 'rate limit: usage limit reached for your plan' },
		});

		expect(classifyRetryableError(error)).toBe('token-exhaustion');
	});

	it('still classifies from message alone when there is no raw line', () => {
		expect(classifyRetryableError(err({ message: '429 error' }))).toBe('availability');
		expect(classifyRetryableError(err({ message: 'usage limit reached' }))).toBe(
			'token-exhaustion'
		);
	});

	it('ignores a blank raw line rather than treating it as a text', () => {
		expect(classifyRetryableError(err({ message: 'usage limit reached', raw: {} }))).toBe(
			'token-exhaustion'
		);
		expect(
			classifyRetryableError(err({ message: 'usage limit reached', raw: { errorLine: '   ' } }))
		).toBe('token-exhaustion');
	});

	it('recovers a reset time that only the raw line carries', () => {
		const now = Date.UTC(2026, 8, 16, 12, 0, 0);
		const error = err({
			message: 'Usage limit reached. Please wait or check your plan quota.',
			raw: { errorLine: 'You have hit your usage limit. Try again in 4h 12m.' },
		});

		const resetAt = tokenExhaustionResetAt(error, now);

		// The point of this case is that a hint is recovered AT ALL: before the raw
		// line was carried, `message` was the curated bank wording and this was
		// `undefined`, so the scheduler had nothing but its fixed poll.
		//
		// The value is 4h, not 4h12m: `parseRetryAfterFromMessage` reads a single
		// leading unit and ignores the trailing minutes. That is a pre-existing
		// limit of the parser, unrelated to where the text came from, and it errs
		// EARLY (probing 12 minutes before the quota is back costs one refused
		// request), so it is pinned here rather than quietly fixed.
		expect(resetAt).toBe(now + 4 * 60 * 60 * 1000 + RESET_TIME_BUFFER_MS);
	});

	it('leaves the reset undefined when neither text names one', () => {
		const now = Date.UTC(2026, 8, 16, 12, 0, 0);
		const error = err({
			message: 'Usage limit reached. Please wait or check your plan quota.',
			raw: { errorLine: 'stream error: usage limit reached' },
		});

		expect(tokenExhaustionResetAt(error, now)).toBeUndefined();
	});
});
