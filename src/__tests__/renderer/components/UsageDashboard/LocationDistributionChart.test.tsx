import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { COLORBLIND_BINARY_PALETTE } from '../../../../renderer/constants/colorblindPalettes';
import { LocationDistributionChart } from '../../../../renderer/components/UsageDashboard/LocationDistributionChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Theme } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

function makeAggregation(byLocation: StatsAggregation['byLocation']): StatsAggregation {
	return {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byLocation,
		byDay: [],
		byHour: [],
		totalSessions: 0,
		sessionsByAgent: {},
		sessionsByDay: [],
		avgSessionDuration: 0,
		byAgentByDay: {},
		bySessionByDay: {},
	};
}

function withAccent(accent: string): Theme {
	return {
		...theme,
		colors: {
			...theme.colors,
			accent,
		},
	};
}

describe('LocationDistributionChart', () => {
	it('renders an accessible empty state when location data is absent', () => {
		const dataWithoutLocations = {
			...makeAggregation({ local: 0, remote: 0 }),
			byLocation: undefined,
		} as unknown as StatsAggregation;

		render(<LocationDistributionChart data={dataWithoutLocations} theme={theme} />);

		expect(screen.getByRole('figure')).toHaveAccessibleName(/location distribution chart/i);
		expect(screen.getByText('Session Location')).toBeInTheDocument();
		expect(screen.getByText('No location data available')).toBeInTheDocument();
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('renders mixed local and remote counts with percentages, K formatting, and chart hover state', () => {
		const data = makeAggregation({ local: 1000, remote: 500 });

		const { container } = render(<LocationDistributionChart data={data} theme={theme} />);

		expect(
			screen.getByRole('img', { name: /donut chart: local 66\.7%, ssh remote 33\.3%/i })
		).toBeInTheDocument();
		expect(screen.getByText('1.5K')).toBeInTheDocument();

		const legend = screen.getByRole('list', { name: 'Chart legend' });
		const localItem = within(legend).getByRole('listitem', { name: 'Local: 66.7%' });
		const remoteItem = within(legend).getByRole('listitem', { name: 'SSH Remote: 33.3%' });
		expect(within(localItem).getByText('1.0K', { exact: false })).toBeInTheDocument();
		expect(within(remoteItem).getByText('500', { exact: false })).toBeInTheDocument();

		const paths = container.querySelectorAll('path');
		expect(paths).toHaveLength(2);
		expect(paths[0]).toHaveAttribute('fill', theme.colors.accent);
		expect(paths[1]).toHaveAttribute('fill', '#059669');
		expect(paths[0]).toHaveAttribute('opacity', '1');
		expect(paths[1]).toHaveAttribute('opacity', '1');

		fireEvent.mouseEnter(paths[0]);

		expect(paths[0]).toHaveAttribute('opacity', '1');
		expect(paths[1]).toHaveAttribute('opacity', '0.5');
		expect(paths[0].getAttribute('d')).toContain('A 74 74');

		fireEvent.mouseLeave(paths[0]);

		expect(paths[1]).toHaveAttribute('opacity', '1');
	});

	it('highlights legend entries and uses colorblind-safe swatches when enabled', () => {
		const data = makeAggregation({ local: 2, remote: 2 });

		const { container } = render(
			<LocationDistributionChart data={data} theme={theme} colorBlindMode />
		);

		const paths = container.querySelectorAll('path');
		expect(paths[0]).toHaveAttribute('fill', COLORBLIND_BINARY_PALETTE.primary);
		expect(paths[1]).toHaveAttribute('fill', COLORBLIND_BINARY_PALETTE.secondary);

		const legend = screen.getByRole('list', { name: 'Chart legend' });
		const localItem = within(legend).getByRole('listitem', { name: 'Local: 50.0%' });
		const localLabel = within(localItem).getByText('Local');
		expect(localLabel).toHaveStyle({ color: theme.colors.textDim });

		fireEvent.mouseEnter(localItem);

		expect(localLabel).toHaveStyle({ color: theme.colors.textMain });
		expect(paths[1]).toHaveAttribute('opacity', '0.5');

		fireEvent.mouseLeave(localItem);

		expect(localLabel).toHaveStyle({ color: theme.colors.textDim });
		expect(paths[1]).toHaveAttribute('opacity', '1');
	});

	it('renders local-only and remote-only full-circle distributions with large-number formatting', () => {
		const { rerender, container } = render(
			<LocationDistributionChart
				data={makeAggregation({ local: 1_500_000, remote: 0 })}
				theme={theme}
			/>
		);

		expect(screen.getByRole('img', { name: /local 100\.0%/i })).toBeInTheDocument();
		expect(screen.queryByRole('listitem', { name: /ssh remote/i })).not.toBeInTheDocument();
		expect(screen.getByText('1.5M')).toBeInTheDocument();
		expect(container.querySelector('path')?.getAttribute('d')).toContain('A 70 70');

		rerender(
			<LocationDistributionChart
				data={makeAggregation({ local: 0, remote: 1_500_000 })}
				theme={withAccent('var(--accent)')}
			/>
		);

		expect(screen.getByRole('img', { name: /ssh remote 100\.0%/i })).toBeInTheDocument();
		expect(screen.queryByRole('listitem', { name: /^local/i })).not.toBeInTheDocument();
		expect(screen.getByRole('listitem', { name: 'SSH Remote: 100.0%' })).toBeInTheDocument();
		expect(container.querySelector('path')).toHaveAttribute('fill', '#22c55e');
	});

	it('treats malformed negative counts as zero', () => {
		render(
			<LocationDistributionChart data={makeAggregation({ local: -5, remote: 10 })} theme={theme} />
		);

		expect(screen.getByRole('img', { name: /ssh remote 100\.0%/i })).toBeInTheDocument();
		expect(screen.queryByRole('listitem', { name: /^local/i })).not.toBeInTheDocument();
		expect(screen.getByText('10')).toBeInTheDocument();
	});

	it('chooses the dark-accent remote color for rgb theme accents', () => {
		const { container } = render(
			<LocationDistributionChart
				data={makeAggregation({ local: 1, remote: 1 })}
				theme={withAccent('rgb(10, 20, 30)')}
			/>
		);

		expect(container.querySelectorAll('path')[1]).toHaveAttribute('fill', '#34d399');
	});

	it('falls back to the default remote color when an rgb accent cannot be parsed', () => {
		const { container } = render(
			<LocationDistributionChart
				data={makeAggregation({ local: 1, remote: 1 })}
				theme={withAccent('rgb(10)')}
			/>
		);

		expect(container.querySelectorAll('path')[1]).toHaveAttribute('fill', '#22c55e');
	});
});
