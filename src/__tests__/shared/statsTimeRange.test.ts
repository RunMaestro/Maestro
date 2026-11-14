/**
 * Tests for where a Usage Dashboard time range starts. The stats database
 * filters rows with this and the renderer draws day axes from it, so both must
 * agree on every boundary.
 */

import { describe, it, expect } from 'vitest';
import { getTimeRangeStart } from '../../shared/statsTimeRange';
import { startOfLocalDay } from '../../shared/localDay';

const DAY = 24 * 60 * 60 * 1000;
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
	] as const)('starts "%s" %i days back', (range, days) => {
		expect(getTimeRangeStart(range, now)).toBe(now - days * DAY);
	});

	it('starts all time at 0', () => {
		expect(getTimeRangeStart('all', now)).toBe(0);
	});
});
