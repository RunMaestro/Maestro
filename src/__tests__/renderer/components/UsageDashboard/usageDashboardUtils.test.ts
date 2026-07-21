import { describe, expect, it } from 'vitest';
import {
	buildSessionSparkline,
	formatUsageShortDate,
} from '../../../../renderer/components/UsageDashboard/usageDashboardUtils';

describe('usageDashboardUtils', () => {
	it('keeps the seven-point SVG scale stable for empty, short, and long series', () => {
		expect(buildSessionSparkline(undefined)).toEqual([0, 0, 0, 0, 0, 0, 0]);
		expect(buildSessionSparkline([{ count: 2 }, { count: 3 }])).toEqual([0, 0, 0, 0, 0, 2, 3]);
		expect(
			buildSessionSparkline([
				{ count: 1 },
				{ count: 2 },
				{ count: 3 },
				{ count: 4 },
				{ count: 5 },
				{ count: 6 },
				{ count: 7 },
				{ count: 8 },
			])
		).toEqual([2, 3, 4, 5, 6, 7, 8]);
	});

	it('formats local calendar dates with the dashboard locale and preserves malformed labels', () => {
		expect(formatUsageShortDate('2026-01-02')).toBe('Jan 2');
		expect(formatUsageShortDate('not-a-date')).toBe('not-a-date');
	});
});
