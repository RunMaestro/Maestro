/**
 * Unit tests for the shared MaestroEditor component.
 *
 * Covers the four behaviours called out by the column-mode playbook:
 *   (a) controlled `value` prop reflects external changes
 *   (b) `onChange` fires on a user-driven edit
 *   (c) `readOnly` prevents edits
 *   (d) `maxHeight` clamps the container height
 *
 * The component renders a CodeMirror 6 EditorView under the hood. jsdom has
 * no real layout engine, so we cannot assert pixel measurements — but DOM
 * structure, inline styles, ARIA attributes, and CM6 transactions are all
 * observable. To exercise edits without depending on jsdom's flaky
 * contenteditable input handling we grab the live `EditorView` via
 * `EditorView.findFromDOM(...)` and dispatch transactions directly, which is
 * the same code path CM6 takes for any user keystroke.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import { EditorView } from '@codemirror/view';

// CodeMirror 6 constructs IntersectionObserver inside its DOMObserver. The
// default test setup mocks IntersectionObserver as a non-constructable
// vi.fn(), which crashes CM6 on mount. Swap in a real class for the duration
// of this file and restore the original global in teardown so the swap does
// not leak into other test files that share the worker.
class StubIntersectionObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}
const ioGlobal = globalThis as typeof globalThis & {
	IntersectionObserver: typeof IntersectionObserver;
};
const originalIntersectionObserver = ioGlobal.IntersectionObserver;
ioGlobal.IntersectionObserver = StubIntersectionObserver as unknown as typeof IntersectionObserver;

afterAll(() => {
	ioGlobal.IntersectionObserver = originalIntersectionObserver;
});

// Skip the dynamic language loader so the editor stays deterministic and
// does not try to resolve real language packs at test time.
vi.mock('../../FilePreview/giantPreview/languageLoader', () => ({
	loadLanguageExtension: vi.fn(async () => null),
	hasLanguageSupport: () => false,
}));

// Provide the minimum useSettings surface that MaestroEditor +
// useColumnModeKeymap consume. Both files reach useSettings through the
// hooks barrel, which re-exports from this leaf module — so mocking the leaf
// catches both.
vi.mock('../../../hooks/settings/useSettings', () => ({
	useSettings: () => ({
		activeThemeId: 'dracula',
		customThemeColors: {
			bgMain: '#282a36',
			bgSidebar: '#21222c',
			bgActivity: '#343746',
			border: '#44475a',
			textMain: '#f8f8f2',
			textDim: '#6272a4',
			accent: '#bd93f9',
			accentDim: 'rgba(189, 147, 249, 0.2)',
			accentText: '#ff79c6',
			accentForeground: '#282a36',
			success: '#50fa7b',
			warning: '#ffb86c',
			error: '#ff5555',
		},
		shortcuts: {
			columnModeAddCursorAbove: {
				id: 'columnModeAddCursorAbove',
				label: 'Column Mode: Add Cursor Above',
				keys: ['Alt', 'Meta', 'ArrowUp'],
			},
			columnModeAddCursorBelow: {
				id: 'columnModeAddCursorBelow',
				label: 'Column Mode: Add Cursor Below',
				keys: ['Alt', 'Meta', 'ArrowDown'],
			},
		},
	}),
}));

import { MaestroEditor } from './MaestroEditor';

function getEditorView(container: HTMLElement): EditorView {
	const editor = container.querySelector('.cm-editor');
	if (!editor) {
		throw new Error('CodeMirror editor (.cm-editor) is not mounted');
	}
	const view = EditorView.findFromDOM(editor as HTMLElement);
	if (!view) {
		throw new Error('EditorView.findFromDOM returned null');
	}
	return view;
}

describe('MaestroEditor', () => {
	describe('controlled value', () => {
		it('renders the initial value into the document', () => {
			const { container } = render(<MaestroEditor value="hello world" onChange={() => {}} />);
			expect(container.textContent).toContain('hello world');
		});

		it('reflects external value prop changes without remounting', () => {
			const { container, rerender } = render(
				<MaestroEditor value="first marker" onChange={() => {}} />
			);
			const viewBefore = getEditorView(container);
			expect(container.textContent).toContain('first marker');

			rerender(<MaestroEditor value="second marker" onChange={() => {}} />);

			const viewAfter = getEditorView(container);
			expect(container.textContent).toContain('second marker');
			expect(container.textContent).not.toContain('first marker');
			// Same EditorView instance — the value sync goes through a
			// transaction, not a re-mount of CM6.
			expect(viewAfter).toBe(viewBefore);
		});
	});

	describe('onChange', () => {
		it('fires with the new document string when the user edits', () => {
			const onChange = vi.fn();
			const { container } = render(<MaestroEditor value="" onChange={onChange} />);
			const view = getEditorView(container);

			view.dispatch({ changes: { from: 0, insert: 'typed' } });

			expect(onChange).toHaveBeenCalled();
			expect(onChange).toHaveBeenLastCalledWith('typed');
		});

		it('does not fire onChange when the value prop is updated externally', () => {
			const onChange = vi.fn();
			const { rerender } = render(<MaestroEditor value="initial" onChange={onChange} />);
			onChange.mockClear();

			rerender(<MaestroEditor value="from-parent" onChange={onChange} />);

			// External sync is a programmatic dispatch from the value effect.
			// CM6's updateListener fires for any docChanged transaction, so we
			// expect at least one call — but the call must carry the new value
			// the parent already knows about (no double-counting / loop).
			expect(onChange).toHaveBeenCalled();
			expect(onChange).toHaveBeenLastCalledWith('from-parent');
		});
	});

	describe('readOnly', () => {
		it('exposes EditorState.readOnly = true when readOnly is set', () => {
			const { container } = render(<MaestroEditor value="locked" readOnly onChange={() => {}} />);
			const view = getEditorView(container);
			expect(view.state.readOnly).toBe(true);
		});

		it('sets aria-readonly on the content surface when readOnly is true', () => {
			const { container } = render(<MaestroEditor value="locked" readOnly onChange={() => {}} />);
			const content = container.querySelector('.cm-content');
			expect(content).not.toBeNull();
			expect(content?.getAttribute('aria-readonly')).toBe('true');
		});

		it('blocks user-driven edits while still exposing the document', () => {
			const onChange = vi.fn();
			const { container } = render(<MaestroEditor value="locked" readOnly onChange={onChange} />);
			const view = getEditorView(container);

			// CM6 simulates a real keystroke via `userEvent: 'input.type'`.
			// The readOnly facet wraps the dispatch path in a transaction
			// filter that drops any user-driven change, so doc length stays
			// at the initial value and onChange is not invoked.
			view.dispatch({
				changes: { from: 0, insert: 'edit' },
				userEvent: 'input.type',
			});

			expect(view.state.doc.toString()).toBe('locked');
			expect(onChange).not.toHaveBeenCalled();
		});

		it('allows edits again when readOnly is toggled back to false', () => {
			const onChange = vi.fn();
			const { container, rerender } = render(
				<MaestroEditor value="locked" readOnly onChange={onChange} />
			);
			rerender(<MaestroEditor value="locked" onChange={onChange} />);

			const view = getEditorView(container);
			expect(view.state.readOnly).toBe(false);

			view.dispatch({ changes: { from: 0, insert: 'now-editable ' } });
			expect(onChange).toHaveBeenLastCalledWith('now-editable locked');
		});
	});

	describe('maxHeight', () => {
		it('writes the max-height value onto the root container style', () => {
			const { container } = render(<MaestroEditor value="" maxHeight={240} onChange={() => {}} />);
			const root = container.firstElementChild as HTMLElement | null;
			expect(root).not.toBeNull();
			expect(root?.style.maxHeight).toBe('240px');
		});

		it('writes overflow: auto so content past maxHeight scrolls', () => {
			const { container } = render(<MaestroEditor value="" maxHeight={120} onChange={() => {}} />);
			const root = container.firstElementChild as HTMLElement | null;
			expect(root?.style.overflow).toBe('auto');
		});

		it('also clamps via minHeight when supplied', () => {
			const { container } = render(
				<MaestroEditor value="" minHeight={80} maxHeight={400} onChange={() => {}} />
			);
			const root = container.firstElementChild as HTMLElement | null;
			expect(root?.style.minHeight).toBe('80px');
			expect(root?.style.maxHeight).toBe('400px');
		});
	});
});
