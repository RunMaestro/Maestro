/**
 * Tests for the starter input-widget family (src/renderer/components/widgets/input).
 *
 * These validate the `InputWidgetProps<T>` contract end to end:
 * - Slider: themed controlled range input - label, formatted read-out, onChange
 *   emits a number, disabled blocks interaction.
 * - RankedChoice: controlled reorderable list - renders in order, up/down
 *   buttons emit a new `orderedIds`, endpoints disable the out-of-range move.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Slider, RankedChoice } from '../../../../renderer/components/widgets';
import type { RankedChoiceItem, RankedChoiceValue } from '../../../../renderer/components/widgets';
import { mockTheme } from '../../../helpers/mockTheme';

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
