/**
 * Tests for the quota panels' "last refreshed" footer helpers.
 *
 * Covers:
 *   - newest sample wins across a multi-account snapshot map
 *   - unparseable / missing stamps are skipped rather than poisoning the max
 *   - sub-minute and future stamps both read "just now"
 *   - minute granularity, two rungs, spoken as prose
 */

import { describe, it, expect } from 'vitest';
import {
	formatLastRefreshed,
	resolveLatestSampledAt,
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

describe('formatLastRefreshed', () => {
	it('reads "just now" below a minute', () => {
		expect(formatLastRefreshed(NOW - 45_000, NOW)).toBe('just now');
	});

	it('reads "just now" for a stamp from the future (clock adjustment)', () => {
		expect(formatLastRefreshed(NOW + 120_000, NOW)).toBe('just now');
	});

	it('renders whole minutes', () => {
		expect(formatLastRefreshed(NOW - 10 * 60_000, NOW)).toBe('10 minutes ago');
		expect(formatLastRefreshed(NOW - 61_000, NOW)).toBe('1 minute ago');
	});

	it('renders hours and minutes together', () => {
		const elapsed = 5 * 60 * 60_000 + 25 * 60_000;
		expect(formatLastRefreshed(NOW - elapsed, NOW)).toBe('5 hours and 25 minutes ago');
	});

	it('never descends to seconds', () => {
		const elapsed = 2 * 60 * 60_000 + 59_000;
		expect(formatLastRefreshed(NOW - elapsed, NOW)).toBe('2 hours ago');
	});

	it('rolls into days for a stale panel', () => {
		const elapsed = 3 * 24 * 60 * 60_000 + 4 * 60 * 60_000;
		expect(formatLastRefreshed(NOW - elapsed, NOW)).toBe('3 days and 4 hours ago');
	});
});
