import type { RefObject, MutableRefObject } from 'react';
import type { MarkdownEditorHandle } from '../../components/FilePreview/markdownEditor';

export interface UseAutoRunKeyboardParams {
	localContent: string;
	editorRef: RefObject<MarkdownEditorHandle | null>;
	pushUndoState: (content?: string, cursor?: number) => void;
	lastUndoSnapshotRef: MutableRefObject<string>;
	handleUndo: () => void;
	handleRedo: () => void;
	isDirty: boolean;
	handleSave: () => Promise<void>;
	isLocked: boolean;
	toggleMode: () => void;
	openSearch: () => void;
	handleAutocompleteKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * Keyboard handler for the Auto Run source editor.
 *
 * Handles template autocomplete, tab insertion, undo/redo, save, edit/preview
 * toggle, search, checkbox insertion, and smart list continuation on Enter.
 *
 * Wired as the `onKeyDown` of the CodeMirror `MarkdownEditor`, so it receives a
 * native KeyboardEvent and returns `true` to swallow the key before the
 * editor's own keymap sees it.
 *
 * Every content edit here goes through `editorRef.replaceRange`, which
 * dispatches into CodeMirror and comes back out through the editor's `onChange`
 * - the same path a keystroke takes. Setting `lastUndoSnapshotRef` to the new
 * content BEFORE the dispatch is what tells that onChange the edit was explicit
 * (we already pushed an undo entry) so it does not schedule a second one.
 *
 * Returns a plain function (not useCallback) to match the original behavior -
 * it recreates on every render.
 */
export function useAutoRunKeyboard(params: UseAutoRunKeyboardParams) {
	const {
		localContent,
		editorRef,
		pushUndoState,
		lastUndoSnapshotRef,
		handleUndo,
		handleRedo,
		isDirty,
		handleSave,
		isLocked,
		toggleMode,
		openSearch,
		handleAutocompleteKeyDown,
	} = params;

	/** Push undo, mark the edit explicit, then apply it through CodeMirror. */
	const applyEdit = (from: number, to: number, text: string, newContent: string, caret: number) => {
		pushUndoState();
		lastUndoSnapshotRef.current = newContent;
		editorRef.current?.replaceRange(from, to, text);
		editorRef.current?.setSelection(caret, caret);
	};

	const handleKeyDown = (e: KeyboardEvent): boolean => {
		// Let template autocomplete handle keys first
		if (handleAutocompleteKeyDown(e)) {
			return true;
		}

		// Normalize key for consistent matching (Shift+z produces 'Z', we want 'z')
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

		// Insert an actual tab character instead of indenting by CodeMirror's
		// indent unit - Auto Run documents are hand-written Markdown and the tab
		// is what the rest of this codebase writes.
		if (key === 'Tab') {
			e.preventDefault();
			const { from, to } = editorRef.current?.getSelectionRange() ?? { from: 0, to: 0 };
			const newContent = localContent.substring(0, from) + '\t' + localContent.substring(to);
			applyEdit(from, to, '\t', newContent, from + 1);
			return true;
		}

		// Cmd+Z to undo, Cmd+Shift+Z to redo
		if ((e.metaKey || e.ctrlKey) && key === 'z') {
			e.preventDefault();
			e.stopPropagation();
			if (e.shiftKey) {
				handleRedo();
			} else {
				handleUndo();
			}
			return true;
		}

		// Cmd+S to save
		if ((e.metaKey || e.ctrlKey) && key === 's') {
			e.preventDefault();
			e.stopPropagation();
			if (isDirty) {
				handleSave().catch(() => {
					// Save errors are logged by handleSave; nothing to do here
				});
			}
			return true;
		}

		// Command-E to toggle between edit and preview (without Shift)
		// Cmd+Shift+E is left to the global handler ("Edit Last Queued Message")
		// Skip if edit mode is locked (during Auto Run) - matches button disabled state
		if ((e.metaKey || e.ctrlKey) && key === 'e' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			if (!isLocked) {
				toggleMode();
			}
			return true;
		}

		// Command-F to open search in edit mode (without Shift)
		// Cmd+Shift+F is allowed to propagate to the global handler for "Go to Files"
		if ((e.metaKey || e.ctrlKey) && key === 'f' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			openSearch();
			return true;
		}

		// Command-L to insert a markdown checkbox
		if ((e.metaKey || e.ctrlKey) && key === 'l') {
			e.preventDefault();
			e.stopPropagation();
			const cursorPos = editorRef.current?.getCaret() ?? 0;
			const textBeforeCursor = localContent.substring(0, cursorPos);
			const textAfterCursor = localContent.substring(cursorPos);

			// Check if we're at the start of a line or have text before
			const lastNewline = textBeforeCursor.lastIndexOf('\n');
			const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
			const textOnCurrentLine = textBeforeCursor.substring(lineStart);

			// At the start of a line, just insert the checkbox; mid-line, break
			// the line first so the checkbox starts its own list item.
			const insert = textOnCurrentLine.length === 0 ? '- [ ] ' : '\n- [ ] ';
			const newContent = textBeforeCursor + insert + textAfterCursor;
			applyEdit(cursorPos, cursorPos, insert, newContent, cursorPos + insert.length);
			return true;
		}

		if (key === 'Enter' && !e.shiftKey) {
			const cursorPos = editorRef.current?.getCaret() ?? 0;
			const textBeforeCursor = localContent.substring(0, cursorPos);
			const textAfterCursor = localContent.substring(cursorPos);
			const currentLineStart = textBeforeCursor.lastIndexOf('\n') + 1;
			const currentLine = textBeforeCursor.substring(currentLineStart);

			// Check for list patterns
			const unorderedListMatch = currentLine.match(/^(\s*)([-*])\s+/);
			const orderedListMatch = currentLine.match(/^(\s*)(\d+)\.\s+/);
			const taskListMatch = currentLine.match(/^(\s*)- \[([ x])\]\s+/);

			let insert: string | null = null;
			if (taskListMatch) {
				// Task list: continue with unchecked checkbox
				insert = '\n' + taskListMatch[1] + '- [ ] ';
			} else if (unorderedListMatch) {
				// Unordered list: continue with same marker
				insert = '\n' + unorderedListMatch[1] + unorderedListMatch[2] + ' ';
			} else if (orderedListMatch) {
				// Ordered list: increment number
				insert = '\n' + orderedListMatch[1] + (parseInt(orderedListMatch[2]) + 1) + '. ';
			}

			if (insert) {
				e.preventDefault();
				const newContent = textBeforeCursor + insert + textAfterCursor;
				applyEdit(cursorPos, cursorPos, insert, newContent, cursorPos + insert.length);
				return true;
			}
		}

		return false;
	};

	return handleKeyDown;
}
