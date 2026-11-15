/**
 * Tests for RadialActivityChart: the peak named with its AM/PM, "queries"
 * vocabulary, no clickable affordance on non-actionable slices.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { RadialActivityChart } from '../../../../renderer/components/UsageDashboard/RadialActivityChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

const data = {
	byHour: [
		{ hour: 5, count: 2, duration: 1_000 },
		{ hour: 17, count: 9, duration: 60_000 },
	],
	byDay: [
		// 2026-03-02 is a Monday.
		{ date: '2026-03-02', count: 8, duration: 1_000 },
		{ date: '2026-03-03', count: 1, duration: 1_000 },
		{ date: '2026-03-04', count: 0, duration: 0 },
	],
} as StatsAggregation;

describe('RadialActivityChart', () => {
	it('names the peak hour with its AM/PM so 5 PM never reads as 5 AM', () => {
		render(<RadialActivityChart mode="hours" data={data} theme={theme} />);
		expect(screen.getByText('5 PM')).toBeInTheDocument();
		expect(screen.getByText('peak hour')).toBeInTheDocument();
	});

	it('states the peak once: no footer repeating it', () => {
		render(<RadialActivityChart mode="hours" data={data} theme={theme} />);
		expect(screen.queryByText(/^Peak:/)).not.toBeInTheDocument();
		expect(screen.queryByText(/events/)).not.toBeInTheDocument();
	});

	it('buckets weekdays from local calendar days and names the peak day', () => {
		render(<RadialActivityChart mode="weekday" data={data} theme={theme} />);
		// The outer ring labels every weekday; the center repeats the peak one.
		expect(screen.getAllByText('Mon')).toHaveLength(2);
		expect(screen.getByText('peak day')).toBeInTheDocument();
	});

	it('shows an hour slot and a query count in the tooltip', () => {
		const { container } = render(<RadialActivityChart mode="hours" data={data} theme={theme} />);
		const slices = container.querySelectorAll('path');
		fireEvent.mouseEnter(slices[17], { clientX: 5, clientY: 5 });
		expect(screen.getByText('5 PM - 6 PM')).toBeInTheDocument();
		expect(screen.getByText('9 queries')).toBeInTheDocument();
	});

	it('does not show a pointer cursor on slices that do nothing when clicked', () => {
		const { container } = render(<RadialActivityChart mode="hours" data={data} theme={theme} />);
		container.querySelectorAll('path').forEach((path) => {
			expect((path as unknown as HTMLElement).style.cursor).toBe('');
		});
	});

	it('shows the shared empty state with no queries', () => {
		render(
			<RadialActivityChart
				mode="hours"
				data={{ byHour: [], byDay: [] } as unknown as StatsAggregation}
				theme={theme}
			/>
		);
		expect(screen.getByText('No queries in this range')).toBeInTheDocument();
	});
});
