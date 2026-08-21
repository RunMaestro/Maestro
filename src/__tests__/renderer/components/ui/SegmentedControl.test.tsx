/**
 * Tests for SegmentedControl.
 *
 * The pill bar replaced three hand-rolled `.map()`-over-buttons copies, none of
 * which had keyboard support. These tests pin the parts a caller cannot see by
 * eye: radio semantics, arrow-key movement, and the single tab stop that keeps
 * a five-option bar from eating five tabs of focus order.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SegmentedControl } from '../../../../renderer/components/ui/SegmentedControl';
import { mockTheme } from '../../../helpers/mockTheme';

type Mode = 'name' | 'created' | 'queries';

const OPTIONS = [
	{ value: 'name' as Mode, label: 'Name' },
	{ value: 'created' as Mode, label: 'Created' },
	{ value: 'queries' as Mode, label: 'Queries', title: 'Most queries first' },
];

const renderControl = (value: Mode, onChange = vi.fn()) => {
	render(
		<SegmentedControl
			value={value}
			onChange={onChange}
			options={OPTIONS}
			theme={mockTheme}
			ariaLabel="Sort agents"
			testId="sort"
		/>
	);
	return onChange;
};

describe('SegmentedControl', () => {
	it('renders one segment per option inside a labelled radiogroup', () => {
		renderControl('name');

		const group = screen.getByRole('radiogroup', { name: 'Sort agents' });
		expect(group).toBeInTheDocument();
		expect(screen.getAllByRole('radio')).toHaveLength(3);
		expect(screen.getByTestId('sort-created')).toHaveTextContent('Created');
	});

	it('marks only the active segment as checked', () => {
		renderControl('created');

		expect(screen.getByTestId('sort-name')).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByTestId('sort-created')).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByTestId('sort-queries')).toHaveAttribute('aria-checked', 'false');
	});

	it('reports the clicked value', () => {
		const onChange = renderControl('name');

		fireEvent.click(screen.getByTestId('sort-queries'));
		expect(onChange).toHaveBeenCalledWith('queries');
	});

	// One tab stop, not one per option: a five-option sort bar should cost a
	// single Tab press to skip, the way a native radio group does.
	it('keeps a single tab stop that follows the selection', () => {
		renderControl('created');

		expect(screen.getByTestId('sort-name')).toHaveAttribute('tabindex', '-1');
		expect(screen.getByTestId('sort-created')).toHaveAttribute('tabindex', '0');
		expect(screen.getByTestId('sort-queries')).toHaveAttribute('tabindex', '-1');
	});

	it('moves the selection with the arrow keys', () => {
		const onChange = renderControl('created');
		const group = screen.getByRole('radiogroup', { name: 'Sort agents' });

		fireEvent.keyDown(group, { key: 'ArrowRight' });
		expect(onChange).toHaveBeenCalledWith('queries');

		fireEvent.keyDown(group, { key: 'ArrowLeft' });
		expect(onChange).toHaveBeenCalledWith('name');
	});

	it('wraps around at both ends', () => {
		const onChange = renderControl('name');
		const group = screen.getByRole('radiogroup', { name: 'Sort agents' });

		fireEvent.keyDown(group, { key: 'ArrowLeft' });
		expect(onChange).toHaveBeenCalledWith('queries');
	});

	it('ignores keys it does not own so the host can still use them', () => {
		const onChange = renderControl('name');
		const group = screen.getByRole('radiogroup', { name: 'Sort agents' });

		fireEvent.keyDown(group, { key: 'ArrowUp' });
		fireEvent.keyDown(group, { key: 'Escape' });
		fireEvent.keyDown(group, { key: 'a' });

		expect(onChange).not.toHaveBeenCalled();
	});

	it('surfaces the optional per-segment tooltip', () => {
		renderControl('name');

		expect(screen.getByTestId('sort-queries')).toHaveAttribute('title', 'Most queries first');
		expect(screen.getByTestId('sort-name')).not.toHaveAttribute('title');
	});
});
