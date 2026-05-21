import { describe, it, expect } from 'vitest';
import {
	formatCacheAge,
	formatDate,
	compactNumber,
} from '../../../../../renderer/components/SymphonyModal/helpers/formatters';

describe('SymphonyModal/helpers/formatters', () => {
	describe('formatCacheAge', () => {
		it('returns "just now" for null', () => {
			expect(formatCacheAge(null)).toBe('just now');
		});

		it('returns "just now" for 0', () => {
			expect(formatCacheAge(0)).toBe('just now');
		});

		it('returns "just now" for sub-minute durations', () => {
			expect(formatCacheAge(15_000)).toBe('just now');
			expect(formatCacheAge(59_999)).toBe('just now');
		});

		it('formats minutes when below one hour', () => {
			expect(formatCacheAge(60_000)).toBe('1m ago');
			expect(formatCacheAge(45 * 60_000)).toBe('45m ago');
			expect(formatCacheAge(59 * 60_000)).toBe('59m ago');
		});

		it('formats whole hours when ≥ 1 hour', () => {
			expect(formatCacheAge(60 * 60_000)).toBe('1h ago');
			expect(formatCacheAge(2 * 60 * 60_000)).toBe('2h ago');
			expect(formatCacheAge(2.5 * 60 * 60_000)).toBe('2h ago');
		});

		it('handles multi-hour durations without overflow', () => {
			expect(formatCacheAge(25 * 60 * 60_000)).toBe('25h ago');
		});
	});

	describe('formatDate', () => {
		it('formats ISO dates as "MMM D, YYYY" in en-US locale', () => {
			expect(formatDate('2025-03-15T12:00:00Z')).toMatch(/Mar 1[45], 2025/);
		});

		it('is stable across the same input', () => {
			expect(formatDate('2024-12-31T23:59:59Z')).toBe(formatDate('2024-12-31T23:59:59Z'));
		});
	});

	describe('compactNumber', () => {
		it('formats numbers compactly with one fraction digit', () => {
			expect(compactNumber.format(0)).toBe('0');
			expect(compactNumber.format(999)).toBe('999');
			expect(compactNumber.format(1_000)).toBe('1K');
			expect(compactNumber.format(15_400)).toBe('15.4K');
			expect(compactNumber.format(1_200_000)).toBe('1.2M');
		});
	});
});
