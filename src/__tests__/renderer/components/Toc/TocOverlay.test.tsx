/**
 * TocOverlay's opt-in options (placement, filter, custom rows, row actions, an
 * in-place editor, row keys). The default Contents behavior is covered through
 * FilePreviewToc.test.tsx; these are what the pin panel builds on.
 */

import React, { useRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TocOverlay, type TocEntry } from '../../../../renderer/components/Toc';
import { mockTheme } from '../../../helpers/mockTheme';

const entries: TocEntry[] = [
	{ level: 1, text: 'First pin', slug: 'p1' },
	{ level: 1, text: 'Second pin', slug: 'p2' },
];

type Extra = Partial<React.ComponentProps<typeof TocOverlay>>;

function Harness({ extra = {}, initialFilter = '' }: { extra?: Extra; initialFilter?: string }) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const [filter, setFilter] = useState(initialFilter);
	const shown = entries.filter((e) => e.text.toLowerCase().includes(filter.toLowerCase()));
	return (
		<TocOverlay
			theme={mockTheme}
			entries={shown}
			width={320}
			open
			onOpenChange={vi.fn()}
			onScrollToBoundary={vi.fn()}
			buttonRef={buttonRef}
			overlayRef={overlayRef}
			onSelectEntry={() => true}
			filter={{ value: filter, onChange: setFilter, placeholder: 'Filter pins' }}
			emptyMessage="Nothing matches"
			{...extra}
		/>
	);
}

describe('TocOverlay options', () => {
	it('draws the title, count, badge and placement it is given', () => {
		render(
			<Harness
				extra={{ title: 'Pinned', countLabel: '2 pins', buttonBadge: 2, placement: 'top-right' }}
			/>
		);
		expect(screen.getByText('Pinned')).toBeInTheDocument();
		expect(screen.getByText('2 pins')).toBeInTheDocument();
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByTitle('Table of Contents').className).toContain('top-3');
	});

	it('focuses the filter on open and moves into the list with ArrowDown', async () => {
		render(<Harness />);
		const input = screen.getByPlaceholderText('Filter pins');
		await waitFor(() => expect(input).toHaveFocus());
		fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(screen.getByTitle('First pin')).toHaveFocus();
		fireEvent.keyDown(screen.getByTitle('First pin'), { key: 'ArrowUp' });
		expect(input).toHaveFocus();
	});

	it('stays open with an empty message when the filter matches nothing', () => {
		render(<Harness initialFilter="zzz" />);
		expect(screen.getByText('Nothing matches')).toBeInTheDocument();
	});

	it('renders custom rows, row actions, an editor slot, and row keys', () => {
		const onEntryKeyDown = vi.fn((_entry: TocEntry, _i: number, e: React.KeyboardEvent) => {
			return e.key === 'Delete';
		});
		render(
			<Harness
				extra={{
					renderEntry: (entry) => <span>custom {entry.text}</span>,
					renderEntryActions: (entry) => <button>act {entry.slug}</button>,
					renderEntryEditor: (entry) =>
						entry.slug === 'p2' ? <input aria-label="edit p2" /> : null,
					onEntryKeyDown,
				}}
			/>
		);
		expect(screen.getByText('custom First pin')).toBeInTheDocument();
		expect(screen.getByText('act p1')).toBeInTheDocument();
		// The editor replaces the row (and its actions) while it is shown.
		expect(screen.getByLabelText('edit p2')).toBeInTheDocument();
		expect(screen.queryByText('custom Second pin')).not.toBeInTheDocument();

		fireEvent.keyDown(screen.getByTitle('First pin'), { key: 'Delete' });
		expect(onEntryKeyDown).toHaveBeenCalledWith(entries[0], 0, expect.anything());
	});
});
