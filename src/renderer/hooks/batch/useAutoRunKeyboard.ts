import type { RefObject, MutableRefObject } from 'react';

export interface UseAutoRunKeyboardParams {
	localContent: string;
	setLocalContent: (content: string) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	pushUndoState: (content?: string, cursor?: number) => void;
	lastUndoSnapshotRef: MutableRefObject<string>;
	handleUndo: () => void;
	handleRedo: () => void;
	isDirty: boolean;
	handleSave: () => Promise<void>;
	isLocked: boolean;
	toggleMode: () => void;
	openSearch: () => void;
	handleAutocompleteKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * Extracts the textarea keyboard handler from AutoRun.
 *
 * Handles template autocomplete, tab insertion, undo/redo, save,
 * edit/preview toggle, search, checkbox insertion, and smart list
 * continuation on Enter.
 *
 * Returns a plain function (not useCallback) to match the original
 * behavior — it recreates on every render.
 */
export function useAutoRunKeyboard(params: UseAutoRunKeyboardParams) {
	const {
		localContent,
		setLocalContent,
		textareaRef,
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

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Let template autocomplete handle keys first
		if (handleAutocompleteKeyDown(e)) {
			return;
		}

		// Normalize key for consistent matching (Shift+z produces 'Z', we want 'z')
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

		// Insert actual tab character instead of moving focus
		if (key === 'Tab') {
			e.preventDefault();
			const textarea = e.currentTarget;
			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;

			// Push undo state before modifying content
			pushUndoState();

			const newContent = localContent.substring(0, start) + '\t' + localContent.substring(end);
			setLocalContent(newContent);
			lastUndoSnapshotRef.current = newContent;

			// Restore cursor position after the tab
			requestAnimationFrame(() => {
				textarea.selectionStart = start + 1;
				textarea.selectionEnd = start + 1;
			});
			return;
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
			return;
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
			return;
		}

		// Command-E to toggle between edit and preview (without Shift)
		// Cmd+Shift+E is allowed to propagate to global handler for "Toggle Auto Run Expanded"
		// Skip if edit mode is locked (during Auto Run) - matches button disabled state
		if ((e.metaKey || e.ctrlKey) && key === 'e' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			if (!isLocked) {
				toggleMode();
			}
			return;
		}

		// Command-F to open search in edit mode (without Shift)
		// Cmd+Shift+F is allowed to propagate to the global handler for "Go to Files"
		if ((e.metaKey || e.ctrlKey) && key === 'f' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			openSearch();
			return;
		}

		// Command-L to insert a markdown checkbox
		if ((e.metaKey || e.ctrlKey) && key === 'l') {
			e.preventDefault();
			e.stopPropagation();
			const textarea = e.currentTarget;
			const cursorPos = textarea.selectionStart;
			const textBeforeCursor = localContent.substring(0, cursorPos);
			const textAfterCursor = localContent.substring(cursorPos);

			// Push undo state before modifying content
			pushUndoState();

			// Check if we're at the start of a line or have text before
			const lastNewline = textBeforeCursor.lastIndexOf('\n');
			const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
			const textOnCurrentLine = textBeforeCursor.substring(lineStart);

			let newContent: string;
			let newCursorPos: number;

			if (textOnCurrentLine.length === 0) {
				// At start of line, just insert checkbox
				newContent = textBeforeCursor + '- [ ] ' + textAfterCursor;
				newCursorPos = cursorPos + 6; // "- [ ] " is 6 chars
			} else {
				// In middle of line, insert newline then checkbox
				newContent = textBeforeCursor + '\n- [ ] ' + textAfterCursor;
				newCursorPos = cursorPos + 7; // "\n- [ ] " is 7 chars
			}

			setLocalContent(newContent);
			// Update lastUndoSnapshot since we pushed state explicitly
			lastUndoSnapshotRef.current = newContent;
			requestAnimationFrame(() => {
				if (textareaRef.current) {
					textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
				}
			});
			return;
		}

		if (key === 'Enter' && !e.shiftKey) {
			const textarea = e.currentTarget;
			const cursorPos = textarea.selectionStart;
			const textBeforeCursor = localContent.substring(0, cursorPos);
			const textAfterCursor = localContent.substring(cursorPos);
			const currentLineStart = textBeforeCursor.lastIndexOf('\n') + 1;
			const currentLine = textBeforeCursor.substring(currentLineStart);

			// Check for list patterns
			const unorderedListMatch = currentLine.match(/^(\s*)([-*])\s+/);
			const orderedListMatch = currentLine.match(/^(\s*)(\d+)\.\s+/);
			const taskListMatch = currentLine.match(/^(\s*)- \[([ x])\]\s+/);

			if (taskListMatch) {
				// Task list: continue with unchecked checkbox
				const indent = taskListMatch[1];
				e.preventDefault();
				// Push undo state before modifying content
				pushUndoState();
				const newContent = textBeforeCursor + '\n' + indent + '- [ ] ' + textAfterCursor;
				setLocalContent(newContent);
				lastUndoSnapshotRef.current = newContent;
				setTimeout(() => {
					if (textareaRef.current) {
						const newPos = cursorPos + indent.length + 7; // "\n" + indent + "- [ ] "
						textareaRef.current.setSelectionRange(newPos, newPos);
					}
				});
			} else if (unorderedListMatch) {
				// Unordered list: continue with same marker
				const indent = unorderedListMatch[1];
				const marker = unorderedListMatch[2];
				e.preventDefault();
				// Push undo state before modifying content
				pushUndoState();
				const newContent = textBeforeCursor + '\n' + indent + marker + ' ' + textAfterCursor;
				setLocalContent(newContent);
				lastUndoSnapshotRef.current = newContent;
				setTimeout(() => {
					if (textareaRef.current) {
						const newPos = cursorPos + indent.length + 3; // "\n" + indent + marker + " "
						textareaRef.current.setSelectionRange(newPos, newPos);
					}
				});
			} else if (orderedListMatch) {
				// Ordered list: increment number
				const indent = orderedListMatch[1];
				const num = parseInt(orderedListMatch[2]);
				e.preventDefault();
				// Push undo state before modifying content
				pushUndoState();
				const newContent = textBeforeCursor + '\n' + indent + (num + 1) + '. ' + textAfterCursor;
				setLocalContent(newContent);
				lastUndoSnapshotRef.current = newContent;
				setTimeout(() => {
					if (textareaRef.current) {
						const newPos = cursorPos + indent.length + (num + 1).toString().length + 3; // "\n" + indent + num + ". "
						textareaRef.current.setSelectionRange(newPos, newPos);
					}
				});
			}
		}
	};

	return handleKeyDown;
}
