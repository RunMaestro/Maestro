/**
 * Tests for the Auto Run source editor's keyboard handler.
 *
 * The hook moved from a `<textarea>` (where it rewrote `value` and then poked
 * `selectionStart`) to the CodeMirror `MarkdownEditor` (where every edit is a
 * `replaceRange` dispatch that comes back out through the editor's `onChange`).
 * Two contracts came with that move and neither is visible from the UI:
 *
 * 1. The RETURN VALUE decides who gets the key. `true` swallows it at
 *    `Prec.highest`; anything else leaves it to CodeMirror's own keymap. Return
 *    `true` too eagerly and ordinary typing dies; too rarely and the editor
 *    indents by its indent unit on Tab, or splits the line on Enter, on top of
 *    the edit this handler just made.
 * 2. `lastUndoSnapshotRef` must be stamped with the POST-edit content BEFORE
 *    the dispatch. The host's `onChange` schedules an undo snapshot for any
 *    content it has not already seen, so an unstamped explicit edit records two
 *    undo entries and Cmd+Z then needs two presses to walk back one tab.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoRunKeyboard } from '../../../renderer/hooks/batch/useAutoRunKeyboard';
import type { MarkdownEditorHandle } from '../../../renderer/components/FilePreview/markdownEditor';

/**
 * A stand-in for the editor handle that tracks what the host saw at dispatch
 * time. `snapshotAtDispatch` is the whole point of the undo assertions: reading
 * the ref after the fact cannot tell a stamp-before from a stamp-after.
 */
const createEditor = (caret = 0, selectionEnd = caret) => {
	const editor = {
		getCaret: vi.fn(() => caret),
		getSelectionRange: vi.fn(() => ({ from: caret, to: selectionEnd })),
		replaceRange: vi.fn(),
		setSelection: vi.fn(),
		focus: vi.fn(),
	};
	return editor;
};

const setup = (
	overrides: {
		localContent?: string;
		caret?: number;
		selectionEnd?: number;
		isDirty?: boolean;
		isLocked?: boolean;
		autocompleteClaims?: boolean;
	} = {}
) => {
	const {
		localContent = '',
		caret = 0,
		selectionEnd = caret,
		isDirty = false,
		isLocked = false,
		autocompleteClaims = false,
	} = overrides;

	const editor = createEditor(caret, selectionEnd);
	const lastUndoSnapshotRef = { current: '__unstamped__' };
	let observed: string | undefined;
	editor.replaceRange.mockImplementation(() => {
		observed = lastUndoSnapshotRef.current;
	});

	const harness = {
		editor,
		lastUndoSnapshotRef,
		pushUndoState: vi.fn((_content?: string, _cursor?: number) => {}),
		handleUndo: vi.fn(() => {}),
		handleRedo: vi.fn(() => {}),
		handleSave: vi.fn(() => Promise.resolve()),
		toggleMode: vi.fn(() => {}),
		openSearch: vi.fn(() => {}),
		handleAutocompleteKeyDown: vi.fn((_event: KeyboardEvent) => autocompleteClaims),
		/** Ref value observed at the moment `replaceRange` was dispatched. */
		snapshotAtDispatch: () => observed,
	};

	const { result } = renderHook(() =>
		useAutoRunKeyboard({
			localContent,
			editorRef: {
				current: editor as unknown as MarkdownEditorHandle,
			},
			pushUndoState: harness.pushUndoState,
			lastUndoSnapshotRef: harness.lastUndoSnapshotRef,
			handleUndo: harness.handleUndo,
			handleRedo: harness.handleRedo,
			isDirty,
			handleSave: harness.handleSave,
			isLocked,
			toggleMode: harness.toggleMode,
			openSearch: harness.openSearch,
			handleAutocompleteKeyDown: harness.handleAutocompleteKeyDown,
		})
	);

	return { handleKeyDown: result.current, ...harness };
};

const keyEvent = (key: string, init: Partial<KeyboardEventInit> = {}) => {
	const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
	vi.spyOn(event, 'preventDefault');
	vi.spyOn(event, 'stopPropagation');
	return event;
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe('useAutoRunKeyboard - who gets the key', () => {
	it('leaves an ordinary character to CodeMirror', () => {
		const { handleKeyDown } = setup();

		const event = keyEvent('a');

		// Returning false is what lets the editor insert the character at all.
		expect(handleKeyDown(event)).toBe(false);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it('lets the autocomplete popup claim a key before anything else', () => {
		const { handleKeyDown, editor, toggleMode } = setup({ autocompleteClaims: true });

		// Cmd+E would otherwise flip to preview and close the popup underneath it.
		expect(handleKeyDown(keyEvent('e', { metaKey: true }))).toBe(true);
		expect(toggleMode).not.toHaveBeenCalled();
		expect(editor.replaceRange).not.toHaveBeenCalled();
	});

	it('normalizes a shifted letter so Cmd+Shift+Z still reads as z', () => {
		const { handleKeyDown, handleRedo, handleUndo } = setup();

		// A shifted `z` arrives as `Z`; matching on the raw key would miss redo.
		expect(handleKeyDown(keyEvent('Z', { metaKey: true, shiftKey: true }))).toBe(true);
		expect(handleRedo).toHaveBeenCalledTimes(1);
		expect(handleUndo).not.toHaveBeenCalled();
	});
});

describe('useAutoRunKeyboard - Tab', () => {
	it('inserts a real tab character through the editor', () => {
		const { handleKeyDown, editor } = setup({ localContent: 'abcd', caret: 2 });

		const event = keyEvent('Tab');

		expect(handleKeyDown(event)).toBe(true);
		expect(event.preventDefault).toHaveBeenCalled();
		// A literal tab, not CodeMirror's indent unit - Auto Run documents are
		// hand-written Markdown and tabs are what the rest of the codebase writes.
		expect(editor.replaceRange).toHaveBeenCalledWith(2, 2, '\t');
		expect(editor.setSelection).toHaveBeenCalledWith(3, 3);
	});

	it('replaces the selected range rather than inserting beside it', () => {
		const { handleKeyDown, editor } = setup({ localContent: 'abcd', caret: 1, selectionEnd: 3 });

		handleKeyDown(keyEvent('Tab'));

		expect(editor.replaceRange).toHaveBeenCalledWith(1, 3, '\t');
		expect(editor.setSelection).toHaveBeenCalledWith(2, 2);
	});

	it('stamps the undo snapshot with the post-edit content BEFORE dispatching', () => {
		const h = setup({ localContent: 'abcd', caret: 2 });

		h.handleKeyDown(keyEvent('Tab'));

		expect(h.pushUndoState).toHaveBeenCalledTimes(1);
		// Stamped before the dispatch, so the onChange this dispatch triggers
		// recognizes the content as an edit that already has its undo entry.
		// Stamping afterwards would leave the ref stale for exactly that call and
		// record a second entry, so Cmd+Z would undo one tab in two presses.
		expect(h.snapshotAtDispatch()).toBe('ab\tcd');
		expect(h.lastUndoSnapshotRef.current).toBe('ab\tcd');
	});
});

describe('useAutoRunKeyboard - checkbox insert (Cmd+L)', () => {
	it('inserts the checkbox in place at the start of a line', () => {
		const h = setup({ localContent: 'one\n', caret: 4 });

		const event = keyEvent('l', { metaKey: true });

		expect(h.handleKeyDown(event)).toBe(true);
		expect(event.stopPropagation).toHaveBeenCalled();
		expect(h.editor.replaceRange).toHaveBeenCalledWith(4, 4, '- [ ] ');
		expect(h.editor.setSelection).toHaveBeenCalledWith(10, 10);
	});

	it('breaks the line first when the caret sits mid-line', () => {
		const h = setup({ localContent: 'one', caret: 3 });

		h.handleKeyDown(keyEvent('l', { metaKey: true }));

		// Without the leading newline the checkbox would be glued to the prose and
		// would not parse as a task, so the run would not see it.
		expect(h.editor.replaceRange).toHaveBeenCalledWith(3, 3, '\n- [ ] ');
		expect(h.snapshotAtDispatch()).toBe('one\n- [ ] ');
	});
});

describe('useAutoRunKeyboard - Enter list continuation', () => {
	const cases: Array<{ name: string; content: string; insert: string }> = [
		{ name: 'task list', content: '- [ ] first', insert: '\n- [ ] ' },
		{ name: 'checked task list', content: '- [x] first', insert: '\n- [ ] ' },
		{ name: 'indented task list', content: '\t- [ ] first', insert: '\n\t- [ ] ' },
		{ name: 'dash list', content: '- first', insert: '\n- ' },
		{ name: 'star list', content: '* first', insert: '\n* ' },
		{ name: 'ordered list', content: '3. first', insert: '\n4. ' },
	];

	for (const { name, content, insert } of cases) {
		it(`continues a ${name}`, () => {
			const h = setup({ localContent: content, caret: content.length });

			const event = keyEvent('Enter');

			expect(h.handleKeyDown(event)).toBe(true);
			expect(event.preventDefault).toHaveBeenCalled();
			expect(h.editor.replaceRange).toHaveBeenCalledWith(content.length, content.length, insert);
			expect(h.snapshotAtDispatch()).toBe(content + insert);
		});
	}

	it('continues a checked task with an UNCHECKED box', () => {
		const content = '- [x] done';
		const h = setup({ localContent: content, caret: content.length });

		h.handleKeyDown(keyEvent('Enter'));

		// Inheriting the [x] would silently mark the next task complete before it
		// was written, and an Auto Run skips completed tasks.
		expect(h.editor.replaceRange).toHaveBeenCalledWith(content.length, content.length, '\n- [ ] ');
	});

	it('leaves a plain paragraph Enter to CodeMirror', () => {
		const h = setup({ localContent: 'just prose', caret: 10 });

		const event = keyEvent('Enter');

		// Claiming this would mean re-implementing newline insertion, and the
		// editor already does it (with its own history entry).
		expect(h.handleKeyDown(event)).toBe(false);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(h.editor.replaceRange).not.toHaveBeenCalled();
	});

	it('leaves Shift+Enter to CodeMirror even inside a list', () => {
		const h = setup({ localContent: '- first', caret: 7 });

		const event = keyEvent('Enter', { shiftKey: true });

		expect(h.handleKeyDown(event)).toBe(false);
		expect(h.editor.replaceRange).not.toHaveBeenCalled();
	});
});

describe('useAutoRunKeyboard - commands', () => {
	it('saves on Cmd+S only when the document is dirty', () => {
		const clean = setup({ isDirty: false });
		expect(clean.handleKeyDown(keyEvent('s', { metaKey: true }))).toBe(true);
		expect(clean.handleSave).not.toHaveBeenCalled();

		const dirty = setup({ isDirty: true });
		expect(dirty.handleKeyDown(keyEvent('s', { metaKey: true }))).toBe(true);
		expect(dirty.handleSave).toHaveBeenCalledTimes(1);
	});

	it('swallows Cmd+E but does not flip modes while the document is locked', () => {
		const h = setup({ isLocked: true });

		// Swallowed either way so the key never reaches the editor; the lock only
		// decides whether the flip happens, matching the disabled toggle button.
		expect(h.handleKeyDown(keyEvent('e', { metaKey: true }))).toBe(true);
		expect(h.toggleMode).not.toHaveBeenCalled();
	});

	it('leaves Cmd+Shift+E to the global handler', () => {
		const h = setup();

		// That chord is "Edit Last Queued Message" at the app level.
		expect(h.handleKeyDown(keyEvent('e', { metaKey: true, shiftKey: true }))).toBe(false);
		expect(h.toggleMode).not.toHaveBeenCalled();
	});

	it('opens search on Cmd+F and leaves Cmd+Shift+F to the global handler', () => {
		const find = setup();
		expect(find.handleKeyDown(keyEvent('f', { metaKey: true }))).toBe(true);
		expect(find.openSearch).toHaveBeenCalledTimes(1);

		const goToFiles = setup();
		expect(goToFiles.handleKeyDown(keyEvent('f', { metaKey: true, shiftKey: true }))).toBe(false);
		expect(goToFiles.openSearch).not.toHaveBeenCalled();
	});

	it('routes undo and redo to the host history, not CodeMirror history', () => {
		const undo = setup();
		expect(undo.handleKeyDown(keyEvent('z', { metaKey: true }))).toBe(true);
		expect(undo.handleUndo).toHaveBeenCalledTimes(1);

		const redo = setup();
		expect(redo.handleKeyDown(keyEvent('z', { metaKey: true, shiftKey: true }))).toBe(true);
		expect(redo.handleRedo).toHaveBeenCalledTimes(1);
	});

	it('accepts Ctrl as well as Cmd', () => {
		const h = setup();

		expect(h.handleKeyDown(keyEvent('z', { ctrlKey: true }))).toBe(true);
		expect(h.handleUndo).toHaveBeenCalledTimes(1);
	});
});
