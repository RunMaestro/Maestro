/**
 * Tests for the shared donut (DistributionDonut), the Query Location chart that
 * uses it, and the accent helpers in delegationColors.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { DistributionDonut } from '../../../../renderer/components/UsageDashboard/DistributionDonut';
import { LocationDistributionChart } from '../../../../renderer/components/UsageDashboard/LocationDistributionChart';
import {
	accentBrightness,
	delegationColors,
} from '../../../../renderer/components/UsageDashboard/delegationColors';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Theme } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import { formatNumber } from '../../../../shared/formatters';

const theme = THEMES['dracula'];

function withAccent(accent: string): Theme {
	return { ...theme, colors: { ...theme.colors, accent } };
}

describe('DistributionDonut', () => {
	const slices = [
		{ key: 'a', label: 'Alpha', value: 30, color: '#ff0000' },
		{ key: 'b', label: 'Beta', value: 10, color: '#00ff00' },
		{ key: 'c', label: 'Gamma', value: 0, color: '#0000ff' },
	];

	function renderDonut() {
		return render(
			<DistributionDonut
				slices={slices}
				theme={theme}
				formatValue={formatNumber}
				centerCaption="queries"
				ariaLabel="Test donut"
			/>
		);
	}

	it('drops zero slices and prints shares and values in the legend', () => {
		renderDonut();
		const legend = screen.getByRole('list', { name: /chart legend/i });
		const items = within(legend).getAllByRole('listitem');
		expect(items.map((i) => i.getAttribute('aria-label'))).toEqual([
			'Alpha: 75.0%, 30',
			'Beta: 25.0%, 10',
		]);
		expect(screen.queryByTestId('donut-slice-c')).not.toBeInTheDocument();
	});

	it('shows the total and caption in the center and shares in the SVG name', () => {
		renderDonut();
		expect(screen.getByText('40')).toBeInTheDocument();
		expect(screen.getByText('queries')).toBeInTheDocument();
		expect(screen.getByRole('img')).toHaveAttribute(
			'aria-label',
			'Test donut: Alpha 75.0%, Beta 25.0%'
		);
	});

	it('shows a tooltip for the hovered slice and dims the others', () => {
		renderDonut();
		fireEvent.mouseEnter(screen.getByTestId('donut-slice-a'), { clientX: 5, clientY: 5 });
		expect(screen.getByTestId('donut-tooltip')).toHaveTextContent('Alpha');
		expect(screen.getByTestId('donut-tooltip')).toHaveTextContent('30 (75.0%)');
		expect(screen.getByTestId('donut-slice-b')).toHaveAttribute('opacity', '0.5');

		fireEvent.mouseLeave(screen.getByTestId('donut-slice-a'));
		expect(screen.queryByTestId('donut-tooltip')).not.toBeInTheDocument();
		expect(screen.getByTestId('donut-slice-b')).toHaveAttribute('opacity', '1');
	});

	it('does not mark slices as clickable', () => {
		renderDonut();
		expect(screen.getByTestId('donut-slice-a').style.cursor).toBe('');
	});
});

describe('LocationDistributionChart', () => {
	const data = { byLocation: { local: 90, remote: 10 } } as StatsAggregation;

	it('titles itself Query Location and splits local and SSH remote queries', () => {
		render(<LocationDistributionChart data={data} theme={theme} />);
		expect(screen.getByRole('heading', { name: 'Query Location' })).toBeInTheDocument();
		const legend = screen.getByRole('list', { name: /chart legend/i });
		expect(
			within(legend)
				.getAllByRole('listitem')
				.map((i) => i.getAttribute('aria-label'))
		).toEqual(['Local: 90.0%, 90', 'SSH Remote: 10.0%, 10']);
	});

	it('shows the shared empty state with no queries', () => {
		render(
			<LocationDistributionChart
				data={{ byLocation: { local: 0, remote: 0 } } as StatsAggregation}
				theme={theme}
			/>
		);
		expect(screen.getByText('No queries in this range')).toBeInTheDocument();
	});

	it('picks the darker emerald for a bright accent and the lighter one for a dark accent', () => {
		const { unmount } = render(
			<LocationDistributionChart data={data} theme={withAccent('#eeeeee')} />
		);
		expect(screen.getByTestId('donut-slice-remote')).toHaveAttribute('fill', '#059669');
		unmount();
		render(<LocationDistributionChart data={data} theme={withAccent('#111111')} />);
		expect(screen.getByTestId('donut-slice-remote')).toHaveAttribute('fill', '#34d399');
	});
});

describe('delegationColors', () => {
	it('reads the accent brightness from hex and rgb() colors', () => {
		expect(accentBrightness(withAccent('#ffffff'))).toBe(255);
		expect(accentBrightness(withAccent('rgb(0, 0, 0)'))).toBe(0);
		expect(accentBrightness(withAccent('hsl(0, 0%, 50%)'))).toBeNull();
	});

	it('mutes Auto Run against the accent, with a fallback for unreadable accents', () => {
		expect(delegationColors(withAccent('#eeeeee')).autoRun).toBe('#64748b');
		expect(delegationColors(withAccent('#111111')).autoRun).toBe('#94a3b8');
		expect(delegationColors(withAccent('hsl(0, 0%, 50%)')).autoRun).toBe('#6b7280');
	});
});
