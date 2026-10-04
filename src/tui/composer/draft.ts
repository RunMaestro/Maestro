/**
 * The composer's text box as pure state: the draft and where the caret is.
 * Every edit is a function from one state to the next, so the rules (a caret
 * steps over a whole emoji, a paste keeps its line breaks, Up and Down hold
 * their column) are tested without Ink. The view lays the state out with
 * `layoutComposer`.
 */

import type { Key } from 'ink';
import { cellWidth } from '../transcript/cellWidth';

export interface ComposerState {
	text: string;
	/** A string index, always on a code point boundary. */
	cursor: number;
}

export const EMPTY_COMPOSER: ComposerState = { text: '', cursor: 0 };

export function isBlankComposer(state: ComposerState): boolean {
	return state.text.trim() === '';
}

/** A draft that was typed or pasted: the caret goes to its end. */
export function composerFrom(text: string): ComposerState {
	return { text, cursor: text.length };
}

function previousIndex(text: string, index: number): number {
	if (index <= 0) return 0;
	const low = text.charCodeAt(index - 1);
	const high = index >= 2 ? text.charCodeAt(index - 2) : 0;
	// A low surrogate preceded by a high one is one character.
	return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? index - 2 : index - 1;
}

function nextIndex(text: string, index: number): number {
	if (index >= text.length) return text.length;
	const high = text.charCodeAt(index);
	const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
	return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? index + 2 : index + 1;
}

/**
 * The text a keypress adds to the composer. Unlike the single-line boxes, line
 * breaks survive (a pasted block arrives as one `input`), with CRLF and a bare
 * CR read as one break; every other control character is dropped. Ctrl and
 * Meta chords add nothing.
 */
export function composerTextFor(input: string, key: Key): string {
	if (key.ctrl || key.meta) return '';
	return input
		.replace(/\r\n?/g, '\n')
		.replace(/\t/g, '  ')
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
}

export function insertText(state: ComposerState, text: string): ComposerState {
	if (text === '') return state;
	return {
		text: state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
		cursor: state.cursor + text.length,
	};
}

export function insertNewline(state: ComposerState): ComposerState {
	return insertText(state, '\n');
}

export function backspace(state: ComposerState): ComposerState {
	if (state.cursor === 0) return state;
	const from = previousIndex(state.text, state.cursor);
	return {
		text: state.text.slice(0, from) + state.text.slice(state.cursor),
		cursor: from,
	};
}

export function moveLeft(state: ComposerState): ComposerState {
	return { ...state, cursor: previousIndex(state.text, state.cursor) };
}

export function moveRight(state: ComposerState): ComposerState {
	return { ...state, cursor: nextIndex(state.text, state.cursor) };
}

function lineStartOf(text: string, index: number): number {
	return text.lastIndexOf('\n', index - 1) + 1;
}

function lineEndOf(text: string, index: number): number {
	const found = text.indexOf('\n', index);
	return found === -1 ? text.length : found;
}

/** Ctrl-A: the start of the caret's line. */
export function moveToLineStart(state: ComposerState): ComposerState {
	return { ...state, cursor: lineStartOf(state.text, state.cursor) };
}

/** Ctrl-E: the end of the caret's line. */
export function moveToLineEnd(state: ComposerState): ComposerState {
	return { ...state, cursor: lineEndOf(state.text, state.cursor) };
}

/** Ctrl-U: drops everything from the start of the caret's line to the caret. */
export function deleteToLineStart(state: ComposerState): ComposerState {
	const from = lineStartOf(state.text, state.cursor);
	return {
		text: state.text.slice(0, from) + state.text.slice(state.cursor),
		cursor: from,
	};
}

function columnOf(text: string, lineStart: number, index: number): number {
	return Array.from(text.slice(lineStart, index)).length;
}

function indexAtColumn(text: string, lineStart: number, lineEnd: number, column: number): number {
	let index = lineStart;
	for (let stepped = 0; stepped < column && index < lineEnd; stepped += 1) {
		index = nextIndex(text, index);
	}
	return Math.min(index, lineEnd);
}

/** Up and Down move by line and keep the column, clamped to the line's length. */
export function moveVertical(state: ComposerState, delta: 1 | -1): ComposerState {
	const { text, cursor } = state;
	const start = lineStartOf(text, cursor);
	const column = columnOf(text, start, cursor);
	if (delta < 0) {
		if (start === 0) return { ...state, cursor: 0 };
		const previousStart = lineStartOf(text, start - 1);
		return { ...state, cursor: indexAtColumn(text, previousStart, start - 1, column) };
	}
	const end = lineEndOf(text, cursor);
	if (end === text.length) return { ...state, cursor: text.length };
	const nextStart = end + 1;
	return { ...state, cursor: indexAtColumn(text, nextStart, lineEndOf(text, nextStart), column) };
}

export interface ComposerRow {
	text: string;
	/**
	 * The caret's position in this row as a count of characters, when the caret
	 * sits on it. Equal to the row's length for a caret past the last character.
	 */
	caret?: number;
}

export interface ComposerLayout {
	rows: ComposerRow[];
	/** Rows cut off above the window (the caret's row is always inside it). */
	hiddenAbove: number;
}

/**
 * The draft as screen rows: each line wrapped to `width` columns (one is kept
 * free so a caret at the end of a full row still fits), then cut to the
 * `maxRows` that end at the caret's row.
 */
export function layoutComposer(
	state: ComposerState,
	width: number,
	maxRows: number
): ComposerLayout {
	const room = Math.max(1, width - 1);
	const rows: Array<ComposerRow & { start: number }> = [];
	let caretRow = 0;
	let offset = 0;

	for (const line of state.text.split('\n')) {
		const lineStart = offset;
		const lineEnd = offset + line.length;
		const chunks: Array<{ start: number; end: number }> = [];
		let start = lineStart;
		let used = 0;
		let at = lineStart;
		while (at < lineEnd) {
			const next = nextIndex(state.text, at);
			const columns = cellWidth(state.text.slice(at, next));
			if (used + columns > room && at > start) {
				chunks.push({ start, end: at });
				start = at;
				used = 0;
			}
			used += columns;
			at = next;
		}
		chunks.push({ start, end: lineEnd });

		chunks.forEach((chunk, index) => {
			const last = index === chunks.length - 1;
			const holdsCaret =
				state.cursor >= chunk.start &&
				(state.cursor < chunk.end || (last && state.cursor <= chunk.end));
			const row: ComposerRow & { start: number } = {
				text: state.text.slice(chunk.start, chunk.end),
				start: chunk.start,
			};
			if (holdsCaret) {
				row.caret = Array.from(state.text.slice(chunk.start, state.cursor)).length;
				caretRow = rows.length;
			}
			rows.push(row);
		});
		offset = lineEnd + 1;
	}

	const limit = Math.max(1, maxRows);
	const first = Math.max(0, Math.min(caretRow - limit + 1, rows.length - limit));
	return {
		rows: rows.slice(first, first + limit).map(({ text, caret }) => ({
			text,
			...(caret !== undefined ? { caret } : {}),
		})),
		hiddenAbove: first,
	};
}
