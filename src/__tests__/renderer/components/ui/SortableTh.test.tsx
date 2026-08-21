/**
 * Tests for `<SortableTh>` - the shared sortable table header. The three
 * things worth pinning are the ones hand-rolled headers get wrong: keyboard
 * access, `aria-sort` placement, and a non-reflowing indicator slot.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SortableTh } from '../../../../renderer/components/ui/SortableTh';
import type { Theme } from '../../../../renderer/types';

const theme = {
	colors: { textDim: '#888', textMain: '#fff', accent: '#06b6d4', border: '#333' },
} as unknown as Theme;

function renderHeader(props: Partial<React.ComponentProps<typeof SortableTh>> = {}) {
	const onSort = vi.fn();
	render(
		<table>
			<thead>
				<tr>
					<SortableTh
						columnKey="next"
						label="Next"
						sortKey="next"
						direction="asc"
						onSort={onSort}
						theme={theme}
						testId="th-next"
						{...props}
					/>
				</tr>
			</thead>
		</table>
	);
	return { onSort };
}

describe('SortableTh', () => {
	it('puts aria-sort on the th, reflecting the active direction', () => {
		renderHeader();
		expect(screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'ascending');
	});

	it('reports descending when the active column is reversed', () => {
		renderHeader({ direction: 'desc' });
		expect(screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'descending');
	});

	it('reports none when another column is the active one', () => {
		renderHeader({ sortKey: 'agent' });
		expect(screen.getByTestId('th-next')).toHaveAttribute('aria-sort', 'none');
	});

	it('is a real button, so it is keyboard reachable and activatable', () => {
		// A `<th role="button" onClick>` announces as a button but has no tab
		// stop and no Enter/Space handling - it is unusable by keyboard.
		const { onSort } = renderHeader();
		const button = screen.getByRole('button', { name: 'Next' });

		button.focus();
		expect(button).toHaveFocus();

		fireEvent.click(button);
		expect(onSort).toHaveBeenCalledWith('next');
	});

	it('always lays out the caret so switching columns does not reflow the row', () => {
		renderHeader({ sortKey: 'agent' });
		const caret = screen.getByTestId('th-next').querySelector('svg');

		// Present in the DOM (space reserved) but invisible on an inactive column.
		expect(caret).not.toBeNull();
		expect(caret).toHaveStyle({ opacity: '0' });
	});
});
