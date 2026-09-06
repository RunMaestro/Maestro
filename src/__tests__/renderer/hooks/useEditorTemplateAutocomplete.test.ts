/**
 * Tests for the CodeMirror binding of the template-variable autocomplete.
 *
 * The state machine itself is covered by `useTemplateAutocomplete.test.ts`
 * (they share `useTemplateAutocompleteEngine`); these cover the parts that are
 * specific to an editor with no `selectionStart`: the caret comes from the
 * view, the insert goes back through the view, and the popup swallows the keys
 * CodeMirror's own keymap would otherwise consume.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEditorTemplateAutocomplete } from '../../../renderer/hooks/input/useEditorTemplateAutocomplete';
import type { MarkdownEditorHandle } from '../../../renderer/components/FilePreview/markdownEditor';

/** Minimal stand-in for the editor: a document string and a caret offset. */
function createFakeEditor(initial = '') {
	const state = { doc: initial, caret: initial.length };
	const handle = {
		getCaret: () => state.caret,
		coordsAtPos: () => ({ top: 40, left: 12 }),
		replaceRange: vi.fn((from: number, to: number, text: string) => {
			state.doc = state.doc.slice(0, from) + text + state.doc.slice(to);
			state.caret = from + text.length;
		}),
	} as unknown as MarkdownEditorHandle;
	return {
		state,
		ref: { current: handle } as React.RefObject<MarkdownEditorHandle>,
		/** Simulate typing: update the fake document, then notify the hook. */
		type(hook: { handleChange: (v: string) => void }, text: string) {
			state.doc += text;
			state.caret = state.doc.length;
			hook.handleChange(state.doc);
		},
	};
}

describe('useEditorTemplateAutocomplete', () => {
	let editor: ReturnType<typeof createFakeEditor>;
	let onChange: (value: string) => void;

	beforeEach(() => {
		editor = createFakeEditor('Hello ');
		onChange = vi.fn() as unknown as (value: string) => void;
		Element.prototype.scrollIntoView = vi.fn();
	});

	it('opens on "{{" and positions itself from the view, not a mirror div', () => {
		const { result } = renderHook(() =>
			useEditorTemplateAutocomplete({ editorRef: editor.ref, onChange })
		);

		act(() => editor.type(result.current, '{{'));

		expect(result.current.autocompleteState.isOpen).toBe(true);
		expect(result.current.autocompleteState.position).toEqual({ top: 40, left: 12 });
		expect(vi.mocked(onChange)).toHaveBeenLastCalledWith('Hello {{');
	});

	it('narrows the list as the query is typed', () => {
		const { result } = renderHook(() =>
			useEditorTemplateAutocomplete({ editorRef: editor.ref, onChange })
		);

		act(() => editor.type(result.current, '{{'));
		const total = result.current.autocompleteState.filteredVariables.length;
		act(() => editor.type(result.current, 'SESSION'));

		const filtered = result.current.autocompleteState.filteredVariables;
		expect(filtered.length).toBeGreaterThan(0);
		expect(filtered.length).toBeLessThan(total);
	});

	it('swallows the popup keys so CodeMirror never sees them', () => {
		const { result } = renderHook(() =>
			useEditorTemplateAutocomplete({ editorRef: editor.ref, onChange })
		);

		// Nothing open: the editor keeps its own arrow keys.
		expect(result.current.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(
			false
		);

		act(() => editor.type(result.current, '{{'));

		let taken = false;
		act(() => {
			taken = result.current.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		});
		expect(taken).toBe(true);
		expect(result.current.autocompleteState.selectedIndex).toBe(1);
	});

	it('replaces the trigger through the editor when a variable is chosen', () => {
		const { result } = renderHook(() =>
			useEditorTemplateAutocomplete({ editorRef: editor.ref, onChange })
		);

		act(() => editor.type(result.current, '{{'));
		const chosen = result.current.autocompleteState.filteredVariables[0].variable;

		act(() => {
			result.current.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
		});

		// The trigger braces are swallowed rather than left doubled up.
		expect(editor.state.doc).toBe(`Hello ${chosen}`);
		expect(result.current.autocompleteState.isOpen).toBe(false);
	});
});
