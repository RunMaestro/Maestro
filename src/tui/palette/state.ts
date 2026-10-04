import type { Key } from 'ink';

/** What the palette has typed and where its cursor is in the ranked results. */
export interface PaletteState {
	query: string;
	cursor: number;
}

export const EMPTY_PALETTE: PaletteState = { query: '', cursor: 0 };

/** Typing narrows the list, so the cursor goes back to the best match. */
export function typeIntoPalette(state: PaletteState, text: string): PaletteState {
	return text ? { query: state.query + text, cursor: 0 } : state;
}

export function backspacePalette(state: PaletteState): PaletteState {
	return state.query ? { query: state.query.slice(0, -1), cursor: 0 } : state;
}

export function movePaletteCursor(state: PaletteState, delta: number, count: number): PaletteState {
	const cursor = Math.min(Math.max(0, count - 1), Math.max(0, state.cursor + delta));
	return cursor === state.cursor ? state : { ...state, cursor };
}

/**
 * The text a keypress adds to the query, with control characters dropped (a
 * pasted block arrives as one `input`; Tab and a stray Esc must not land in the
 * box). Ctrl and Meta chords add nothing.
 */
export function paletteTextFor(input: string, key: Key): string {
	if (key.ctrl || key.meta) return '';
	 
	return input.replace(/[\u0000-\u001f\u007f]/g, '');
}

/** Whether the key deletes the last typed character. Terminals disagree on which flag Backspace sets. */
export function isPaletteBackspace(key: Key): boolean {
	return key.backspace || key.delete;
}
