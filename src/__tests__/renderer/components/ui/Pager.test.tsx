/**
 * Tests for Pager.
 *
 * The disabled edges are the point: a Prev button that still fires on page 1
 * would drive the caller's clamp rather than being inert, which reads as a
 * dead control to the user.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Pager } from '../../../../renderer/components/ui/Pager';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('lucide-react', () => ({
	ChevronLeft: () => <span data-testid="chevron-left" />,
	ChevronRight: () => <span data-testid="chevron-right" />,
}));

const renderPager = (overrides: Partial<React.ComponentProps<typeof Pager>> = {}) => {
	const onPrev = vi.fn();
	const onNext = vi.fn();
	render(
		<Pager
			theme={mockTheme}
			page={2}
			totalPages={5}
			onPrev={onPrev}
			onNext={onNext}
			canGoPrev
			canGoNext
			testId="pager"
			{...overrides}
		/>
	);
	return { onPrev, onNext };
};

describe('Pager', () => {
	it('renders the current page against the total', () => {
		renderPager();
		expect(screen.getByTestId('pager-label')).toHaveTextContent('2 / 5');
	});

	it('announces page changes to assistive tech', () => {
		renderPager();
		// Focus never moves when the page turns, so without a live region a
		// screen reader user gets no signal that the list changed.
		expect(screen.getByTestId('pager-label')).toHaveAttribute('aria-live', 'polite');
	});

	it('reports prev and next clicks', () => {
		const { onPrev, onNext } = renderPager();

		fireEvent.click(screen.getByTestId('pager-next'));
		expect(onNext).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTestId('pager-prev'));
		expect(onPrev).toHaveBeenCalledTimes(1);
	});

	it('disables prev on the first page and next on the last', () => {
		const { onPrev } = renderPager({ page: 1, canGoPrev: false });

		const prev = screen.getByTestId('pager-prev');
		expect(prev).toBeDisabled();
		fireEvent.click(prev);
		expect(onPrev).not.toHaveBeenCalled();
	});

	it('disables next at the end', () => {
		const { onNext } = renderPager({ page: 5, canGoNext: false });

		const next = screen.getByTestId('pager-next');
		expect(next).toBeDisabled();
		fireEvent.click(next);
		expect(onNext).not.toHaveBeenCalled();
	});

	it('pages with the arrow keys', () => {
		const { onPrev, onNext } = renderPager();
		const group = screen.getByRole('group', { name: 'Pagination' });

		fireEvent.keyDown(group, { key: 'ArrowRight' });
		expect(onNext).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(group, { key: 'ArrowLeft' });
		expect(onPrev).toHaveBeenCalledTimes(1);
	});

	it('ignores arrow keys that would run past an edge', () => {
		const { onPrev } = renderPager({ page: 1, canGoPrev: false });
		const group = screen.getByRole('group', { name: 'Pagination' });

		fireEvent.keyDown(group, { key: 'ArrowLeft' });
		expect(onPrev).not.toHaveBeenCalled();
	});

	it('leaves other keys to the host surface', () => {
		const { onPrev, onNext } = renderPager();
		const group = screen.getByRole('group', { name: 'Pagination' });

		fireEvent.keyDown(group, { key: 'Escape' });
		fireEvent.keyDown(group, { key: 'ArrowUp' });

		expect(onPrev).not.toHaveBeenCalled();
		expect(onNext).not.toHaveBeenCalled();
	});

	it('accepts a surface-specific group label', () => {
		renderPager({ ariaLabel: 'Tab pages' });
		expect(screen.getByRole('group', { name: 'Tab pages' })).toBeInTheDocument();
	});
});
