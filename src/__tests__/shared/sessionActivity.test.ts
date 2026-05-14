/**
 * Tests for shared/sessionActivity.ts — the `isActive` threshold helper that
 * decides whether an externally-observed session is still "thinking".
 */

import { describe, it, expect } from 'vitest';
import {
	EXTERNAL_ACTIVITY_ACTIVE_MS,
	EXTERNAL_ACTIVITY_IDLE_MS,
	isActive,
	type SessionActivityEvent,
} from '../../shared/sessionActivity';

function makeEvent(lastActivityAt: number): SessionActivityEvent {
	return {
		agentId: 'claude-code',
		sessionId: 'sess-1',
		projectPath: '/tmp/project',
		lastActivityAt,
		source: 'external',
		sizeBytes: 1234,
	};
}

describe('sessionActivity', () => {
	describe('constants', () => {
		it('exposes the active and idle thresholds', () => {
			expect(EXTERNAL_ACTIVITY_ACTIVE_MS).toBe(3000);
			expect(EXTERNAL_ACTIVITY_IDLE_MS).toBe(30000);
		});

		it('idle threshold is strictly greater than active threshold', () => {
			expect(EXTERNAL_ACTIVITY_IDLE_MS).toBeGreaterThan(EXTERNAL_ACTIVITY_ACTIVE_MS);
		});
	});

	describe('isActive', () => {
		const now = 1_700_000_000_000;

		it('returns true when activity is in the same millisecond as now', () => {
			expect(isActive(makeEvent(now), now)).toBe(true);
		});

		it('returns true 1ms before the active boundary', () => {
			const event = makeEvent(now - (EXTERNAL_ACTIVITY_ACTIVE_MS - 1));
			expect(isActive(event, now)).toBe(true);
		});

		it('returns true exactly at the active boundary (inclusive)', () => {
			const event = makeEvent(now - EXTERNAL_ACTIVITY_ACTIVE_MS);
			expect(isActive(event, now)).toBe(true);
		});

		it('returns false 1ms past the active boundary', () => {
			const event = makeEvent(now - (EXTERNAL_ACTIVITY_ACTIVE_MS + 1));
			expect(isActive(event, now)).toBe(false);
		});

		it('returns false for events well past the active window', () => {
			const event = makeEvent(now - EXTERNAL_ACTIVITY_IDLE_MS);
			expect(isActive(event, now)).toBe(false);
		});

		it('handles future timestamps as active (clock skew tolerance)', () => {
			// If the file's mtime is slightly ahead of `now` (e.g., clock skew),
			// `now - lastActivityAt` becomes negative and stays <= threshold.
			const event = makeEvent(now + 500);
			expect(isActive(event, now)).toBe(true);
		});

		it('uses Date.now() when `now` is omitted', () => {
			const fresh = makeEvent(Date.now());
			expect(isActive(fresh)).toBe(true);

			const stale = makeEvent(Date.now() - (EXTERNAL_ACTIVITY_ACTIVE_MS + 100));
			expect(isActive(stale)).toBe(false);
		});
	});
});
