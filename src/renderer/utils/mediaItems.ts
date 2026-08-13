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

import { formatElapsedTimeColon } from '../../shared/formatters';
import { getMediaKind, isMediaStreamUrl, type MediaKind } from '../../shared/mediaTypes';

/**
 * A media clock time (`4:26`, `1:02:30`), or `--:--` when it is not known yet.
 *
 * Media times are fractional and can be `Infinity` for a live stream, while
 * `formatElapsedTimeColon` wants whole seconds - this is the one place that
 * bridges the two, so the transport and the queue/history lists cannot drift
 * into showing the same file's length two different ways.
 */
export function formatMediaTime(seconds: number | undefined): string {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '--:--';
	return formatElapsedTimeColon(Math.floor(Math.max(0, seconds)));
}

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
 * Put an item at the front of the recently-played list, deduped and capped.
 *
 * History holds whole items rather than IDs into the queue: the two lists have
 * different lifetimes (the queue is persisted, history is per-boot) and
 * different owners (removing something from the queue must not rewrite what the
 * user already listened to), so history has to be able to name a file the queue
 * no longer holds. Selecting such an entry re-queues it.
 */
export function pushMediaHistory(
	history: MediaItem[],
	item: MediaItem,
	limit: number
): MediaItem[] {
	return [item, ...history.filter((entry) => entry.id !== item.id)].slice(0, limit);
}

/**
 * Trim a queue to `limit` entries, dropping the oldest queue positions first.
 *
 * The queue persists across restarts, so without a cap every media file the
 * user ever opened would pile up forever. `keepId` is never dropped, so the
 * loaded file survives even when it is the oldest entry.
 */
export function trimMediaQueue(
	items: MediaItem[],
	limit: number,
	keepId: string | null
): MediaItem[] {
	if (items.length <= limit) return items;
	const trimmed: MediaItem[] = [];
	// Walk newest-first, keeping the tail; the active item is always kept.
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (trimmed.length < limit || item.id === keepId) trimmed.unshift(item);
	}
	return trimmed;
}

/**
 * Coerce a persisted queue back into media items, dropping anything malformed.
 *
 * Entries are read straight off disk and handed to a media element, so a
 * hand-edited or half-written settings file must not be able to put a
 * non-string path into the player.
 */
export function sanitizeMediaItems(value: unknown): MediaItem[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const items: MediaItem[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) continue;
		const { path, name, sessionId, sessionName, kind } = entry as Record<string, unknown>;
		if (typeof path !== 'string' || !path) continue;
		if (typeof name !== 'string' || !name) continue;
		if (typeof sessionId !== 'string' || !sessionId) continue;
		if (kind !== 'audio' && kind !== 'video') continue;
		const id = mediaItemId(sessionId, path);
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({
			id,
			path,
			name,
			sessionId,
			sessionName: typeof sessionName === 'string' ? sessionName : '',
			kind,
		});
	}
	return items;
}

/**
 * Coerce a persisted map of item ID -> seconds, dropping anything that is not a
 * real time. Used for both remembered positions and known durations.
 */
export function sanitizeMediaTimes(value: unknown, knownIds: Set<string>): Record<string, number> {
	if (typeof value !== 'object' || value === null) return {};
	const times: Record<string, number> = {};
	for (const [id, seconds] of Object.entries(value as Record<string, unknown>)) {
		// Times for files no longer queued are dead weight.
		if (!knownIds.has(id)) continue;
		if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) continue;
		times[id] = seconds;
	}
	return times;
}
