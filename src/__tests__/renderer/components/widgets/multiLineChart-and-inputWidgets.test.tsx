// Source: src/__tests__/renderer/components/widgets/multiLineChart.test.tsx
// Source: src/__tests__/renderer/components/widgets/inputWidgets.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { MultiLineChart } from '../../../../renderer/components/widgets';
import type { LineSeries } from '../../../../renderer/components/widgets';
import { mockTheme } from '../../../helpers/mockTheme';
import { vi } from 'vitest';
import { Slider } from '../../../../renderer/components/widgets';
import { RankedChoice } from '../../../../renderer/components/widgets';
import type { RankedChoiceItem } from '../../../../renderer/components/widgets';
import type { RankedChoiceValue } from '../../../../renderer/components/widgets';
describeSourceSuite('multiLineChart', () => {
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
});
describeSourceSuite('inputWidgets', () => {
	describe('Slider', () => {
		it('renders the label and a formatted value read-out', () => {
			render(
				<Slider
					theme={mockTheme}
					label="Temperature"
					value={42}
					onChange={() => {}}
					formatValue={(v) => `${v}%`}
				/>
			);
			expect(screen.getByText('Temperature')).toBeInTheDocument();
			expect(screen.getByText('42%')).toBeInTheDocument();
		});

		it('emits a numeric value through onChange', () => {
			const onChange = vi.fn();
			render(
				<Slider theme={mockTheme} label="Level" value={10} onChange={onChange} min={0} max={100} />
			);
			fireEvent.change(screen.getByRole('slider'), { target: { value: '75' } });
			expect(onChange).toHaveBeenCalledWith(75);
			expect(typeof onChange.mock.calls[0][0]).toBe('number');
		});

		it('disables the input when disabled', () => {
			render(<Slider theme={mockTheme} label="Level" value={10} onChange={() => {}} disabled />);
			expect(screen.getByRole('slider')).toBeDisabled();
		});
	});

	describe('RankedChoice', () => {
		const items: RankedChoiceItem[] = [
			{ id: 'a', label: 'Alpha' },
			{ id: 'b', label: 'Beta' },
			{ id: 'c', label: 'Gamma' },
		];
		const value: RankedChoiceValue = { orderedIds: ['a', 'b', 'c'] };

		it('renders items in the supplied order', () => {
			render(<RankedChoice theme={mockTheme} items={items} value={value} onChange={() => {}} />);
			const rendered = screen.getAllByRole('listitem').map((li) => li.textContent);
			expect(rendered[0]).toContain('Alpha');
			expect(rendered[1]).toContain('Beta');
			expect(rendered[2]).toContain('Gamma');
		});

		it('moves an item up and emits the new ordering', () => {
			const onChange = vi.fn();
			render(<RankedChoice theme={mockTheme} items={items} value={value} onChange={onChange} />);
			fireEvent.click(screen.getByRole('button', { name: 'Move Beta up' }));
			expect(onChange).toHaveBeenCalledWith({ orderedIds: ['b', 'a', 'c'] });
		});

		it('moves an item down and emits the new ordering', () => {
			const onChange = vi.fn();
			render(<RankedChoice theme={mockTheme} items={items} value={value} onChange={onChange} />);
			fireEvent.click(screen.getByRole('button', { name: 'Move Beta down' }));
			expect(onChange).toHaveBeenCalledWith({ orderedIds: ['a', 'c', 'b'] });
		});

		it('disables the out-of-range move at each endpoint', () => {
			render(<RankedChoice theme={mockTheme} items={items} value={value} onChange={() => {}} />);
			expect(screen.getByRole('button', { name: 'Move Alpha up' })).toBeDisabled();
			expect(screen.getByRole('button', { name: 'Move Gamma down' })).toBeDisabled();
		});

		it('appends items missing from orderedIds so no choice is silently dropped', () => {
			const onChange = vi.fn();
			render(
				<RankedChoice
					theme={mockTheme}
					items={items}
					value={{ orderedIds: ['c'] }}
					onChange={onChange}
				/>
			);
			const rendered = screen.getAllByRole('listitem').map((li) => li.textContent);
			// 'c' (Gamma) first, then the omitted items in their original order.
			expect(rendered[0]).toContain('Gamma');
			expect(rendered.length).toBe(3);
		});
	});
});
