/**
 * Tests for YearInPixelsStrip: cells straight from the gap-filled `byDay`,
 * range label from `getTimeRangeLabel`, one roving tab stop with arrow keys,
 * and a gapless row for long ranges so it fits a phone.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { YearInPixelsStrip } from '../../../../renderer/components/UsageDashboard/YearInPixelsStrip';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES } from '../../../../shared/themes';
import { addLocalDays } from '../../../../shared/localDay';

const theme = THEMES['dracula'];

function makeByDay(days: number, endYmd = '2026-03-07') {
	return Array.from({ length: days }, (_, i) => {
		const date = addLocalDays(endYmd, i - (days - 1));
		return { date, count: i % 3 === 0 ? i + 1 : 0, duration: 1_000 };
	});
}

function makeData(days: number, overrides: Partial<StatsAggregation> = {}): StatsAggregation {
	return { byDay: makeByDay(days), earliestQueryAt: null, ...overrides } as StatsAggregation;
}

function cells(): HTMLElement[] {
	return screen.getAllByRole('gridcell');
}

describe('YearInPixelsStrip', () => {
	it('draws exactly one cell per gap-filled day', () => {
		render(<YearInPixelsStrip data={makeData(7)} theme={theme} timeRange="week" />);
		expect(cells()).toHaveLength(7);
	});

	it('titles the strip with the shared range label', () => {
		render(<YearInPixelsStrip data={makeData(7)} theme={theme} timeRange="week" />);
		expect(screen.getByText('Last 7 Days')).toBeInTheDocument();
	});

	it('names the first recorded day on All Time', () => {
		const earliest = new Date(2026, 2, 1).getTime();
		render(
			<YearInPixelsStrip
				data={makeData(7, { earliestQueryAt: earliest })}
				theme={theme}
				timeRange="all"
			/>
		);
		expect(screen.getByText('All Time (since Mar 1, 2026)')).toBeInTheDocument();
	});

	it('hides on Today and when the range has no queries', () => {
		const { container, rerender } = render(
			<YearInPixelsStrip data={makeData(7)} theme={theme} timeRange="day" />
		);
		expect(container.firstChild).toBeNull();
		rerender(
			<YearInPixelsStrip
				data={{ byDay: makeByDay(7).map((d) => ({ ...d, count: 0 })) } as StatsAggregation}
				theme={theme}
				timeRange="week"
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it('is one tab stop, on today, until the user moves it', () => {
		render(<YearInPixelsStrip data={makeData(7)} theme={theme} timeRange="week" />);
		const tabbable = cells().filter((cell) => cell.tabIndex === 0);
		expect(tabbable).toHaveLength(1);
		expect(tabbable[0]).toBe(cells()[6]);
	});

	it('moves the tab stop and focus with the arrow, Home, and End keys', () => {
		render(<YearInPixelsStrip data={makeData(7)} theme={theme} timeRange="week" />);
		const last = cells()[6];
		last.focus();

		fireEvent.keyDown(last, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(cells()[5]);
		expect(cells()[5].tabIndex).toBe(0);
		expect(cells()[6].tabIndex).toBe(-1);

		fireEvent.keyDown(cells()[5], { key: 'Home' });
		expect(document.activeElement).toBe(cells()[0]);

		fireEvent.keyDown(cells()[0], { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(cells()[0]);

		fireEvent.keyDown(cells()[0], { key: 'End' });
		expect(document.activeElement).toBe(cells()[6]);
	});

	it('shows the focused day in a tooltip', () => {
		render(<YearInPixelsStrip data={makeData(7)} theme={theme} timeRange="week" />);
		fireEvent.focus(cells()[6]);
		expect(screen.getByText('Sat, Mar 7, 2026')).toBeInTheDocument();
	});

	it('keeps 1px gaps for short ranges and drops them past 120 days', () => {
		const { rerender } = render(
			<YearInPixelsStrip data={makeData(90)} theme={theme} timeRange="quarter" />
		);
		expect(screen.getByRole('grid')).toHaveAttribute('data-gapless', 'false');
		rerender(<YearInPixelsStrip data={makeData(365)} theme={theme} timeRange="year" />);
		expect(screen.getByRole('grid')).toHaveAttribute('data-gapless', 'true');
		expect(cells()).toHaveLength(365);
	});

	it('labels every cell with its date and query count', () => {
		render(<YearInPixelsStrip data={makeData(7)} theme={theme} timeRange="week" />);
		expect(cells()[0]).toHaveAttribute('aria-label', 'Sun, Mar 1, 2026: 1 query');
	});
});
