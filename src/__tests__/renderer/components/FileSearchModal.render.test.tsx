/**
 * @file FileSearchModal.render.test.tsx
 * @description Rendering tests for the fuzzy file search list.
 *
 * The list is virtualized, and `@tanstack/react-virtual` re-renders (inside
 * `flushSync`) on every scroll-offset change. The selected row used to carry an
 * inline arrow-function ref calling `scrollIntoView`, and an inline arrow is a
 * new identity on every render, so React detached and reattached it every time.
 * Each wheel tick scrolled the list and then immediately snapped it back inside
 * the same event. The wheel was never broken; the component undid it.
 *
 * These lock that down: nothing may move this list except a real change of
 * selection, which goes through the virtualizer's own `scrollToIndex`.
 *
 * `useVirtualizer` is mocked rather than driven for real because jsdom has no
 * layout engine - the scroll element measures zero, the virtualizer yields no
 * items, and a `scrollIntoView` assertion over an empty list passes no matter
 * what the component does. The mock's whole job is to make sure rows EXIST.
 *
 * The sibling `FileSearchModal.test.ts` covers the pure `flattenPreviewableFiles`
 * helper; this file covers the component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const ROW_COUNT = 20;
const scrollToIndex = vi.fn();

vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: ({ count }: { count: number }) => {
		const shown = Math.min(count, ROW_COUNT);
		const items = Array.from({ length: shown }, (_, index) => ({
			index,
			key: index,
			start: index * 40,
			size: 40,
			end: (index + 1) * 40,
			lane: 0,
		}));
		return {
			getVirtualItems: () => items,
			getTotalSize: () => count * 40,
			scrollToIndex,
			measureElement: () => undefined,
		};
	},
}));

import { FileSearchModal } from '../../../renderer/components/FileSearchModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { FileNode } from '../../../renderer/types/fileTree';
import { mockTheme } from '../../helpers/mockTheme';

/** A flat tree of previewable files. */
function makeTree(count: number): FileNode[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `file-${String(i).padStart(3, '0')}.ts`,
		path: `src/file-${String(i).padStart(3, '0')}.ts`,
		type: 'file' as const,
	}));
}

describe('FileSearchModal list scrolling', () => {
	let scrollIntoView: ReturnType<typeof vi.fn>;
	let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

	beforeEach(() => {
		scrollToIndex.mockClear();
		// jsdom does not implement scrollIntoView at all, so it has to be supplied
		// before it can be observed.
		originalScrollIntoView = Element.prototype.scrollIntoView;
		scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView =
			scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
	});

	afterEach(() => {
		cleanup();
		Element.prototype.scrollIntoView = originalScrollIntoView;
	});

	const renderModal = (files: FileNode[] = makeTree(200)) =>
		render(
			<LayerStackProvider>
				<FileSearchModal
					theme={mockTheme}
					fileTree={files}
					onFileSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			</LayerStackProvider>
		);

	/** Guard against the vacuous pass: no rows means no ref could ever fire. */
	it('renders rows, so the assertions below are about something', () => {
		renderModal();
		expect(screen.getByText('file-000.ts')).toBeInTheDocument();
		expect(screen.getByText('file-005.ts')).toBeInTheDocument();
	});

	it('never scrolls a row into view on its own', () => {
		renderModal();
		// The selected row is on screen and rendered. Before the inline ref was
		// removed this had already fired once just from mounting.
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it('does not scroll a row into view when the list re-renders', () => {
		renderModal();
		const input = screen.getByPlaceholderText(/search files/i);
		scrollIntoView.mockClear();

		// Typing re-renders the list without changing which row is selected, the
		// same shape of re-render the virtualizer performs on every scroll tick.
		fireEvent.change(input, { target: { value: 'file' } });
		fireEvent.change(input, { target: { value: 'file-0' } });

		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it('shows only category pills that have files behind them', () => {
		renderModal([
			{ name: 'App.tsx', type: 'file' as const },
			{ name: 'README.md', type: 'file' as const },
		]);

		expect(screen.getByTestId('file-search-category-all')).toHaveTextContent('All (2)');
		expect(screen.getByTestId('file-search-category-code')).toHaveTextContent('Code (1)');
		expect(screen.getByTestId('file-search-category-docs')).toHaveTextContent('Docs (1)');
		// No data or media files in this tree, so no dead-end pills.
		expect(screen.queryByTestId('file-search-category-data')).toBeNull();
		expect(screen.queryByTestId('file-search-category-media')).toBeNull();
		// The visible-files scope is gone entirely.
		expect(screen.queryByText(/Visible Files/i)).toBeNull();
	});

	it('narrows the list to the picked category', () => {
		renderModal([
			{ name: 'App.tsx', type: 'file' as const },
			{ name: 'README.md', type: 'file' as const },
		]);

		fireEvent.click(screen.getByTestId('file-search-category-docs'));

		expect(screen.getByText('README.md')).toBeInTheDocument();
		expect(screen.queryByText('App.tsx')).toBeNull();
	});

	it('steps through the pills with Tab and back with Shift+Tab', () => {
		renderModal([
			{ name: 'App.tsx', type: 'file' as const },
			{ name: 'README.md', type: 'file' as const },
		]);
		const input = screen.getByPlaceholderText(/search files/i);

		fireEvent.keyDown(input, { key: 'Tab' });
		expect(screen.getByTestId('file-search-category-code')).toHaveAttribute('aria-pressed', 'true');

		fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
		expect(screen.getByTestId('file-search-category-all')).toHaveAttribute('aria-pressed', 'true');
	});

	it('still follows the selection with the arrow keys, via the virtualizer', () => {
		renderModal();
		const input = screen.getByPlaceholderText(/search files/i);

		const first = screen.getByText('file-000.ts').closest('button');
		expect(first).toHaveStyle({ backgroundColor: mockTheme.colors.accent });

		scrollToIndex.mockClear();
		fireEvent.keyDown(input, { key: 'ArrowDown' });

		const second = screen.getByText('file-001.ts').closest('button');
		expect(second).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		// Selection follow is the virtualizer's job, not a row ref's. `align: auto`
		// with no `behavior` - a smooth animation across thousands of rows runs
		// long enough for the next wheel gesture to fight it.
		expect(scrollToIndex).toHaveBeenCalledWith(1, { align: 'auto' });
		expect(scrollIntoView).not.toHaveBeenCalled();
	});
});
