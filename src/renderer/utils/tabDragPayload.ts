// Structured drag-and-drop payload for intra-window tab tiling (split panes). A
// tab chip (or a tiled pane's title bar) writes this onto the native HTML5
// `dataTransfer` under a Maestro-specific MIME so the main panel's drop zones can
// identify the dragged tab and where it came from.
//
// This is ADDED alongside, never in place of, the `text/plain` tab id TabBar
// writes for in-bar reordering, so the two drops stay cleanly separated:
//   - drop on another tab chip  -> in-bar reorder (reads `text/plain`)
//   - drop onto the tiled panel  -> tile (reads this payload)

import type { UnifiedTabRef } from '../types';

/** MIME type carrying the tiling payload on `dataTransfer`. */
export const TAB_TILE_MIME = 'application/x-maestro-tab';

/**
 * Where a tiling drag originated:
 * - `tab-bar`: a standalone tab chip dragged from the strip (drop onto the panel
 *   tiles it in; drop onto another chip still reorders via `text/plain`).
 * - `pane`: a tiled pane's title bar dragged out (drop onto the tab bar promotes
 *   the pane back to a standalone tab).
 */
export type TabTileSource = 'tab-bar' | 'pane';

/** The structured payload serialized onto `dataTransfer`. */
export interface TabTilePayload {
	/** The dragged tab (leaves reference tabs by value, so this is all we need). */
	ref: UnifiedTabRef;
	/** Origin of the drag - decides which drop targets react. */
	source: TabTileSource;
	/**
	 * When `source === 'pane'`, the group and leaf the pane was dragged from, so a
	 * promote-out drop knows which group to remove the leaf from and auto-dissolve.
	 */
	groupId?: string;
	leafId?: string;
}

/**
 * Write the tiling payload onto a drag's `dataTransfer`. Additive: the caller
 * still sets `text/plain` (the multi-window/reorder tab id) separately - this
 * only appends the Maestro MIME so it can coexist with the drag-out data.
 */
export function writeTabTilePayload(dataTransfer: DataTransfer, payload: TabTilePayload): void {
	dataTransfer.setData(TAB_TILE_MIME, JSON.stringify(payload));
}

/**
 * Read the tiling payload from a drag's `dataTransfer`, or `null` when the drag
 * carries no tiling data (e.g. a file-explorer drag, or a plain reorder that only
 * set `text/plain`). Malformed JSON also yields `null` rather than throwing so a
 * stray drag can never crash a drop handler.
 */
export function readTabTilePayload(dataTransfer: DataTransfer): TabTilePayload | null {
	const raw = dataTransfer.getData(TAB_TILE_MIME);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as TabTilePayload;
		if (!parsed || typeof parsed !== 'object' || !parsed.ref || !parsed.source) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * True when a drag's types advertise a tiling payload. Used on `dragover` to
 * decide whether to activate the panel drop zones, without deserializing on
 * every move (the payload data itself is unreadable during `dragover` in some
 * browsers - only the type list is). Also gates out non-Maestro drags.
 */
export function dragHasTabTilePayload(dataTransfer: DataTransfer | null | undefined): boolean {
	// `dataTransfer` (and its `types`) can be absent or non-iterable depending on
	// the event and environment (jsdom, synthetic drags), so guard before spreading.
	const types = dataTransfer?.types;
	if (!types) return false;
	return Array.from(types).includes(TAB_TILE_MIME);
}
