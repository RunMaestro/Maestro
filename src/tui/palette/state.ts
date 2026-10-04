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

/** The palette's names for the shared text-box rules. */
export {
	typedTextFor as paletteTextFor,
	isBackspaceKey as isPaletteBackspace,
} from '../app/textInput';
