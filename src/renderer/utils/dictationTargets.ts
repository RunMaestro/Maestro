/**
 * Dictation targets - where a transcript lands.
 *
 * Dictation records speech and hands back one string. Putting that string in a
 * text box is not one operation, because Maestro has three kinds of text box
 * and each is written differently:
 *
 *   - a CONTROLLED composer, whose text lives in a store and is written through
 *     that store's own setter (the AI composer, the group chat composer). Going
 *     through the DOM there would run the composer's typing rules over text
 *     nobody typed: a transcript that happened to start with `!` would flip the
 *     AI composer into command mode.
 *   - a CodeMirror editor, which owns its document and is written by a
 *     transaction (the file editor, the Auto Run editor).
 *   - any other `<textarea>` or text `<input>`, which is written the way a
 *     keystroke writes it, so the owning component's `onChange` runs.
 *
 * A {@link DictationTarget} hides that difference. A surface that needs its own
 * write path builds one and registers it (`registerDictationTarget` in
 * `src/renderer/services/dictation.ts`); every other text box is covered by
 * {@link dictationTargetForElement} with no wiring at all.
 *
 * Every target inserts AT THE CARET, replacing a selection, and pads the
 * transcript with the spaces a person would have typed ({@link padDictatedText}).
 */

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { insertTextAtSelection } from './textSelectionEdit';

export interface DictationTarget {
	/**
	 * The element whose focus means "the caret is in this surface". The dictation
	 * shortcut matches the focused element against it (the element itself, or
	 * anything inside it). Null while the surface is not mounted.
	 */
	getElement(): HTMLElement | null;
	/**
	 * Put `transcript` at the caret, replacing any selection.
	 *
	 * @returns false when the surface is gone and nothing was written, so the
	 *          caller can keep the words from being lost.
	 */
	insert(transcript: string): boolean;
}

/** A character a dictated word should not be glued to with a space. */
const OPENING = new Set(['(', '[', '{', '"', "'", '`', '/', '-', '_', '@', '#']);
const CLOSING = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'", '`']);

/**
 * The transcript, with the spaces that make it read as typed.
 *
 * A recogniser returns bare words. Dropped mid-sentence they would fuse with
 * their neighbours ("the quickbrown fox"), so a space is added on a side only
 * when the neighbour there is a word character: never against whitespace, an
 * opening bracket before, or closing punctuation after.
 *
 * @param before Text left of the selection (only its last character is read).
 * @param after  Text right of the selection (only its first character is read).
 */
export function padDictatedText(before: string, transcript: string, after: string): string {
	const text = transcript.trim();
	if (text === '') return '';

	const previous = before.slice(-1);
	const next = after.slice(0, 1);
	const lead =
		previous !== '' && !/\s/.test(previous) && !OPENING.has(previous) && !CLOSING.has(text[0])
			? ' '
			: '';
	const trail = next !== '' && !/\s/.test(next) && !CLOSING.has(next) ? ' ' : '';
	return lead + text + trail;
}

type TextInputElement = HTMLTextAreaElement | HTMLInputElement;

/** `<input>` types that hold free text AND expose a selection in Chromium. */
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel']);

function isEditableTextInput(element: Element): element is TextInputElement {
	if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
	if (element instanceof HTMLInputElement) {
		return (
			TEXT_INPUT_TYPES.has((element.getAttribute('type') ?? '').toLowerCase()) &&
			!element.disabled &&
			!element.readOnly
		);
	}
	return false;
}

/** The selection of a text input, clamped to its value. */
function selectionOf(element: TextInputElement): { start: number; end: number } {
	const length = element.value.length;
	const start = Math.min(element.selectionStart ?? length, length);
	const end = Math.min(Math.max(element.selectionEnd ?? start, start), length);
	return { start, end };
}

/**
 * Give focus back only where it will not be stolen: the element still has it,
 * or nothing does. A user who moved to another box while the clip was being
 * transcribed keeps their caret there.
 */
function restoreCaret(element: TextInputElement, caret: number): void {
	const focused = document.activeElement;
	if (focused === null || focused === document.body) element.focus();
	if (!element.isConnected) return;
	element.setSelectionRange(caret, caret);
}

/**
 * A composer whose text is held by its owner. The transcript is spliced into
 * the element's current value and written through `setValue`, the same setter
 * the composer uses for every other programmatic edit (an accepted mention, a
 * restored draft), so none of its typing rules run over dictated words.
 */
export function controlledTextDictationTarget(options: {
	getElement: () => TextInputElement | null;
	setValue: (value: string) => void;
}): DictationTarget {
	return {
		getElement: options.getElement,
		insert(transcript) {
			const element = options.getElement();
			if (!element || !element.isConnected) return false;
			const value = element.value;
			const { start, end } = selectionOf(element);
			const padded = padDictatedText(value.slice(0, start), transcript, value.slice(end));
			if (padded === '') return true;
			const edit = insertTextAtSelection(value, start, end, padded);
			options.setValue(edit.content);
			// After the owner's re-render has put the new value in the element:
			// setting the caret earlier is undone by the controlled value landing.
			requestAnimationFrame(() => restoreCaret(element, edit.cursorPosition));
			return true;
		},
	};
}

/** Write a value past React's own setter, so the `input` event reports a change. */
function setNativeValue(element: TextInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
	if (setter) setter.call(element, value);
	else element.value = value;
}

/**
 * Any other textarea or text input, written the way a keystroke writes it.
 *
 * While the element holds focus the insert goes through the browser's own
 * editing command, which keeps the undo stack intact (Cmd+Z removes the
 * dictated words). Otherwise the value is set directly and an `input` event is
 * dispatched, which is what a React `onChange` listens for.
 */
export function nativeTextDictationTarget(element: TextInputElement): DictationTarget {
	return {
		getElement: () => element,
		insert(transcript) {
			if (!element.isConnected || !isEditableTextInput(element)) return false;
			const value = element.value;
			const { start, end } = selectionOf(element);
			const padded = padDictatedText(value.slice(0, start), transcript, value.slice(end));
			if (padded === '') return true;

			if (
				document.activeElement === element &&
				typeof document.execCommand === 'function' &&
				document.execCommand('insertText', false, padded)
			) {
				return true;
			}

			const edit = insertTextAtSelection(value, start, end, padded);
			setNativeValue(element, edit.content);
			element.setSelectionRange(edit.cursorPosition, edit.cursorPosition);
			element.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		},
	};
}

/**
 * Insert a transcript at a CodeMirror view's main selection. One transaction,
 * so it is one undo step, and the view's update listener reports it to the host
 * exactly as it reports a keystroke.
 *
 * @returns false when the view is read-only.
 */
export function insertDictationIntoEditorView(view: EditorView, transcript: string): boolean {
	if (view.state.readOnly) return false;
	const { from, to } = view.state.selection.main;
	const padded = padDictatedText(
		view.state.sliceDoc(Math.max(0, from - 1), from),
		transcript,
		view.state.sliceDoc(to, Math.min(view.state.doc.length, to + 1))
	);
	if (padded === '') return true;
	view.dispatch({
		changes: { from, to, insert: padded },
		selection: EditorSelection.single(from + padded.length),
		scrollIntoView: true,
		userEvent: 'input.dictate',
	});
	return true;
}

/** A CodeMirror editor, addressed by its view. */
export function editorViewDictationTarget(options: {
	getElement: () => HTMLElement | null;
	getView: () => EditorView | null;
}): DictationTarget {
	return {
		getElement: options.getElement,
		insert(transcript) {
			const view = options.getView();
			return view ? insertDictationIntoEditorView(view, transcript) : false;
		},
	};
}

/**
 * The target for a text box nobody registered: the focused element itself when
 * it is a textarea or a text input, or the CodeMirror editor it sits in.
 *
 * Null for everything a transcript must not be typed into: a password field
 * (it would be read aloud to a recogniser and then hidden), a read-only or
 * disabled control, and a terminal, whose hidden textarea would send the words
 * straight to a shell.
 */
export function dictationTargetForElement(element: Element | null): DictationTarget | null {
	if (!(element instanceof HTMLElement)) return null;
	if (element.closest('.xterm')) return null;
	if (isEditableTextInput(element)) return nativeTextDictationTarget(element);

	const editorRoot = element.closest<HTMLElement>('.cm-editor');
	if (editorRoot) {
		const view = EditorView.findFromDOM(editorRoot);
		if (view && !view.state.readOnly) {
			return editorViewDictationTarget({ getElement: () => editorRoot, getView: () => view });
		}
	}
	return null;
}
