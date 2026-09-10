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
	const min = 60 * 1000;

	it('ramps 15s, 30s, then holds at one probe a minute', () => {
		expect(tokenExhaustionDelayMs(0, undefined, now)).toBe(15 * 1000);
		expect(tokenExhaustionDelayMs(1, undefined, now)).toBe(30 * 1000);
		expect(tokenExhaustionDelayMs(2, undefined, now)).toBe(min);
		expect(tokenExhaustionDelayMs(3, undefined, now)).toBe(min);
		expect(tokenExhaustionDelayMs(500, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_MAX_MS);
	});

	it('clamps negative and fractional attempts to the first probe', () => {
		expect(tokenExhaustionDelayMs(-5, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_BASE_MS);
		expect(tokenExhaustionDelayMs(0.9, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_BASE_MS);
	});

	// The whole point. A 5-hour window used to mean one attempt, five hours in;
	// an outage that cleared early - because the user swapped accounts, or the
	// notice named the wrong window - was invisible until the sleep expired.
	it('keeps polling through a reset that is hours away', () => {
		const resetAt = now + 5 * 60 * min;
		expect(tokenExhaustionDelayMs(0, resetAt, now)).toBe(15 * 1000);
		expect(tokenExhaustionDelayMs(9, resetAt, now)).toBe(min);
		expect(tokenExhaustionDelayMs(200, resetAt, now)).toBe(min);
	});

	it('lands exactly on the reset when it arrives sooner than the next probe', () => {
		// 20s out with a 60s cadence: waiting the full minute would meet a known
		// reset 40s late, every time, for no reason.
		expect(tokenExhaustionDelayMs(5, now + 20 * 1000, now)).toBe(20 * 1000);
		// ...but never LATER than the cadence, which is the sleep this replaced.
		expect(tokenExhaustionDelayMs(5, now + 90 * 1000, now)).toBe(min);
	});

	it('goes on polling once the reset has come and gone', () => {
		// The provider said the quota would be back and it was not. That is a
		// reason to keep asking, not to stop.
		expect(tokenExhaustionDelayMs(4, now - 60 * min, now)).toBe(min);
		expect(tokenExhaustionDelayMs(4, now, now)).toBe(min);
	});

	it('never returns a delay that could stall the loop', () => {
		for (let attempt = 0; attempt < 40; attempt++) {
			for (const resetAt of [undefined, now - 1, now, now + 1, now + 10 * min]) {
				const delay = tokenExhaustionDelayMs(attempt, resetAt, now);
				expect(delay).toBeGreaterThan(0);
				expect(delay).toBeLessThanOrEqual(TOKEN_EXHAUSTION_POLL_MAX_MS);
			}
		}
	});
});
