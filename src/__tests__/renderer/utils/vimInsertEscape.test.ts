/**
 * Tests for `jk`, the in-field escape.
 *
 * The behaviors here are the ones whose failure is either silent or actively
 * destructive, so each has a test rather than a comment:
 *
 *  - A near miss costs the user nothing. The whole gesture is retractive: the
 *    `j` is in the field before anything knows a `k` is coming, so every path
 *    that is NOT an escape has to leave every typed character exactly where it
 *    is. `ja`, a `k` after the timeout, a moved caret, a live selection.
 *  - A terminal and a CodeMirror editor are not text fields. xterm types
 *    through a hidden `<textarea>`, so without the exclusion a `jk` meant for
 *    `vim` in a Maestro terminal would blur the pane out from under the user.
 *  - A controlled field actually updates. Assigning `.value` on a React-
 *    controlled element is invisible to React and gets overwritten by the next
 *    render, which would put the `j` straight back.
 *  - An unusable setting is OFF, not approximated. A one-character escape would
 *    swallow that character in every text field in the app, including the
 *    Settings field where the user would go to undo it.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
	applyInsertEscape,
	insertEscapeTarget,
	parseInsertEscapeSequence,
	DEFAULT_VIM_INSERT_ESCAPE_SEQUENCE,
	MIN_INSERT_ESCAPE_LENGTH,
	VIM_INSERT_ESCAPE_ID,
} from '../../../renderer/utils/vimInsertEscape';
import {
	createSequenceMatcher,
	SEQUENCE_TIMEOUT_MS,
} from '../../../renderer/utils/shortcutSequence';
import type { ShortcutKeyEvent } from '../../../renderer/utils/shortcutMatch';

/** A keydown with no modifiers unless the test asks for one. */
const press = (key: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	key,
	...mods,
});

/** A focused textarea holding `value`, caret at the end. */
function focusedTextarea(value: string): HTMLTextAreaElement {
	const field = document.createElement('textarea');
	field.value = value;
	document.body.appendChild(field);
	field.focus();
	field.setSelectionRange(value.length, value.length);
	return field;
}

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
});

describe('parseInsertEscapeSequence', () => {
	it('parses the shipped default into one two-step binding', () => {
		const parsed = parseInsertEscapeSequence(DEFAULT_VIM_INSERT_ESCAPE_SEQUENCE);

		expect(parsed).not.toBeNull();
		expect(parsed?.text).toBe('jk');
		// The `j` is what is already in the field when the `k` lands, so it is
		// the only character the retraction may take back.
		expect(parsed?.inserted).toBe('j');
		expect(parsed?.bindings).toEqual([{ id: VIM_INSERT_ESCAPE_ID, sequence: [['j'], ['k']] }]);
	});

	it('reads an empty value as off, which is the documented way to disable it', () => {
		expect(parseInsertEscapeSequence('')).toBeNull();
		expect(parseInsertEscapeSequence('   ')).toBeNull();
	});

	it('reads a one-character value as off rather than binding a single key', () => {
		// A single key would be swallowed in every text field in the app,
		// including the Settings field the user would use to undo it.
		expect(MIN_INSERT_ESCAPE_LENGTH).toBe(2);
		expect(parseInsertEscapeSequence('j')).toBeNull();
	});

	it('reads a value containing whitespace as off', () => {
		expect(parseInsertEscapeSequence('j k')).toBeNull();
		expect(parseInsertEscapeSequence('j\tk')).toBeNull();
	});

	it('reads a non-string as off instead of coercing it', () => {
		expect(parseInsertEscapeSequence(undefined)).toBeNull();
		expect(parseInsertEscapeSequence(null)).toBeNull();
		expect(parseInsertEscapeSequence(12)).toBeNull();
	});

	it('lowercases, because a step with no Shift requires Shift to be up', () => {
		const parsed = parseInsertEscapeSequence('  JK  ');

		expect(parsed?.text).toBe('jk');
		expect(parsed?.bindings[0]?.sequence).toEqual([['j'], ['k']]);
	});

	it('accepts a longer sequence and retracts all but its last character', () => {
		const parsed = parseInsertEscapeSequence('jkl');

		expect(parsed?.inserted).toBe('jk');
		expect(parsed?.bindings[0]?.sequence).toEqual([['j'], ['k'], ['l']]);
	});
});

describe('the escape run, fed through the sequence matcher', () => {
	const bindings = parseInsertEscapeSequence('jk')!.bindings;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	it('completes on j then k', () => {
		const matcher = createSequenceMatcher();

		expect(matcher.feed(press('j'), bindings).outcome).toBe('consumed-prefix');
		expect(matcher.feed(press('k'), bindings)).toEqual({
			outcome: 'matched',
			actionId: VIM_INSERT_ESCAPE_ID,
		});
	});

	it('does not complete when any other character follows the j', () => {
		const matcher = createSequenceMatcher();

		matcher.feed(press('j'), bindings);
		expect(matcher.feed(press('a'), bindings).outcome).toBe('no-match');
		// And the run is over, so the k that follows is just a k.
		expect(matcher.feed(press('k'), bindings).outcome).toBe('no-match');
	});

	it('does not complete when the k arrives after the timeout', () => {
		const matcher = createSequenceMatcher();

		matcher.feed(press('j'), bindings);
		vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1);

		expect(matcher.feed(press('k'), bindings).outcome).toBe('no-match');
	});

	it('does not complete on a capital K, which carries Shift', () => {
		const matcher = createSequenceMatcher();

		matcher.feed(press('j'), bindings);
		expect(matcher.feed(press('K', { shiftKey: true }), bindings).outcome).toBe('no-match');
	});

	it('leaves Escape to the layer stack', () => {
		const matcher = createSequenceMatcher();

		matcher.feed(press('j'), bindings);
		expect(matcher.feed(press('Escape'), bindings).outcome).toBe('no-match');
		expect(matcher.prefix()).toEqual([]);
	});
});

describe('insertEscapeTarget', () => {
	it('resolves the focused textarea it was handed', () => {
		const field = focusedTextarea('hello');

		expect(insertEscapeTarget(field)).toBe(field);
	});

	it('resolves a focused text input', () => {
		const field = document.createElement('input');
		document.body.appendChild(field);
		field.focus();

		expect(insertEscapeTarget(field)).toBe(field);
	});

	it('falls back to the active element when the target is not an element', () => {
		const field = focusedTextarea('hello');

		// xterm re-dispatches some keydowns on `window`, so the target is not
		// always the field the user is typing in.
		expect(insertEscapeTarget(window)).toBe(field);
		expect(insertEscapeTarget(null)).toBe(field);
	});

	it('refuses a textarea inside a terminal, so jk reaches vim in the shell', () => {
		const terminal = document.createElement('div');
		terminal.className = 'xterm';
		const helper = document.createElement('textarea');
		helper.className = 'xterm-helper-textarea';
		terminal.appendChild(helper);
		document.body.appendChild(terminal);
		helper.focus();

		expect(insertEscapeTarget(helper)).toBeNull();
	});

	it('refuses a field inside a CodeMirror editor, which owns its own keymap', () => {
		const editor = document.createElement('div');
		editor.className = 'cm-editor';
		const field = document.createElement('textarea');
		editor.appendChild(field);
		document.body.appendChild(editor);
		field.focus();

		expect(insertEscapeTarget(field)).toBeNull();
	});

	it('refuses an input type that holds no text', () => {
		for (const type of ['checkbox', 'range', 'color', 'radio']) {
			const field = document.createElement('input');
			field.type = type;
			document.body.appendChild(field);
			field.focus();

			expect(insertEscapeTarget(field)).toBeNull();
		}
	});

	it('refuses a read-only or disabled field, which never took the j', () => {
		const readOnly = focusedTextarea('hello');
		readOnly.readOnly = true;
		expect(insertEscapeTarget(readOnly)).toBeNull();

		const disabled = document.createElement('textarea');
		document.body.appendChild(disabled);
		disabled.disabled = true;
		expect(insertEscapeTarget(disabled)).toBeNull();
	});

	it('refuses an element that does not hold focus', () => {
		const field = document.createElement('textarea');
		document.body.appendChild(field);

		expect(insertEscapeTarget(field)).toBeNull();
	});

	it('refuses anything that is not a field', () => {
		const button = document.createElement('button');
		document.body.appendChild(button);
		button.focus();

		expect(insertEscapeTarget(button)).toBeNull();
	});
});

describe('applyInsertEscape', () => {
	it('retracts the j, leaves the caret where it was, and blurs the field', () => {
		const field = focusedTextarea('ship it j');

		expect(applyInsertEscape(field, 'j')).toBe(true);
		expect(field.value).toBe('ship it ');
		expect(field.selectionStart).toBe('ship it '.length);
		expect(document.activeElement).not.toBe(field);
	});

	it('retracts from the middle of the value, not just the end', () => {
		const field = focusedTextarea('ship itj now');
		field.setSelectionRange(8, 8);

		expect(applyInsertEscape(field, 'j')).toBe(true);
		expect(field.value).toBe('ship it now');
	});

	it('fires an input event a controlled field can see', () => {
		// The React-controlled case: a plain `.value =` assignment is invisible
		// to React's value tracker, so the next render would put the `j` back.
		const field = focusedTextarea('abcj');
		const seen: string[] = [];
		field.addEventListener('input', (e) => {
			seen.push((e.target as HTMLTextAreaElement).value);
		});

		expect(applyInsertEscape(field, 'j')).toBe(true);
		expect(seen).toEqual(['abc']);
	});

	it('does nothing when the retraction is not before the caret', () => {
		const field = focusedTextarea('abc');

		expect(applyInsertEscape(field, 'j')).toBe(false);
		expect(field.value).toBe('abc');
		expect(document.activeElement).toBe(field);
	});

	it('does nothing when a selection is live rather than a caret', () => {
		const field = focusedTextarea('abcj');
		field.setSelectionRange(0, 4);

		expect(applyInsertEscape(field, 'j')).toBe(false);
		expect(field.value).toBe('abcj');
		expect(document.activeElement).toBe(field);
	});

	it('does nothing when the caret sits before the whole retraction', () => {
		const field = focusedTextarea('jk');
		field.setSelectionRange(1, 1);

		expect(applyInsertEscape(field, 'jk')).toBe(false);
		expect(field.value).toBe('jk');
	});

	it('retracts a Caps Lock capital, which the matcher also accepts', () => {
		// Caps Lock reports `key: 'J'` with `shiftKey` false, so the step matched
		// and the field holds the capital.
		const field = focusedTextarea('abcJ');

		expect(applyInsertEscape(field, 'j')).toBe(true);
		expect(field.value).toBe('abc');
	});

	it('retracts every leading character of a longer sequence', () => {
		const field = focusedTextarea('abcjk');

		expect(applyInsertEscape(field, 'jk')).toBe(true);
		expect(field.value).toBe('abc');
	});
});
