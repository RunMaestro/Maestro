/**
 * Tests for PeakHoursChart component.
 *
 * Covers empty states, metric switching, peak-hour labeling, and tooltip
 * formatting for query counts and durations.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { PeakHoursChart } from '../../renderer/components/UsageDashboard/PeakHoursChart';
import type { StatsAggregation } from '../../renderer/hooks/stats/useStats';
import { THEMES } from '../../shared/themes';

const theme = THEMES['dracula'];

function makeAggregation(byHour: StatsAggregation['byHour'] = []): StatsAggregation {
	return {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byLocation: { local: 0, remote: 0 },
		byDay: [],
		byHour,
		totalSessions: 0,
		sessionsByAgent: {},
		sessionsByDay: [],
		avgSessionDuration: 0,
		byAgentByDay: {},
		bySessionByDay: {},
	};
}

function getHourCell(container: HTMLElement, hour: number): HTMLElement {
	const cells = container.querySelectorAll<HTMLElement>('.cursor-default');
	expect(cells).toHaveLength(24);
	return cells[hour];
}

describe('PeakHoursChart', () => {
	it('renders an empty state when no hourly query counts are available', () => {
		render(<PeakHoursChart data={makeAggregation()} theme={theme} />);

		expect(screen.getByRole('figure')).toHaveAccessibleName(/peak hours chart/i);
		expect(screen.getByText('Peak Hours')).toBeInTheDocument();
		expect(screen.getByText('No hourly data available')).toBeInTheDocument();
		expect(screen.queryByText('Peak:')).not.toBeInTheDocument();
	});

	it('treats missing hourly data as an empty state', () => {
		render(
			<PeakHoursChart data={{ ...makeAggregation(), byHour: undefined as never }} theme={theme} />
		);

		expect(screen.getByText('No hourly data available')).toBeInTheDocument();
	});

	it('shows count-mode peak hour and query tooltip using 12-hour labels', () => {
		const data = makeAggregation([
			{ hour: 0, count: 1, duration: 4_000 },
			{ hour: 12, count: 2, duration: 120_000 },
			{ hour: 13, count: 5, duration: 7_380_000 },
			{ hour: 23, count: 3, duration: 3_000 },
		]);
		const { container } = render(<PeakHoursChart data={data} theme={theme} />);

		expect(screen.getByText('Peak:')).toBeInTheDocument();
		expect(screen.getByText('1pm')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Count' })).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByRole('button', { name: 'Duration' })).toHaveAttribute(
			'aria-pressed',
			'false'
		);

		fireEvent.mouseEnter(getHourCell(container, 13));

		expect(screen.getByText('5 queries')).toBeInTheDocument();
		expect(screen.getAllByText('1pm').length).toBeGreaterThan(1);
	});

	it('switches to duration mode and formats seconds, minutes, and hours in tooltips', () => {
		const data = makeAggregation([
			{ hour: 0, count: 1, duration: 4_000 },
			{ hour: 4, count: 1, duration: 120_000 },
			{ hour: 13, count: 2, duration: 7_380_000 },
		]);
		const { container } = render(<PeakHoursChart data={data} theme={theme} />);

		fireEvent.click(screen.getByRole('button', { name: 'Duration' }));

		expect(screen.getByRole('button', { name: 'Count' })).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getByRole('button', { name: 'Duration' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(screen.getByText('Peak:').parentElement).toHaveTextContent('1pm');

		fireEvent.mouseEnter(getHourCell(container, 0));
		expect(screen.getByText('4s')).toBeInTheDocument();

		fireEvent.mouseLeave(getHourCell(container, 0));
		fireEvent.mouseEnter(getHourCell(container, 4));
		expect(screen.getByText('2m')).toBeInTheDocument();

		fireEvent.mouseLeave(getHourCell(container, 4));
		fireEvent.mouseEnter(getHourCell(container, 13));
		expect(screen.getByText('2h 3m')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Count' }));
		expect(screen.getByRole('button', { name: 'Count' })).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByRole('button', { name: 'Duration' })).toHaveAttribute(
			'aria-pressed',
			'false'
		);
		expect(screen.getByText('2 queries')).toBeInTheDocument();
	});
});
