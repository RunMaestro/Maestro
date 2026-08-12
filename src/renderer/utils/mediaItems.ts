/**
 * Media Item Helpers
 *
 * Media is not a document, so it never becomes a file preview tab. Opening an
 * audio or video file hands it to the floating player and nothing else: no tab
 * in the bar, no main panel takeover, no header. The player is the only surface
 * media ever appears on.
 *
 * That makes this module the owner of "what is a playable media file" and of
 * the play queue's ordering, shared by the open path (which diverts media
 * before a tab can be created), the playback store, and the player itself.
 *
 * The playability test is deliberately content-based rather than
 * extension-based. The main process only hands back a `maestro-media://` stream
 * URL for *local* files it can actually range-serve, so a `.mp4` opened over
 * SSH keeps the existing binary "download and open externally" path instead of
 * landing in a player that has no bytes to read.
 */

import { getMediaKind, isMediaStreamUrl, type MediaKind } from '../../shared/mediaTypes';

/**
 * Media kind for a file the user just opened, or `null` when it is not playable
 * media and should go through the normal file preview path.
 *
 * @param fileName Filename WITH its extension. A `FilePreviewTab` splits the
 *   two apart (`name: 'song'`, `extension: '.mp3'`), so passing `tab.name`
 *   directly is how you silently get "song" and no media.
 * @param content What the main process returned for the file. A stream URL
 *   means it is locally servable.
 */
export function getOpenedMediaKind(fileName: string, content: string): MediaKind | null {
	if (!isMediaStreamUrl(content)) return null;
	return getMediaKind(fileName);
}

/** One entry in the play queue. */
export interface MediaItem {
	/** Stable per agent + path, so re-opening the same file resumes it. */
	id: string;
	path: string;
	/** Filename including the extension, shown in the player's title bar. */
	name: string;
	/** Agent the file was opened from, so the player can say where it came from. */
	sessionId: string;
	sessionName: string;
	kind: MediaKind;
}

/**
 * Identity of a media item.
 *
 * Keyed on agent + path rather than a generated ID so re-opening the same file
 * lands on the same queue entry and picks up its remembered position, instead
 * of stacking duplicates that all start from zero.
 */
export function mediaItemId(sessionId: string, path: string): string {
	return `${sessionId}::${path}`;
}

/**
 * The item `steps` positions from the active one, or `null` when there is
 * nowhere to go.
 *
 * The order is open order, not a visit-history stack. With two files the two
 * are identical, and with more, open order is the one the user can predict:
 * prev/next walk the same sequence every time instead of depending on how they
 * arrived. Jumping around by recency is what the history menu is for. Does not
 * wrap, so the ends of the queue disable the buttons.
 */
export function stepMediaItem(
	items: MediaItem[],
	activeItemId: string | null,
	steps: number
): MediaItem | null {
	if (items.length === 0) return null;
	const index = items.findIndex((item) => item.id === activeItemId);
	// Unknown active item (just closed, or none yet): treat the ends as the start.
	if (index === -1) return steps > 0 ? items[0] : items[items.length - 1];
	const next = index + steps;
	if (next < 0 || next >= items.length) return null;
	return items[next];
}

/**
 * Queue entries in most-recently-played order, for the history menu.
 *
 * History holds IDs rather than items so a closed entry drops out on its own
 * instead of leaving the menu pointing at something that no longer exists.
 */
export function resolveMediaHistory(items: MediaItem[], history: string[]): MediaItem[] {
	const byId = new Map(items.map((item) => [item.id, item]));
	const seen = new Set<string>();
	const resolved: MediaItem[] = [];
	for (const id of history) {
		if (seen.has(id)) continue;
		const item = byId.get(id);
		if (!item) continue;
		seen.add(id);
		resolved.push(item);
	}
	return resolved;
}
