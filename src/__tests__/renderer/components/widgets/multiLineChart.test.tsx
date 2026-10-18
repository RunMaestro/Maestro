/**
 * Tests for MultiLineChart (shared widget library): gaps for missing data, the
 * legend as a hide/show control (never hiding the last series), axis label
 * thinning, and the hover tooltip.
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MultiLineChart, type LineSeries } from '../../../../renderer/components/widgets';
import { mockTheme } from '../../../helpers/mockTheme';

const LABELS = ['Mon', 'Tue', 'Wed', 'Thu'];

function series(): LineSeries[] {
	return [
		{ key: 'a', label: 'Alpha', color: '#111111', values: [1, 2, null, 4] },
		{ key: 'b', label: 'Beta', color: '#222222', values: [10, null, null, 20], dashed: true },
	];
}

function renderChart(overrides: Partial<Parameters<typeof MultiLineChart>[0]> = {}) {
	return render(
		<MultiLineChart
			theme={mockTheme}
			ariaLabel="Rates"
			xLabels={LABELS}
			series={series()}
			testId="chart"
			{...overrides}
		/>
	);
}

describe('MultiLineChart', () => {
	it('breaks a line at a gap instead of drawing it through zero', () => {
		const { container } = renderChart();
		const svg = screen.getByRole('img', { name: 'Rates' });

		// Alpha: run [0,1] as a polyline + lone point 3 as a dot.
		// Beta: lone points 0 and 3 as dots, dashed style only on polylines.
		const polylines = svg.querySelectorAll('polyline');
		expect(polylines).toHaveLength(1);
		expect(polylines[0].getAttribute('stroke')).toBe('#111111');
		const dots = Array.from(container.querySelectorAll('line')).filter(
			(l) => l.getAttribute('stroke-width') === '6'
		);
		expect(dots).toHaveLength(3);
	});

	it('scales the y axis to the visible series', () => {
		renderChart({ formatValue: (v) => `${v}/s` });
		expect(screen.getByText('20/s')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('chart-legend-b'));

		expect(screen.getByTestId('chart-legend-b').getAttribute('aria-pressed')).toBe('false');
		expect(screen.getByText('4/s')).toBeInTheDocument();
		expect(screen.queryByText('20/s')).not.toBeInTheDocument();
	});

	it('never hides the last visible series', () => {
		renderChart();
		fireEvent.click(screen.getByTestId('chart-legend-b'));

		const lastOn = screen.getByTestId('chart-legend-a');
		expect(lastOn).toBeDisabled();
		fireEvent.click(lastOn);
		expect(lastOn.getAttribute('aria-pressed')).toBe('true');
	});

	it('thins axis labels but always keeps the first and last', () => {
		const many = Array.from({ length: 30 }, (_, i) => `d${i}`);
		renderChart({
			xLabels: many,
			series: [{ key: 'a', label: 'A', color: '#111', values: many.map((_, i) => i) }],
			maxXLabels: 5,
		});
		expect(screen.getByText('d0')).toBeInTheDocument();
		expect(screen.getByText('d29')).toBeInTheDocument();
		expect(screen.queryByText('d1')).not.toBeInTheDocument();
	});

	it('renders nothing without points or series', () => {
		const { container } = renderChart({ xLabels: [] });
		expect(container).toBeEmptyDOMElement();
	});
});
