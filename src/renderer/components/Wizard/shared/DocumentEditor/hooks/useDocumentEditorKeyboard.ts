import { useCallback } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import type { DocumentEditorMode } from '../types';
import {
	continueMarkdownList,
	insertCheckboxAtCursor,
	insertTextAtSelection,
} from '../utils/editorCommands';

interface UseDocumentEditorKeyboardArgs {
	content: string;
	mode: DocumentEditorMode;
	onContentChange: (content: string) => void;
	onModeChange: (mode: DocumentEditorMode) => void;
	textareaRef: RefObject<HTMLTextAreaElement>;
}

function restoreSelection(
	textareaRef: RefObject<HTMLTextAreaElement>,
	cursorPosition: number,
	useAnimationFrame = false
) {
	const applySelection = () => {
		if (!textareaRef.current) return;
		textareaRef.current.setSelectionRange(cursorPosition, cursorPosition);
	};

	if (useAnimationFrame) {
		requestAnimationFrame(applySelection);
		return;
	}

	setTimeout(applySelection, 0);
}

export function useDocumentEditorKeyboard({
	content,
	mode,
	onContentChange,
	onModeChange,
	textareaRef,
}: UseDocumentEditorKeyboardArgs) {
	return useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === 'Tab') {
				event.preventDefault();
				const start = event.currentTarget.selectionStart;
				const end = event.currentTarget.selectionEnd;
				const result = insertTextAtSelection(content, start, end, '\t');
				onContentChange(result.content);
				restoreSelection(textareaRef, result.cursorPosition, true);
				return;
			}

			if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
				event.preventDefault();
				event.stopPropagation();
				onModeChange(mode === 'edit' ? 'preview' : 'edit');
				return;
			}

			if ((event.metaKey || event.ctrlKey) && event.key === 'l') {
				event.preventDefault();
				event.stopPropagation();
				const result = insertCheckboxAtCursor(content, event.currentTarget.selectionStart);
				onContentChange(result.content);
				restoreSelection(textareaRef, result.cursorPosition);
				return;
			}

			if (event.key === 'Enter' && !event.shiftKey) {
				const result = continueMarkdownList(content, event.currentTarget.selectionStart);
				if (!result) return;

				event.preventDefault();
				onContentChange(result.content);
				restoreSelection(textareaRef, result.cursorPosition);
			}
		},
		[content, mode, onContentChange, onModeChange, textareaRef]
	);
}
