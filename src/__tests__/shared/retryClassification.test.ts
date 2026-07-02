/**
 * Tests for shared/retryClassification.ts — Agent Resilience retry strategy.
 */

import { describe, it, expect } from 'vitest';
import {
	classifyRetryableError,
	availabilityDelayMs,
	tokenExhaustionResetAt,
	AVAILABILITY_BASE_DELAY_MS,
	AVAILABILITY_MAX_DELAY_MS,
	TOKEN_EXHAUSTION_FALLBACK_DELAY_MS,
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

	it('falls back to now + 1h when nothing parseable is present', () => {
		expect(tokenExhaustionResetAt(err({ message: 'Usage limit reached' }), now)).toBe(
			now + TOKEN_EXHAUSTION_FALLBACK_DELAY_MS
		);
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
});
