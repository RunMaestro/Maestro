import { describe, expect, it } from 'vitest';
import { buildActivityGraphAxisLabels } from '../../../../renderer/components/History/activityGraphAxis';

const formatDate = (date: Date, timeZone: string) =>
	date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });

const range = {
	start: Date.parse('2025-03-09T05:00:00.000Z'),
	end: Date.parse('2025-03-10T05:00:00.000Z'),
};

describe('buildActivityGraphAxisLabels', () => {
	it('keeps all-time labels and positions stable across a DST boundary', () => {
		expect(
			buildActivityGraphAxisLabels({
				range,
				bucketCount: 24,
				lookbackHours: null,
				timeZone: 'America/New_York',
				formatDate,
			})
		).toEqual([
			{ label: 'Mar 9', index: 0 },
			{ label: 'Now', index: 23 },
		]);
	});

	it.each([
		[24, 24, ['24h', '16h', '8h', '0h'], [0, 8, 16, 23]],
		[72, 24, ['3d', '1d', 'Now'], [0, 12, 23]],
		[168, 28, ['7d', '3d', 'Now'], [0, 14, 27]],
	] as const)(
		'keeps %ih labels and exact bucket positions',
		(lookbackHours, bucketCount, labels, indexes) => {
			const axis = buildActivityGraphAxisLabels({
				range,
				bucketCount,
				lookbackHours,
				timeZone: 'America/New_York',
				formatDate,
			});

			expect(axis.map((item) => item.label)).toEqual(labels);
			expect(axis.map((item) => item.index)).toEqual(indexes);
		}
	);

	it('uses the injected timezone-aware formatter for a long empty graph range', () => {
		expect(
			buildActivityGraphAxisLabels({
				range: {
					start: Date.parse('2025-01-01T00:00:00.000Z'),
					end: Date.parse('2025-12-31T23:59:59.000Z'),
				},
				bucketCount: 24,
				lookbackHours: 720,
				timeZone: 'America/Los_Angeles',
				formatDate,
			})
		).toEqual([
			{ label: 'Dec 31', index: 0 },
			{ label: 'Now', index: 23 },
		]);
	});
});
