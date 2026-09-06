/**
 * Template-variable autocomplete for the CodeMirror `MarkdownEditor`.
 *
 * The textarea binding (`useTemplateAutocomplete`) cannot serve this surface:
 * CodeMirror has no `selectionStart`, its caret coordinates come from the view
 * rather than from a mirror div, and its own keymap would eat the arrow keys
 * before a popup could see them. So this is a second binding over the SAME
 * state machine in `useTemplateAutocompleteEngine` - the trigger rules, the
 * filtering, and the key handling are shared, not re-implemented.
 *
 * Wiring, all three parts required:
 *   - `handleChange(next)` from the editor's `onChange`
 *   - `handleKeyDown` as the editor's `onKeyDown` (it returns true to swallow)
 *   - the dropdown rendered inside a `position: relative` wrapper around the
 *     editor, since the returned position is relative to the editor host
 */

import { useCallback } from 'react';
import type { MarkdownEditorHandle } from '../../components/FilePreview/markdownEditor';
import {
	useTemplateAutocompleteEngine,
	type AutocompleteState,
} from './useTemplateAutocompleteEngine';

interface UseEditorTemplateAutocompleteProps {
	editorRef: React.RefObject<MarkdownEditorHandle>;
	onChange: (value: string) => void;
}

interface UseEditorTemplateAutocompleteReturn {
	autocompleteState: AutocompleteState;
	autocompleteRef: React.RefObject<HTMLDivElement>;
	/** Feed the editor's `onChange` through this instead of straight to state. */
	handleChange: (value: string) => void;
	/** The editor's `onKeyDown` - true means the popup took the key. */
	handleKeyDown: (event: KeyboardEvent) => boolean;
	selectVariable: (variable: string) => void;
	closeAutocomplete: () => void;
}

export function useEditorTemplateAutocomplete({
	editorRef,
	onChange,
}: UseEditorTemplateAutocompleteProps): UseEditorTemplateAutocompleteReturn {
	const engine = useTemplateAutocompleteEngine({
		getCaret: () => editorRef.current?.getCaret() ?? 0,
		getCaretPosition: (caret) => editorRef.current?.coordsAtPos(caret) ?? { top: 0, left: 0 },
		replaceRange: (from, to, text) => {
			// The editor's own dispatch fires `onChange`, so the host's state is
			// updated by the same path a keystroke would take.
			editorRef.current?.replaceRange(from, to, text);
		},
	});

	const { syncToInput, handleKey } = engine;

	const handleChange = useCallback(
		(value: string) => {
			onChange(value);
			// Read the caret from the view rather than deriving it from the text:
			// CodeMirror has already applied the change by the time onChange runs.
			syncToInput(value, editorRef.current?.getCaret() ?? value.length);
		},
		[onChange, syncToInput, editorRef]
	);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent): boolean => handleKey(event.key, () => event.preventDefault()),
		[handleKey]
	);

	return {
		autocompleteState: engine.autocompleteState,
		autocompleteRef: engine.autocompleteRef,
		handleChange,
		handleKeyDown,
		selectVariable: engine.selectVariable,
		closeAutocomplete: engine.closeAutocomplete,
	};
}
