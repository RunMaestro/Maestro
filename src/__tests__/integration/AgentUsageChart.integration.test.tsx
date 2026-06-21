/**
 * Tests for AgentUsageChart component.
 *
 * Covers session display names, metric switching, tooltip formatting, colorblind
 * colors, empty states, and time-range-specific axis labels.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { AgentUsageChart } from '../../renderer/components/UsageDashboard/AgentUsageChart';
import { COLORBLIND_AGENT_PALETTE } from '../../renderer/constants/colorblindPalettes';
import type { StatsAggregation, StatsTimeRange } from '../../renderer/hooks/stats/useStats';
import type { Session } from '../../renderer/types';
import { THEMES } from '../../shared/themes';

const theme = THEMES['dracula'];

function makeAggregation(
	bySessionByDay: StatsAggregation['bySessionByDay'] = {}
): StatsAggregation {
	return {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byLocation: { local: 0, remote: 0 },
		byDay: [],
		byHour: [],
		totalSessions: 0,
		sessionsByAgent: {},
		sessionsByDay: [],
		avgSessionDuration: 0,
		byAgentByDay: {},
		bySessionByDay,
	};
}

const namedSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const uuidOnlySessionId = '12345678-9999-8888-7777-666666666666-ai-tab';

const namedSessions = [
	{ id: namedSessionId, name: 'Planning Agent' },
	{ id: 'terminal-session', name: '', toolType: 'terminal' },
] as Session[];

describe('AgentUsageChart', () => {
	it('renders an empty state when there is no per-session usage breakdown', () => {
		const dataWithoutSessionBreakdown = {
			...makeAggregation(),
			bySessionByDay: undefined,
		} as unknown as StatsAggregation;

		render(<AgentUsageChart data={dataWithoutSessionBreakdown} timeRange="week" theme={theme} />);

		expect(screen.getByText('Agent Usage Over Time')).toBeInTheDocument();
		expect(screen.getByText('No usage data available')).toBeInTheDocument();
		expect(screen.getByRole('figure')).toHaveAccessibleName(/0 agents displayed/i);
	});

	it('maps session IDs to names, falls back to shared display names, and limits display to top agents', () => {
		const topAgents = Object.fromEntries(
			Array.from({ length: 8 }, (_, index) => [
				`extra-agent-${index}`,
				[{ date: '2024-12-20', count: 10 - index, duration: 1000 * (index + 1) }],
			])
		);
		const data = makeAggregation({
			[namedSessionId + '-ai-tab']: [
				{ date: '2024-12-20', count: 20, duration: 120_000 },
				{ date: '2024-12-21', count: 0, duration: 0 },
			],
			'terminal-session': [{ date: '2024-12-21', count: 7, duration: 70_000 }],
			[uuidOnlySessionId]: [{ date: '2024-12-21', count: 6, duration: 60_000 }],
			...topAgents,
			'tiny-agent': [{ date: '2024-12-20', count: 1, duration: 1000 }],
		});

		const { container } = render(
			<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={namedSessions} />
		);

		expect(screen.getByText('Planning Agent')).toBeInTheDocument();
		expect(screen.getByText('Terminal')).toBeInTheDocument();
		expect(screen.getByText('12345678 9999 8888 7777 666666666666 Ai Tab')).toBeInTheDocument();
		expect(screen.queryByText('Tiny Agent')).not.toBeInTheDocument();
		expect(screen.getByRole('img')).toHaveAccessibleName(/query counts per agent/i);
		expect(container.querySelectorAll('path[stroke]').length).toBe(10);
	});

	it('switches to duration mode and formats tooltip durations for hours, minutes, and zero', () => {
		const data = makeAggregation({
			slow: [{ date: '2024-12-20', count: 1, duration: 3_660_000 }],
			quick: [{ date: '2024-12-20', count: 2, duration: 65_000 }],
			fast: [{ date: '2024-12-20', count: 1, duration: 5000 }],
			'idle-duration': [{ date: '2024-12-20', count: 1, duration: 0 }],
		});

		const { container } = render(<AgentUsageChart data={data} timeRange="month" theme={theme} />);

		fireEvent.click(screen.getByRole('button', { name: 'Time' }));
		expect(screen.getByRole('figure')).toHaveAccessibleName(/duration over time/i);
		expect(screen.getAllByText('Time').length).toBeGreaterThanOrEqual(2);

		const firstPoint = container.querySelector('circle');
		expect(firstPoint).toBeInTheDocument();
		fireEvent.mouseEnter(firstPoint!);

		expect(screen.getByText('1h 1m')).toBeInTheDocument();
		expect(screen.getByText('1m 5s')).toBeInTheDocument();
		expect(screen.getByText('5s')).toBeInTheDocument();
		expect(screen.getByText('0s')).toBeInTheDocument();
	});

	it('switches back to query mode after showing duration metrics', () => {
		const data = makeAggregation({
			agent: [{ date: '2024-12-20', count: 3, duration: 3000 }],
		});

		render(<AgentUsageChart data={data} timeRange="week" theme={theme} />);

		fireEvent.click(screen.getByRole('button', { name: 'Time' }));
		expect(screen.getByRole('figure')).toHaveAccessibleName(/duration over time/i);

		fireEvent.click(screen.getByRole('button', { name: 'Queries' }));

		expect(screen.getByRole('figure')).toHaveAccessibleName(/query counts over time/i);
	});

	it('shows singular query counts on hover and clears the tooltip on mouse leave', () => {
		const data = makeAggregation({
			'solo-agent': [{ date: '2024-12-20', count: 1, duration: 5000 }],
		});

		const { container } = render(<AgentUsageChart data={data} timeRange="week" theme={theme} />);

		const point = container.querySelector('circle');
		expect(point).toBeInTheDocument();
		expect(point).toHaveAttribute('r', '4');

		fireEvent.mouseEnter(point!);
		expect(point).toHaveAttribute('r', '6');
		expect(screen.getByText('1 query')).toBeInTheDocument();

		fireEvent.mouseLeave(point!);
		expect(container.querySelector('.fixed.z-50')).not.toBeInTheDocument();
	});

	it('omits agents with no usage for the hovered day from the tooltip', () => {
		const data = makeAggregation({
			'active-first-day': [{ date: '2024-12-20', count: 2, duration: 5000 }],
			'active-second-day': [{ date: '2024-12-21', count: 4, duration: 7000 }],
		});

		const { container } = render(<AgentUsageChart data={data} timeRange="week" theme={theme} />);
		const points = container.querySelectorAll('circle');
		expect(points.length).toBeGreaterThan(0);

		const firstDayPoint = Array.from(points).find((point) => point.getAttribute('cx') === '50');
		expect(firstDayPoint).toBeInTheDocument();

		fireEvent.mouseEnter(firstDayPoint!);
		const tooltip = within(document.body);

		expect(tooltip.getByText('Active First Day:')).toBeInTheDocument();
		expect(tooltip.getByText('2 queries')).toBeInTheDocument();
		expect(tooltip.queryByText('Active Second Day:')).not.toBeInTheDocument();
		expect(tooltip.queryByText('4 queries')).not.toBeInTheDocument();
	});

	it('uses the colorblind-safe palette when colorblind mode is enabled', () => {
		const data = makeAggregation({
			agent: [{ date: '2024-12-20', count: 3, duration: 3000 }],
		});

		const { container } = render(
			<AgentUsageChart data={data} timeRange="week" theme={theme} colorBlindMode />
		);

		expect(container.querySelector('path[stroke]')).toHaveAttribute(
			'stroke',
			COLORBLIND_AGENT_PALETTE[0]
		);
	});

	it.each([
		['day', '05:30'],
		['week', 'Fri'],
		['month', 'Dec 20'],
		['quarter', 'Dec 20'],
		['year', 'Dec'],
		['all', 'Dec 2024'],
	] satisfies Array<[StatsTimeRange, string]>)(
		'renders %s-specific X-axis labels',
		(timeRange, expectedLabel) => {
			const data = makeAggregation({
				agent: [{ date: '2024-12-20T05:30:00', count: 3, duration: 3000 }],
			});

			render(<AgentUsageChart data={data} timeRange={timeRange} theme={theme} />);

			expect(screen.getByText(expectedLabel)).toBeInTheDocument();
		}
	);

	it('uses month-day labels for unknown time ranges', () => {
		const data = makeAggregation({
			agent: [{ date: '2024-12-20', count: 3, duration: 3000 }],
		});

		render(
			<AgentUsageChart data={data} timeRange={'unexpected' as StatsTimeRange} theme={theme} />
		);

		expect(screen.getByText('Dec 20')).toBeInTheDocument();
	});

	it('thins dense X-axis labels while keeping the final label visible', () => {
		const denseDays = Array.from({ length: 15 }, (_, index) => ({
			date: `2024-12-${String(index + 1).padStart(2, '0')}`,
			count: index + 1,
			duration: (index + 1) * 1000,
		}));

		render(
			<AgentUsageChart
				data={makeAggregation({ agent: denseDays })}
				timeRange="month"
				theme={theme}
			/>
		);

		expect(screen.getByText('Dec 1')).toBeInTheDocument();
		expect(screen.queryByText('Dec 2')).not.toBeInTheDocument();
		expect(screen.getByText('Dec 15')).toBeInTheDocument();
	});

	it('uses every other X-axis label for medium date ranges', () => {
		const mediumDays = Array.from({ length: 8 }, (_, index) => ({
			date: `2024-12-${String(index + 1).padStart(2, '0')}`,
			count: index + 1,
			duration: (index + 1) * 1000,
		}));

		render(
			<AgentUsageChart
				data={makeAggregation({ agent: mediumDays })}
				timeRange="month"
				theme={theme}
			/>
		);

		expect(screen.getByText('Dec 1')).toBeInTheDocument();
		expect(screen.queryByText('Dec 2')).not.toBeInTheDocument();
		expect(screen.getByText('Dec 8')).toBeInTheDocument();
	});

	it('treats a session with no dated entries as empty usage data', () => {
		render(
			<AgentUsageChart
				data={makeAggregation({ 'empty-session': [] })}
				timeRange="week"
				theme={theme}
			/>
		);

		expect(screen.getByText('No usage data available')).toBeInTheDocument();
	});
});
