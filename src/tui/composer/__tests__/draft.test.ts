import { describe, expect, it } from 'vitest';
import type { Key } from 'ink';
import {
	EMPTY_COMPOSER,
	backspace,
	composerFrom,
	composerTextFor,
	deleteToLineStart,
	insertNewline,
	insertText,
	isBlankComposer,
	layoutComposer,
	moveLeft,
	moveRight,
	moveToLineEnd,
	moveToLineStart,
	moveVertical,
	type ComposerState,
} from '../draft';

const key = (overrides: Partial<Key> = {}): Key => ({
	upArrow: false,
	downArrow: false,
	leftArrow: false,
	rightArrow: false,
	pageDown: false,
	pageUp: false,
	return: false,
	escape: false,
	ctrl: false,
	shift: false,
	tab: false,
	backspace: false,
	delete: false,
	meta: false,
	...overrides,
});

const at = (text: string, cursor: number): ComposerState => ({ text, cursor });

describe('composer draft', () => {
	it('inserts at the caret and moves it past the text', () => {
		const state = insertText(at('held', 2), 'LL');
		expect(state).toEqual({ text: 'heLLld', cursor: 4 });
		expect(insertText(EMPTY_COMPOSER, '')).toBe(EMPTY_COMPOSER);
	});

	it('inserts a line break', () => {
		expect(insertNewline(at('ab', 1))).toEqual({ text: 'a\nb', cursor: 2 });
	});

	it('deletes backwards and stops at the start', () => {
		expect(backspace(at('abc', 2))).toEqual({ text: 'ac', cursor: 1 });
		expect(backspace(EMPTY_COMPOSER)).toBe(EMPTY_COMPOSER);
	});

	it('steps over an emoji as one character', () => {
		const text = 'a😀b';
		expect(moveRight(at(text, 1)).cursor).toBe(3);
		expect(moveLeft(at(text, 3)).cursor).toBe(1);
		expect(backspace(at(text, 3))).toEqual({ text: 'ab', cursor: 1 });
		expect(moveRight(at(text, text.length)).cursor).toBe(text.length);
		expect(moveLeft(at(text, 0)).cursor).toBe(0);
	});

	it('goes to the ends of the caret line and deletes back to its start', () => {
		const text = 'one\ntwo three\nfour';
		const inTwo = at(text, 8);
		expect(moveToLineStart(inTwo).cursor).toBe(4);
		expect(moveToLineEnd(inTwo).cursor).toBe(13);
		expect(deleteToLineStart(inTwo)).toEqual({ text: 'one\nthree\nfour', cursor: 4 });
		expect(moveToLineStart(at(text, 0)).cursor).toBe(0);
		expect(moveToLineEnd(at(text, text.length)).cursor).toBe(text.length);
	});

	it('moves up and down by line and keeps the column', () => {
		const text = 'abcdef\nxy\nlonger line';
		// Column 4 on the first line: the short line clamps to its end, and the third restores nothing.
		const down = moveVertical(at(text, 4), 1);
		expect(down.cursor).toBe(9);
		const downAgain = moveVertical(down, 1);
		expect(downAgain.cursor).toBe(12);
		expect(moveVertical(at(text, 12), -1).cursor).toBe(9);
		// At the first line, Up goes to the start; at the last, Down goes to the end.
		expect(moveVertical(at(text, 3), -1).cursor).toBe(0);
		expect(moveVertical(at(text, text.length - 2), 1).cursor).toBe(text.length);
	});

	it('knows a blank draft', () => {
		expect(isBlankComposer(EMPTY_COMPOSER)).toBe(true);
		expect(isBlankComposer(composerFrom(' \n\t '))).toBe(true);
		expect(isBlankComposer(composerFrom(' hi '))).toBe(false);
		expect(composerFrom('abc').cursor).toBe(3);
	});

	describe('composerTextFor', () => {
		it('keeps the line breaks of a paste, reading CRLF and CR as one break', () => {
			expect(composerTextFor('a\r\nb\rc\nd', key())).toBe('a\nb\nc\nd');
		});

		it('turns a tab into spaces and drops other control characters', () => {
			expect(composerTextFor('a\tb\u0007\u001b[c', key())).toBe('a  b[c');
		});

		it('adds nothing for a Ctrl or Meta chord', () => {
			expect(composerTextFor('a', key({ ctrl: true }))).toBe('');
			expect(composerTextFor('a', key({ meta: true }))).toBe('');
		});
	});

	describe('layoutComposer', () => {
		it('lays a short draft out as one row with the caret at its end', () => {
			const layout = layoutComposer(composerFrom('hello'), 20, 6);
			expect(layout).toEqual({ rows: [{ text: 'hello', caret: 5 }], hiddenAbove: 0 });
		});

		it('gives an empty draft one row with the caret at 0', () => {
			expect(layoutComposer(EMPTY_COMPOSER, 20, 6).rows).toEqual([{ text: '', caret: 0 }]);
		});

		it('wraps a long line and keeps a column free for the caret', () => {
			// Width 6 leaves 5 columns of text.
			const layout = layoutComposer(composerFrom('abcdefghijkl'), 6, 6);
			expect(layout.rows.map((row) => row.text)).toEqual(['abcde', 'fghij', 'kl']);
			expect(layout.rows[2]?.caret).toBe(2);
			expect(layout.rows[0]?.caret).toBeUndefined();
		});

		it('puts a caret on a wrap boundary at the start of the next row', () => {
			const layout = layoutComposer(at('abcdefghij', 5), 6, 6);
			expect(layout.rows.map((row) => row.caret)).toEqual([undefined, 0]);
		});

		it('draws each line break as a new row, empty lines included', () => {
			const layout = layoutComposer(at('a\n\nb', 2), 20, 6);
			expect(layout.rows).toEqual([{ text: 'a' }, { text: '', caret: 0 }, { text: 'b' }]);
		});

		it('counts wide characters by their columns', () => {
			// Each ideograph takes two columns; four columns of room hold two of them.
			const layout = layoutComposer(composerFrom('日本語です'), 5, 6);
			expect(layout.rows.map((row) => row.text)).toEqual(['日本', '語で', 'す']);
		});

		it('shows the last rows up to the caret and counts the ones above', () => {
			const text = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
			const atEnd = layoutComposer(composerFrom(text), 20, 3);
			expect(atEnd.rows.map((row) => row.text)).toEqual(['6', '7', '8']);
			expect(atEnd.hiddenAbove).toBe(5);
			// A caret on the third line shows the rows that end at it.
			const early = layoutComposer(at(text, 5), 20, 3);
			expect(early.rows.map((row) => row.text)).toEqual(['1', '2', '3']);
			expect(early.hiddenAbove).toBe(0);
			expect(early.rows[2]?.caret).toBe(1);
		});
	});
});
