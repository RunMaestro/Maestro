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
	it('marks only the chosen segment for the bar to scroll into view', () => {
		renderControl('queries');

		expect(screen.getByTestId('sort-queries')).toHaveAttribute('data-reveal-active', 'true');
		expect(screen.getByTestId('sort-name')).not.toHaveAttribute('data-reveal-active');
		expect(screen.getByTestId('sort-created')).not.toHaveAttribute('data-reveal-active');
	});

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

	describe('icons', () => {
		const ICON_OPTIONS = [
			{ value: 'wide', label: 'Wide', icon: <svg data-testid="icon-wide" /> },
			{
				value: 'narrow',
				label: 'Narrow',
				title: 'A narrow page',
				icon: <svg data-testid="icon-narrow" />,
			},
		];

		const renderIcons = (iconOnly: boolean, onChange = vi.fn()) => {
			render(
				<SegmentedControl
					value="wide"
					onChange={onChange}
					options={ICON_OPTIONS}
					theme={mockTheme}
					ariaLabel="Width"
					testId="width"
					iconOnly={iconOnly}
				/>
			);
			return onChange;
		};

		it('draws an option icon before its label', () => {
			renderIcons(false);

			const segment = screen.getByTestId('width-wide');
			expect(segment).toHaveTextContent('Wide');
			expect(segment.firstElementChild).toBe(screen.getByTestId('icon-wide'));
			expect(segment).not.toHaveAttribute('aria-label');
		});

		it('with iconOnly draws the icon and no text, and still names the segment', () => {
			renderIcons(true);

			const segment = screen.getByTestId('width-wide');
			expect(segment).toHaveTextContent('');
			expect(screen.getByTestId('icon-wide')).toBeInTheDocument();
			expect(screen.getByRole('radio', { name: 'Wide' })).toBe(segment);
		});

		it('with iconOnly shows the label as the tooltip, unless the option sets its own title', () => {
			renderIcons(true);

			expect(screen.getByTestId('width-wide')).toHaveAttribute('title', 'Wide');
			expect(screen.getByTestId('width-narrow')).toHaveAttribute('title', 'A narrow page');
		});

		it('keeps the radio behavior of a text bar', () => {
			const onChange = renderIcons(true);

			fireEvent.click(screen.getByTestId('width-narrow'));
			expect(onChange).toHaveBeenCalledWith('narrow');
			expect(screen.getByTestId('width-wide')).toHaveAttribute('aria-checked', 'true');
			expect(screen.getByTestId('width-wide')).toHaveAttribute('tabindex', '0');
		});

		it('leaves a segment without an icon laid out as before', () => {
			renderControl('name');

			expect(screen.getByTestId('sort-name')).not.toHaveClass('inline-flex');
		});
	});
});
