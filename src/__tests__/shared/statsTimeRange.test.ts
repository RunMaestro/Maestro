/**
 * Tests for where a Usage Dashboard time range starts. The stats database
 * filters rows with this and the renderer draws day axes from it, so both must
 * agree on every boundary.
 */

import { describe, it, expect } from 'vitest';
import { getTimeRangeStart } from '../../shared/statsTimeRange';
import { promptWindowStart } from '../../shared/promptCadence';
import { toLocalYmd } from '../../shared/localDay';
import { tokenUsageQueryForRange } from '../../shared/tokenUsage';
import { startOfLocalDay } from '../../shared/localDay';

const now = new Date(2026, 10, 14, 15, 30).getTime();

describe('getTimeRangeStart', () => {
	it('starts "day" at local midnight, not 24 hours ago', () => {
		expect(getTimeRangeStart('day', now)).toBe(startOfLocalDay(now));
	});

	it.each([
		['week', 7],
		['month', 30],
		['quarter', 90],
		['year', 365],
	] as const)('starts "%s" at local midnight, %i calendar days including today', (range, days) => {
		const expected = new Date(2026, 10, 14 - (days - 1)).getTime();
		expect(getTimeRangeStart(range, now)).toBe(expected);
	});

	it('crosses a DST change by calendar day, not by 24-hour steps', () => {
		// US DST ended 2026-11-01; a week starting 2026-10-30 still starts at midnight.
		const start = new Date(getTimeRangeStart('week', new Date(2026, 10, 5, 12).getTime()));
		expect([start.getHours(), start.getMinutes(), start.getDate()]).toEqual([0, 0, 30]);
	});

	it('starts all time at 0', () => {
		expect(getTimeRangeStart('all', now)).toBe(0);
	});
});

describe('one range start for every consumer', () => {
	it('gives the prompt cadence window the same first day as the stats database', () => {
		const firstPromptEver = new Date(2020, 0, 1).getTime();
		for (const range of ['day', 'week', 'month', 'quarter', 'year'] as const) {
			expect(promptWindowStart(range, firstPromptEver, now)).toBe(
				toLocalYmd(getTimeRangeStart(range, now))
			);
		}
	});

	it('gives the token-usage query the same start as the stats database', () => {
		for (const range of ['day', 'week', 'month', 'quarter', 'year'] as const) {
			expect(tokenUsageQueryForRange(range, now).sinceMs).toBe(getTimeRangeStart(range, now));
		}
	});
});
