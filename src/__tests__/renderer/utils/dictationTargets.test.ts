/**
 * @file dictationTargets.test.ts
 *
 * Where a dictated transcript lands. Properties worth protecting:
 *
 *   - **It goes in at the caret**, replacing a selection, never at the end.
 *   - **Spacing reads as typed**: a space against a word, none against
 *     whitespace, an opening bracket, or closing punctuation.
 *   - **A store-backed composer is written through its setter**, and no `input`
 *     event is dispatched, so the composer's typing rules never run.
 *   - **A plain text box is written the way a keystroke writes it.**
 *   - **A transcript is never typed into a password field, a read-only control,
 *     or a terminal.**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import {
	controlledTextDictationTarget,
	dictationTargetForElement,
	insertDictationIntoEditorView,
	nativeTextDictationTarget,
	padDictatedText,
} from '../../../renderer/utils/dictationTargets';

function textarea(value: string, start: number, end = start): HTMLTextAreaElement {
	const element = document.createElement('textarea');
	document.body.appendChild(element);
	element.value = value;
	element.setSelectionRange(start, end);
	return element;
}

/** A view that is only a state and a dispatch: CodeMirror cannot lay out in jsdom. */
function fakeView(doc: string, from: number, to = from, readOnly = false) {
	const state = EditorState.create({
		doc,
		selection: EditorSelection.single(from, to),
		extensions: [EditorState.readOnly.of(readOnly)],
	});
	const dispatch = vi.fn();
	return { view: { state, dispatch } as unknown as EditorView, dispatch };
}

describe('padDictatedText', () => {
	it('adds a space on a side only when a word is there', () => {
		expect(padDictatedText('the quick', 'brown', 'fox')).toBe(' brown ');
		expect(padDictatedText('the quick ', 'brown', ' fox')).toBe('brown');
		expect(padDictatedText('', 'hello', '')).toBe('hello');
	});

	it('does not pad against an opening bracket or closing punctuation', () => {
		expect(padDictatedText('say (', 'hello', ') now')).toBe('hello');
		expect(padDictatedText('one', 'two', '.')).toBe(' two');
		expect(padDictatedText('one', ', two', '')).toBe(', two');
	});

	it('trims the transcript and answers empty for silence', () => {
		expect(padDictatedText('a', '  hi there \n', '')).toBe(' hi there');
		expect(padDictatedText('a', '   ', 'b')).toBe('');
	});
});

describe('controlledTextDictationTarget', () => {
	beforeEach(() => {
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = '';
	});

	it('inserts at the caret through the setter', () => {
		const element = textarea('fix the bug', 4);
		const setValue = vi.fn((value: string) => {
			element.value = value;
		});
		const target = controlledTextDictationTarget({ getElement: () => element, setValue });

		expect(target.insert('login')).toBe(true);

		expect(setValue).toHaveBeenCalledWith('fix login the bug');
		expect(element.selectionStart).toBe('fix login '.length);
	});

	it('replaces the selection', () => {
		const element = textarea('fix the bug', 4, 7);
		const setValue = vi.fn();
		controlledTextDictationTarget({ getElement: () => element, setValue }).insert('this');
		expect(setValue).toHaveBeenCalledWith('fix this bug');
	});

	it('dispatches no input event, so the composer onChange never runs', () => {
		const element = textarea('', 0);
		const onInput = vi.fn();
		element.addEventListener('input', onInput);
		const setValue = vi.fn();

		controlledTextDictationTarget({ getElement: () => element, setValue }).insert('!ls');

		expect(setValue).toHaveBeenCalledWith('!ls');
		expect(onInput).not.toHaveBeenCalled();
	});

	it('reports a surface that is gone and writes nothing', () => {
		const setValue = vi.fn();
		const target = controlledTextDictationTarget({ getElement: () => null, setValue });
		expect(target.insert('hello')).toBe(false);
		expect(setValue).not.toHaveBeenCalled();
	});

	it('does not take focus back from another text box', () => {
		const element = textarea('a', 1);
		const other = textarea('', 0);
		other.focus();
		controlledTextDictationTarget({
			getElement: () => element,
			setValue: (value) => {
				element.value = value;
			},
		}).insert('b');
		expect(document.activeElement).toBe(other);
	});
});

describe('nativeTextDictationTarget', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('writes the value and dispatches the input event a React onChange listens for', () => {
		const element = textarea('hello world', 5);
		const onInput = vi.fn();
		element.addEventListener('input', onInput);

		expect(nativeTextDictationTarget(element).insert('big')).toBe(true);

		expect(element.value).toBe('hello big world');
		expect(element.selectionStart).toBe('hello big'.length);
		expect(onInput).toHaveBeenCalledTimes(1);
	});

	it('refuses an element that left the document', () => {
		const element = textarea('x', 1);
		element.remove();
		expect(nativeTextDictationTarget(element).insert('y')).toBe(false);
		expect(element.value).toBe('x');
	});
});

describe('insertDictationIntoEditorView', () => {
	it('replaces the selection in one transaction and leaves the caret after it', () => {
		const { view, dispatch } = fakeView('one three', 4);

		expect(insertDictationIntoEditorView(view, 'two')).toBe(true);

		expect(dispatch).toHaveBeenCalledTimes(1);
		const transaction = dispatch.mock.calls[0][0];
		expect(transaction.changes).toEqual({ from: 4, to: 4, insert: 'two ' });
		expect(transaction.selection.main.head).toBe(8);
	});

	it('refuses a read-only editor', () => {
		const { view, dispatch } = fakeView('locked', 0, 0, true);
		expect(insertDictationIntoEditorView(view, 'words')).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
	});
});

describe('dictationTargetForElement', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	function input(type: string | null, attrs: Record<string, string> = {}): HTMLInputElement {
		const element = document.createElement('input');
		if (type !== null) element.setAttribute('type', type);
		for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
		document.body.appendChild(element);
		return element;
	}

	it('covers a textarea and a text input with no wiring', () => {
		expect(dictationTargetForElement(textarea('', 0))).not.toBeNull();
		expect(dictationTargetForElement(input(null))).not.toBeNull();
		expect(dictationTargetForElement(input('search'))).not.toBeNull();
	});

	it('answers null for what a transcript must not be typed into', () => {
		expect(dictationTargetForElement(null)).toBeNull();
		expect(dictationTargetForElement(input('password'))).toBeNull();
		expect(dictationTargetForElement(input('checkbox'))).toBeNull();
		expect(dictationTargetForElement(input('text', { readonly: '' }))).toBeNull();
		expect(dictationTargetForElement(input('text', { disabled: '' }))).toBeNull();
		expect(dictationTargetForElement(document.createElement('button'))).toBeNull();
	});

	it('never targets a terminal, whose hidden textarea types into a shell', () => {
		const terminal = document.createElement('div');
		terminal.className = 'xterm';
		const helper = document.createElement('textarea');
		terminal.appendChild(helper);
		document.body.appendChild(terminal);
		expect(dictationTargetForElement(helper)).toBeNull();
	});
});
