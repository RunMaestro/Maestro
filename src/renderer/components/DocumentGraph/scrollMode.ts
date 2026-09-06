/**
 * What the scroll wheel does on the Document Graph canvas.
 *
 * Two modes, because the two things a user does with a graph want opposite
 * bindings. While finding the right framing, scroll-to-zoom is what you want.
 * Once the zoom is right and you are reading a wide graph, every scroll gesture
 * is a request to move sideways, and zoom-on-scroll fights it - the view
 * changes scale on a gesture that meant "pan", and the framing that took effort
 * to find is gone.
 *
 * The modifier always reaches the OTHER mode (Shift+scroll pans in Zoom mode
 * and zooms in Pan mode), so neither action is ever more than a key away and
 * the mode is a default rather than a lock.
 *
 * Shared by the canvas, the toolbar pill, and the Help panel toggle so the
 * three cannot disagree about what the wheel is currently bound to - a stale
 * label here is worse than no label, since the user reads it to decide whether
 * to reach for Shift.
 */

/** Scroll wheel binding on the graph canvas. */
export type GraphScrollMode = 'zoom' | 'pan';

/** The shipped default. Matches the graph's behaviour before the mode existed. */
export const DEFAULT_SCROLL_MODE: GraphScrollMode = 'zoom';

/**
 * localStorage key. A view preference the user sets by clicking, not worth a
 * Settings row, but it must survive the graph closing: a user who switched to
 * Pan for a reading session should not have to switch back every time.
 */
export const SCROLL_MODE_STORAGE_KEY = 'documentGraph.scrollPans';

/** How each mode reads in a pill, a toggle, or a tooltip. */
export const SCROLL_MODE_LABELS: Record<
	GraphScrollMode,
	{ name: string; wheelAction: string; modifierAction: string }
> = {
	zoom: {
		name: 'Zoom',
		wheelAction: 'Zoom in/out',
		modifierAction: 'Pan the canvas',
	},
	pan: {
		name: 'Pan',
		wheelAction: 'Pan the canvas',
		modifierAction: 'Zoom in/out',
	},
};

/** The other mode. `S` and both click targets go through this. */
export function nextScrollMode(current: GraphScrollMode): GraphScrollMode {
	return current === 'zoom' ? 'pan' : 'zoom';
}

/**
 * The mode is persisted as a boolean ("does scroll pan?") rather than as the
 * mode string, so `usePersistedToggle` can own the storage. These two convert
 * at the edge; nothing else should know the stored value is a boolean.
 */
export function scrollModeFromPans(pans: boolean): GraphScrollMode {
	return pans ? 'pan' : 'zoom';
}

export function scrollModePans(mode: GraphScrollMode): boolean {
	return mode === 'pan';
}
