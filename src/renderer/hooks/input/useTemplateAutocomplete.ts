import { useCallback } from 'react';
import { useClickOutside } from '../ui';
import {
	useTemplateAutocompleteEngine,
	type AutocompleteState,
} from './useTemplateAutocompleteEngine';

export type { AutocompleteState };

interface UseTemplateAutocompleteProps {
	textareaRef: React.RefObject<HTMLTextAreaElement>;
	value: string;
	onChange: (value: string) => void;
}

interface UseTemplateAutocompleteReturn {
	autocompleteState: AutocompleteState;
	handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
	handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	selectVariable: (variable: string) => void;
	closeAutocomplete: () => void;
	autocompleteRef: React.RefObject<HTMLDivElement>;
}

/**
 * Measure where the caret sits inside a textarea.
 *
 * A textarea renders no per-character boxes, so the only way to locate the
 * caret is to lay the same text out again in a mirror div that copies the
 * textarea's metrics, and read the position of a marker span at the cursor.
 */
function caretPositionInTextarea(
	textarea: HTMLTextAreaElement,
	cursorPos: number
): { top: number; left: number } {
	const mirror = document.createElement('div');
	const style = window.getComputedStyle(textarea);

	mirror.style.cssText = `
      position: absolute;
      visibility: hidden;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: ${style.fontFamily};
      font-size: ${style.fontSize};
      line-height: ${style.lineHeight};
      padding: ${style.padding};
      border: ${style.border};
      width: ${textarea.clientWidth}px;
      box-sizing: border-box;
    `;

	mirror.textContent = textarea.value.substring(0, cursorPos);

	const span = document.createElement('span');
	span.textContent = '|';
	mirror.appendChild(span);

	document.body.appendChild(mirror);
	const spanRect = span.getBoundingClientRect();
	const mirrorRect = mirror.getBoundingClientRect();
	document.body.removeChild(mirror);

	return {
		top:
			spanRect.top -
			mirrorRect.top -
			textarea.scrollTop +
			parseInt(style.lineHeight || '20', 10) +
			4,
		// Keep the dropdown inside the textarea's own width.
		left: Math.min(spanRect.left - mirrorRect.left, textarea.clientWidth - 250),
	};
}

/**
 * Template-variable autocomplete for a plain `<textarea>`.
 *
 * The trigger/filter/key logic lives in `useTemplateAutocompleteEngine`; this
 * is the textarea binding over it. For the CodeMirror editor use
 * `useEditorTemplateAutocomplete` instead - do not fork the state machine.
 */
export function useTemplateAutocomplete({
	textareaRef,
	value,
	onChange,
}: UseTemplateAutocompleteProps): UseTemplateAutocompleteReturn {
	const engine = useTemplateAutocompleteEngine({
		getCaret: () => textareaRef.current?.selectionStart ?? value.length,
		getCaretPosition: (caret) => {
			const textarea = textareaRef.current;
			if (!textarea) return { top: 0, left: 0 };
			return caretPositionInTextarea(textarea, caret);
		},
		replaceRange: (from, to, text) => {
			// Sliced from the controlled `value` rather than from the DOM node, so
			// the write matches what React is holding even mid-update.
			onChange(value.substring(0, from) + text + value.substring(to));
			const caret = from + text.length;
			requestAnimationFrame(() => {
				textareaRef.current?.focus();
				textareaRef.current?.setSelectionRange(caret, caret);
			});
		},
	});

	const { syncToInput, handleKey, closeAutocomplete, autocompleteState, autocompleteRef } = engine;

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const textarea = e.target;
			const newValue = textarea.value;
			onChange(newValue);
			syncToInput(newValue, textarea.selectionStart);
		},
		[onChange, syncToInput]
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
			handleKey(e.key, () => e.preventDefault()),
		[handleKey]
	);

	// Excludes the textarea as well as the dropdown: clicking back into the text
	// you are already typing is not a dismissal.
	useClickOutside(
		[autocompleteRef, textareaRef] as React.RefObject<HTMLElement | null>[],
		closeAutocomplete,
		autocompleteState.isOpen
	);

	return {
		autocompleteState,
		handleKeyDown,
		handleChange,
		selectVariable: engine.selectVariable,
		closeAutocomplete,
		autocompleteRef,
	};
}
