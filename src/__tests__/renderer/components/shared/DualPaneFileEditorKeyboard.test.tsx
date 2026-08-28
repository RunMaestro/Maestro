/**
 * Keyboard navigation for the DualPaneFileEditor list pane.
 *
 * Once a row has focus, Up/Down walk the visible rows and Backspace/Delete
 * raise `onDeleteItem`. The rows the arrows walk are the VISIBLE ones, so a
 * collapsed category must not be stepped into.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	DualPaneFileEditor,
	type DualPaneFileEditorItem,
} from '../../../../renderer/components/shared/DualPaneFileEditor';
import { mockTheme } from '../../../helpers/mockTheme';

const ITEMS: DualPaneFileEditorItem[] = [
	{ id: 'MEMORY.md', label: 'MEMORY.md' },
	{ id: 'alpha.md', label: 'alpha.md' },
	{ id: 'beta.md', label: 'beta.md' },
];

function renderEditor(overrides: Partial<ComponentProps<typeof DualPaneFileEditor>> = {}) {
	const onSelect = vi.fn();
	const onDeleteItem = vi.fn();
	const utils = render(
		<DualPaneFileEditor
			theme={mockTheme}
			items={ITEMS}
			selectedId="alpha.md"
			onSelect={onSelect}
			onDeleteItem={onDeleteItem}
			renderEditorBody={() => <textarea readOnly value="" />}
			primaryAction={{ label: 'Save', onClick: vi.fn() }}
			{...overrides}
		/>
	);
	return { ...utils, onSelect, onDeleteItem };
}

function row(id: string): HTMLElement {
	const node = document.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
	if (!node) throw new Error(`No list row for ${id}`);
	return node;
}

describe('DualPaneFileEditor list keyboard navigation', () => {
	it('ArrowDown selects the next row and ArrowUp the previous one', () => {
		const { onSelect } = renderEditor();

		fireEvent.keyDown(row('alpha.md'), { key: 'ArrowDown' });
		expect(onSelect).toHaveBeenCalledWith('beta.md');

		onSelect.mockClear();
		fireEvent.keyDown(row('alpha.md'), { key: 'ArrowUp' });
		expect(onSelect).toHaveBeenCalledWith('MEMORY.md');
	});

	it('stops at the ends instead of wrapping', () => {
		const { onSelect } = renderEditor({ selectedId: 'MEMORY.md' });
		fireEvent.keyDown(row('MEMORY.md'), { key: 'ArrowUp' });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('enters the list from the top when the selection is not on screen', () => {
		const { onSelect } = renderEditor({ selectedId: 'gone.md' });
		fireEvent.keyDown(row('alpha.md'), { key: 'ArrowDown' });
		expect(onSelect).toHaveBeenCalledWith('MEMORY.md');
	});

	it('skips rows inside a collapsed category', () => {
		const grouped: DualPaneFileEditorItem[] = [
			{ id: 'a.md', label: 'a.md', category: 'open' },
			{ id: 'b.md', label: 'b.md', category: 'shut' },
			{ id: 'c.md', label: 'c.md', category: 'zopen' },
		];
		const { onSelect } = renderEditor({
			items: grouped,
			selectedId: 'a.md',
			categories: { open: { label: 'Open' }, shut: { label: 'Shut' }, zopen: { label: 'Zopen' } },
			collapsedCategories: new Set(['shut']),
		});
		fireEvent.keyDown(row('a.md'), { key: 'ArrowDown' });
		expect(onSelect).toHaveBeenCalledWith('c.md');
	});

	it('raises onDeleteItem for the selected row on Backspace and Delete', () => {
		const { onDeleteItem } = renderEditor();

		fireEvent.keyDown(row('alpha.md'), { key: 'Backspace' });
		expect(onDeleteItem).toHaveBeenCalledWith('alpha.md');

		onDeleteItem.mockClear();
		fireEvent.keyDown(row('alpha.md'), { key: 'Delete' });
		expect(onDeleteItem).toHaveBeenCalledWith('alpha.md');
	});

	it('ignores Backspace on the create button, which shares the list container', () => {
		const { onDeleteItem } = renderEditor({
			onCreateNewItem: vi.fn(),
			createNewItemLabel: 'New',
		});
		fireEvent.keyDown(screen.getByTitle('New'), { key: 'Backspace' });
		expect(onDeleteItem).not.toHaveBeenCalled();
	});

	it('moves focus onto the selected row when listFocusToken changes', () => {
		const { rerender } = renderEditor({ listFocusToken: 0 });
		expect(document.activeElement).not.toBe(row('alpha.md'));

		rerender(
			<DualPaneFileEditor
				theme={mockTheme}
				items={ITEMS}
				selectedId="alpha.md"
				onSelect={vi.fn()}
				onDeleteItem={vi.fn()}
				listFocusToken={1}
				renderEditorBody={() => <textarea readOnly value="" />}
				primaryAction={{ label: 'Save', onClick: vi.fn() }}
			/>
		);
		expect(document.activeElement).toBe(row('alpha.md'));
	});
});
