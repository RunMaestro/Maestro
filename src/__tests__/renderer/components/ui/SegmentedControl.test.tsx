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
import { Mic } from 'lucide-react';
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

	// A value that names none of the options: a state the bar shows but cannot
	// select (the Delegation Graph's `manual` layout). With no tab stop at all
	// the bar could not be reached from the keyboard.
	describe('with no segment on', () => {
		const renderNoneActive = (onChange = vi.fn()) => {
			render(
				<SegmentedControl<Mode | 'manual'>
					value="manual"
					onChange={onChange}
					options={OPTIONS}
					theme={mockTheme}
					ariaLabel="Sort agents"
					testId="sort"
				/>
			);
			return onChange;
		};

		it('checks none and gives the tab stop to the first segment', () => {
			renderNoneActive();

			for (const radio of screen.getAllByRole('radio')) {
				expect(radio).toHaveAttribute('aria-checked', 'false');
			}
			expect(screen.getByTestId('sort-name')).toHaveAttribute('tabindex', '0');
			expect(screen.getByTestId('sort-created')).toHaveAttribute('tabindex', '-1');
			expect(screen.getByTestId('sort-queries')).toHaveAttribute('tabindex', '-1');
		});

		it('enters at the first segment on Right and at the last on Left', () => {
			const onChange = renderNoneActive();
			const group = screen.getByRole('radiogroup', { name: 'Sort agents' });

			fireEvent.keyDown(group, { key: 'ArrowRight' });
			expect(onChange).toHaveBeenLastCalledWith('name');

			fireEvent.keyDown(group, { key: 'ArrowLeft' });
			expect(onChange).toHaveBeenLastCalledWith('queries');
		});
	});

	it('ignores keys it does not own so the host can still use them', () => {
		const onChange = renderControl('name');
		const group = screen.getByRole('radiogroup', { name: 'Sort agents' });

		fireEvent.keyDown(group, { key: 'ArrowUp' });
		fireEvent.keyDown(group, { key: 'Escape' });
		fireEvent.keyDown(group, { key: 'a' });

		expect(onChange).not.toHaveBeenCalled();
	});

	// A bar wider than its row used to lose its last segments outright:
	// `overflow-hidden` clipped them, so they were invisible AND unclickable
	// with no scrollbar to hint they were there. On a phone the five-way sort
	// bar lost two options.
	it('scrolls sideways rather than clipping the segments it cannot fit', () => {
		renderControl('name');

		const group = screen.getByRole('radiogroup');
		expect(group).toHaveClass('overflow-x-auto', 'overflow-y-hidden', 'max-w-full', 'min-w-0');
		expect(group).not.toHaveClass('overflow-hidden');
		// Every segment keeps its width inside that scroller - a squeezed
		// segment reads as a different label, not a narrower one.
		expect(screen.getByTestId('sort-name')).toHaveClass('shrink-0');
	});

	it('surfaces the optional per-segment tooltip', () => {
		renderControl('name');

		expect(screen.getByTestId('sort-queries')).toHaveAttribute('title', 'Most queries first');
		expect(screen.getByTestId('sort-name')).not.toHaveAttribute('title');
	});

	// The host's container query picks which form is visible, so both must be
	// in the DOM with the short one hidden by default.
	it('renders both label forms when a short label is given', () => {
		render(
			<SegmentedControl
				value="name"
				onChange={vi.fn()}
				options={[{ value: 'name', label: 'Full Name', shortLabel: 'Name' }]}
				theme={mockTheme}
				ariaLabel="Sort agents"
				testId="sort"
			/>
		);

		expect(screen.getByText('Full Name')).toHaveClass('segmented-label-full');
		expect(screen.getByText('Name')).toHaveClass('segmented-label-short', 'hidden');
	});

	it('renders a plain label when no short label is given', () => {
		renderControl('name');

		expect(screen.getByTestId('sort-name').querySelector('.segmented-label-full')).toBeNull();
	});
});

describe('SegmentedControl appearance', () => {
	const renderPills = (value: Mode, props: { stretch?: boolean } = {}) => {
		const onChange = vi.fn();
		render(
			<SegmentedControl
				value={value}
				onChange={onChange}
				options={[
					{ value: 'name' as Mode, label: 'Name', icon: Mic },
					{ value: 'created' as Mode, label: 'Created' },
					{ value: 'queries' as Mode, label: 'Queries' },
				]}
				theme={mockTheme}
				ariaLabel="Sort agents"
				testId="sort"
				appearance="pills"
				{...props}
			/>
		);
		return onChange;
	};

	it('is the joined bar unless asked otherwise', () => {
		renderControl('name');

		expect(screen.getByRole('radiogroup')).toHaveAttribute('data-appearance', 'bar');
		// Seams belong to the bar: every segment after the first draws one.
		expect(screen.getByTestId('sort-created').style.borderLeft).not.toBe('');
	});

	it('fills the active pill with the accent and leaves the others clear', () => {
		renderPills('created');

		expect(screen.getByRole('radiogroup')).toHaveAttribute('data-appearance', 'pills');
		expect(screen.getByTestId('sort-created')).toHaveStyle({
			backgroundColor: mockTheme.colors.accent,
		});
		expect(screen.getByTestId('sort-name').style.backgroundColor).toBe('transparent');
		// Pills are separated by the track, not by seams.
		expect(screen.getByTestId('sort-queries').style.borderLeft).toBe('');
	});

	// The look is the only thing that changes. A pill switch that lost the radio
	// semantics or the arrow keys would be a second control wearing this name.
	it('keeps the radio semantics and the arrow keys as pills', () => {
		const onChange = renderPills('name');

		expect(screen.getByTestId('sort-name')).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByTestId('sort-created')).toHaveAttribute('tabindex', '-1');

		fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
		expect(onChange).toHaveBeenCalledWith('created');
	});

	it('draws an option icon before its label, hidden from the accessibility tree', () => {
		renderPills('name');

		const icon = screen.getByTestId('sort-name').querySelector('svg');
		expect(icon).not.toBeNull();
		expect(icon).toHaveAttribute('aria-hidden', 'true');
		expect(screen.getByTestId('sort-created').querySelector('svg')).toBeNull();
		// The label is still the accessible name.
		expect(screen.getByRole('radio', { name: 'Name' })).toBe(screen.getByTestId('sort-name'));
	});

	it('fills the row when stretched, without ever squeezing a segment under its label', () => {
		renderPills('name', { stretch: true });

		// "An equal share, but never less than the label": the longest label takes
		// what it needs instead of being clipped, and which label is longest
		// depends on the user's font.
		const group = screen.getByRole('radiogroup');
		expect(group).toHaveClass('grid', 'auto-cols-[minmax(max-content,1fr)]');
		expect(group).not.toHaveClass('flex');
		// Too narrow for all of them, it scrolls like the hugging bar does.
		expect(group).toHaveClass('overflow-x-auto');
	});

	it('hugs its labels unless asked to stretch', () => {
		renderPills('name');

		const group = screen.getByRole('radiogroup');
		expect(group).toHaveClass('flex');
		expect(group).not.toHaveClass('grid');
	});
});
