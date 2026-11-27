/**
 * Tests for the quota panels' sample-age helpers.
 *
 * Covers:
 *   - newest sample wins across a multi-account snapshot map
 *   - unparseable / missing stamps are skipped rather than poisoning the max
 *   - a row whose own sample trails the newest one is flagged stale
 */

import { describe, it, expect } from 'vitest';
import {
	effectiveQuotaPercent,
	isQuotaWindowReset,
	isSampleBehindLatest,
	resolveLatestSampledAt,
	STALE_ROW_LAG_MS,
} from '../../../../renderer/components/UsageDashboard/quota/quotaFormatting';

const NOW = Date.parse('2026-05-15T12:00:00.000Z');

describe('resolveLatestSampledAt', () => {
	it('returns null when nothing has been sampled', () => {
		expect(resolveLatestSampledAt({})).toBeNull();
	});

	it('returns the newest stamp across accounts', () => {
		const latest = resolveLatestSampledAt({
			a: { sampledAt: '2026-05-15T10:00:00.000Z' },
			b: { sampledAt: '2026-05-15T11:30:00.000Z' },
			c: { sampledAt: '2026-05-15T09:00:00.000Z' },
		});
		expect(latest).toBe(Date.parse('2026-05-15T11:30:00.000Z'));
	});

	it('skips missing and unparseable stamps', () => {
		const latest = resolveLatestSampledAt({
			a: { sampledAt: 'not-a-date' },
			b: {},
			c: undefined,
			d: { sampledAt: '2026-05-15T09:00:00.000Z' },
		});
		expect(latest).toBe(Date.parse('2026-05-15T09:00:00.000Z'));
	});
});

describe('isSampleBehindLatest', () => {
	const at = (ms: number) => new Date(ms).toISOString();

	it('flags a sample trailing the newest by more than the lag', () => {
		expect(isSampleBehindLatest(at(NOW - STALE_ROW_LAG_MS - 60_000), NOW)).toBe(true);
	});

	it('does not flag a sample within the lag, or the newest sample itself', () => {
		expect(isSampleBehindLatest(at(NOW - STALE_ROW_LAG_MS), NOW)).toBe(false);
		expect(isSampleBehindLatest(at(NOW), NOW)).toBe(false);
	});

	it('does not flag a missing stamp, an unparseable one, or an empty panel', () => {
		expect(isSampleBehindLatest(undefined, NOW)).toBe(false);
		expect(isSampleBehindLatest('not-a-date', NOW)).toBe(false);
		expect(isSampleBehindLatest(at(NOW - 60 * 60_000), null)).toBe(false);
	});
});

describe('isQuotaWindowReset / effectiveQuotaPercent', () => {
	it('reads a window whose reset has passed as 0%', () => {
		const window = { percent: 96, resetsAt: '2026-05-15T11:00:00.000Z' };
		expect(isQuotaWindowReset(window.resetsAt, NOW)).toBe(true);
		expect(effectiveQuotaPercent(window, NOW)).toBe(0);
	});

	it('keeps the sampled percent while the window is still open', () => {
		const window = { percent: 96, resetsAt: '2026-05-15T13:00:00.000Z' };
		expect(isQuotaWindowReset(window.resetsAt, NOW)).toBe(false);
		expect(effectiveQuotaPercent(window, NOW)).toBe(96);
	});

	it('never treats a missing or unparseable reset time as passed', () => {
		expect(isQuotaWindowReset(undefined, NOW)).toBe(false);
		expect(isQuotaWindowReset('not a date', NOW)).toBe(false);
		expect(effectiveQuotaPercent({ percent: 40 }, NOW)).toBe(40);
	});
});
