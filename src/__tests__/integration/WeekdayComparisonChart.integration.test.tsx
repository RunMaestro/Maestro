import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WeekdayComparisonChart } from '../../renderer/components/UsageDashboard/WeekdayComparisonChart';
import type { StatsAggregation } from '../../renderer/hooks/stats/useStats';
import { THEMES } from '../../shared/themes';

const theme = THEMES.dracula;

function createStats(byDay: StatsAggregation['byDay']): StatsAggregation {
	const totalQueries = byDay.reduce((total, day) => total + day.count, 0);
	const totalDuration = byDay.reduce((total, day) => total + day.duration, 0);

	return {
		totalQueries,
		totalDuration,
		avgDuration: totalQueries > 0 ? totalDuration / totalQueries : 0,
		byAgent: {},
		bySource: { user: totalQueries, auto: 0 },
		byLocation: { local: totalQueries, remote: 0 },
		byDay,
		byHour: [],
		totalSessions: 0,
		sessionsByAgent: {},
		sessionsByDay: [],
		avgSessionDuration: 0,
		byAgentByDay: {},
		bySessionByDay: {},
	};
}

describe('WeekdayComparisonChart', () => {
	it('shows an empty state when there are no daily queries', () => {
		render(<WeekdayComparisonChart data={createStats([])} theme={theme} />);

		expect(screen.getByText('Weekday vs Weekend')).toBeInTheDocument();
		expect(screen.getByText('No daily data available')).toBeInTheDocument();
	});

	it('aggregates weekdays and weekends and formats minute and hour durations', () => {
		render(
			<WeekdayComparisonChart
				data={createStats([
					{ date: '2024-12-23', count: 2, duration: 7_200_000 },
					{ date: '2024-12-28', count: 1, duration: 90_000 },
				])}
				theme={theme}
			/>
		);

		expect(screen.getByText('Weekdays')).toBeInTheDocument();
		expect(screen.getByText('Weekends')).toBeInTheDocument();
		expect(screen.getByText('1h 0m')).toBeInTheDocument();
		expect(screen.getByText('1m 30s')).toBeInTheDocument();
		expect(
			screen.getByText((_, element) =>
				Boolean(
					element?.tagName.toLowerCase() === 'span' &&
					element.textContent?.includes('more active on weekdays')
				)
			)
		).toBeInTheDocument();
	});

	it('renders zero-duration averages for days with queries but no recorded time', () => {
		render(
			<WeekdayComparisonChart
				data={createStats([
					{ date: '2024-12-23', count: 1, duration: 0 },
					{ date: '2024-12-28', count: 1, duration: 0 },
				])}
				theme={theme}
			/>
		);

		expect(screen.getAllByText('0s')).toHaveLength(2);
		expect(screen.getByText('Weekdays')).toBeInTheDocument();
		expect(screen.getByText('Weekends')).toBeInTheDocument();
	});

	it('formats second-only average durations', () => {
		render(
			<WeekdayComparisonChart
				data={createStats([{ date: '2024-12-23T12:00:00', count: 1, duration: 45_000 }])}
				theme={theme}
			/>
		);

		expect(screen.getByText('45s')).toBeInTheDocument();
	});

	it('falls back to Date parsing for calendar-shaped invalid dates', () => {
		render(
			<WeekdayComparisonChart
				data={createStats([{ date: '2024-02-31', count: 3, duration: 3_000 }])}
				theme={theme}
			/>
		);

		expect(screen.getByText('Weekends')).toBeInTheDocument();
		expect(screen.getByText('100.0%')).toBeInTheDocument();
	});

	it('uses the colorblind-safe weekday and weekend palette', () => {
		const { container } = render(
			<WeekdayComparisonChart
				data={createStats([
					{ date: '2024-12-23', count: 2, duration: 2_000 },
					{ date: '2024-12-28', count: 1, duration: 1_000 },
				])}
				theme={theme}
				colorBlindMode
			/>
		);

		const styledElements = Array.from(container.querySelectorAll<HTMLElement>('[style]'));
		expect(styledElements.some((element) => element.style.color === 'rgb(0, 119, 187)')).toBe(true);
		expect(styledElements.some((element) => element.style.color === 'rgb(238, 119, 51)')).toBe(
			true
		);
	});

	it('shows similar activity when weekend days exist without weekend queries', () => {
		render(
			<WeekdayComparisonChart
				data={createStats([
					{ date: '2024-12-23', count: 1, duration: 1_000 },
					{ date: '2024-12-28', count: 0, duration: 0 },
				])}
				theme={theme}
			/>
		);

		expect(screen.getByText('Similar activity on weekdays and weekends')).toBeInTheDocument();
	});
});
