/**
 * Tests for DurationTrendsChart.
 *
 * What matters:
 * - Means are weighted by query count (total duration / total queries), never
 *   an average of daily averages.
 * - The axis is the whole calendar window; a day without queries is a gap.
 * - Smoothing is a TRAILING average (no borrowing from later days) and the
 *   choice is remembered.
 * - Long windows switch to weekly slots, labeled by their span.
 * - The chart is the shared MultiLineChart: no per-point tab stops.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { StatsAggregation } from '../../../../shared/stats-types';
import { THEMES } from '../../../../shared/themes';

const storage = new Map<string, string>();
vi.mock('../../../../renderer/utils/safeLocalStorage', () => ({
	safeStorageGet: (key: string) => (storage.has(key) ? storage.get(key)! : null),
	safeStorageSet: (key: string, value: string) => {
		storage.set(key, value);
	},
}));

import {
	buildDurationSlots,
	DURATION_SMOOTHING_KEY,
	DurationTrendsChart,
	slotLabel,
	slotMeans,
	trailingMeans,
	WEEKLY_AFTER_DAYS,
} from '../../../../renderer/components/UsageDashboard/DurationTrendsChart';

const theme = THEMES['dracula'];

function aggregation(over: Partial<StatsAggregation>): StatsAggregation {
	return {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byDay: [],
		...over,
	} as StatsAggregation;
}

const week = aggregation({
	window: { startYmd: '2026-11-08', endYmd: '2026-11-14' },
	byDay: [
		{ date: '2026-11-09', count: 1, duration: 60_000 },
		{ date: '2026-11-10', count: 3, duration: 30_000 },
	],
});

describe('duration slot math', () => {
	it('fills the whole window, one slot per day', () => {
		const { slots, weekly } = buildDurationSlots(week);
		expect(weekly).toBe(false);
		expect(slots).toHaveLength(7);
		expect(slots[0]).toEqual({
			startYmd: '2026-11-08',
			endYmd: '2026-11-08',
			count: 0,
			duration: 0,
		});
	});

	it('weights each mean by query count and leaves empty days as gaps', () => {
		const { slots } = buildDurationSlots(week);
		const means = slotMeans(slots);
		expect(means[0]).toBeNull();
		expect(means[1]).toBe(60_000);
		expect(means[2]).toBe(10_000);
	});

	it('trails, never centers: a point never borrows from later days', () => {
		const { slots } = buildDurationSlots(week);
		const trailing = trailingMeans(slots, 7);
		// Day 1 sees only itself.
		expect(trailing[1]).toBe(60_000);
		// Day 2 pools both days by query count: 90s / 4 queries, not mean(60s, 10s).
		expect(trailing[2]).toBe(22_500);
		expect(trailing[0]).toBeNull();
	});

	it('switches to weekly slots on long windows, labeled by their span', () => {
		const { slots, weekly } = buildDurationSlots(
			aggregation({ window: { startYmd: '2026-01-01', endYmd: '2026-11-14' } })
		);
		expect(weekly).toBe(true);
		expect(slots.length).toBeLessThan(WEEKLY_AFTER_DAYS);
		expect(slots[0].startYmd).toBe('2026-01-01');
		expect(slots[0].endYmd).toBe('2026-01-07');
		expect(slotLabel(slots[0])).toContain(' - ');
	});
});

describe('DurationTrendsChart', () => {
	beforeEach(() => storage.clear());

	it('renders on the shared line chart with no per-point tab stops', () => {
		const { container } = render(<DurationTrendsChart data={week} theme={theme} />);
		expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		expect(container.querySelectorAll('circle[tabindex]')).toHaveLength(0);
		// No hour-of-day axis label on a daily chart.
		expect(container.textContent).not.toContain('00:00');
	});

	it('says so when the range has no queries', () => {
		render(
			<DurationTrendsChart
				data={aggregation({ window: { startYmd: '2026-11-08', endYmd: '2026-11-14' } })}
				theme={theme}
			/>
		);
		expect(screen.getByTestId('duration-trends-empty')).toHaveTextContent(
			'No queries in this range'
		);
	});

	it('adds the trailing average when smoothing is on, and remembers it', () => {
		const { unmount } = render(<DurationTrendsChart data={week} theme={theme} />);
		const toggle = screen.getByTestId('duration-trends-smoothing');
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		fireEvent.click(toggle);
		expect(storage.get(DURATION_SMOOTHING_KEY)).toBe('true');
		expect(screen.getByTestId('duration-trends-legend-trailing')).toBeInTheDocument();
		unmount();

		render(<DurationTrendsChart data={week} theme={theme} />);
		expect(screen.getByTestId('duration-trends-smoothing').getAttribute('aria-checked')).toBe(
			'true'
		);
	});
});
