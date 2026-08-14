/**
 * Media Playback Store
 *
 * State for the app's single audio/video player.
 *
 * Media never becomes a file preview tab. Opening an audio or video file adds
 * it to this queue and shows the floating player - that widget is the only
 * surface media appears on, and it can be dragged anywhere or minimized to the
 * Left Bar header without stopping playback. Nothing takes over the main panel,
 * so a podcast plays while the user keeps working.
 *
 * **Minimizing and closing are different things**, which is what `dismissed`
 * and `closeItem` express: minimizing (`dismissed`) only hides the widget and
 * playback carries on from the header pill, while closing releases the player
 * and the sound stops. A control that hides itself must not silently also stop
 * the audio, and a close button that only hid it would leave sound coming from
 * nowhere.
 *
 * Exactly one item plays at a time. Several can be queued, but only the
 * **active** one has a mounted player; the transport's prev/next move between
 * them, a finished item hands off to the next, and the history menu jumps by
 * recency. Switching pauses whatever was playing, which is what keeps two audio
 * streams from ever overlapping.
 *
 * The element itself lives in `MediaPlaybackHost`, mounted once in `App.tsx`
 * and never unmounted: removing a media element from the document runs the HTML
 * spec's internal pause steps, so anything that renders per-tab or per-agent
 * would kill playback on every switch.
 *
 * **Queue and history are two lists, not one.** The queue is what plays next,
 * in open order, and it survives a restart (via the `mediaPlayerQueue` setting,
 * along with the loaded item and every remembered position) so a half-listened
 * playlist is still there tomorrow. History is what was played, newest first,
 * and it is deliberately per-boot: a fresh session should not open onto a log
 * of last week's files. Because they outlive each other in opposite directions,
 * history holds whole items rather than pointers into the queue - removing
 * something from the queue must not rewrite what the user already heard, and
 * picking it out of history re-queues it.
 *
 * `maestro-media://` stream URLs are minted per boot, so only paths are
 * persisted; the player re-resolves the URL when an item loads.
 *
 * Float geometry is position plus a width **per kind**: the frame's height is
 * always derived from the media (audio has no picture, video wants its own
 * aspect ratio), so it is not a number anyone stores. See `mediaFloatGeometry`.
 *
 * Multi-window note: each renderer holds its own copy of this store, so on a
 * multi-window build two windows can each own a player.
 */

import { create } from 'zustand';

import { mediaItemId, pushMediaHistory, trimMediaQueue, type MediaItem } from '../utils/mediaItems';
import { normalizeMediaAspect, type PersistedMediaFloat } from '../utils/mediaFloatGeometry';
import type { MediaKind } from '../../shared/mediaTypes';

/** Everything needed to queue a file, minus the derived ID. */
export type MediaOpenRequest = Omit<MediaItem, 'id'>;

/**
 * Entries kept in the history menu. Deep enough to cover a listening session,
 * shallow enough that the menu stays scannable.
 */
export const MEDIA_HISTORY_LIMIT = 20;

/**
 * Entries kept in the queue. The queue persists, so without a cap every file
 * the user ever opened would accumulate on disk forever.
 */
export const MEDIA_QUEUE_LIMIT = 50;

/** Settings key holding the queue across restarts. */
export const MEDIA_QUEUE_SETTINGS_KEY = 'mediaPlayerQueue';

/** Settings key holding the player's position and per-kind widths. */
export const MEDIA_FLOAT_SETTINGS_KEY = 'mediaPlayerFloatRect';

/** What `mediaPlayerQueue` stores. Stream URLs are not persisted, only paths. */
export interface PersistedMediaQueue {
	items: MediaItem[];
	activeItemId: string | null;
	resumeTimes: Record<string, number>;
	/**
	 * Known lengths. Persisted because only the loaded file is ever mounted: with
	 * nothing on disk, a restored queue would show a length for one row and
	 * `--:--` for the other nine until each was played.
	 */
	durations: Record<string, number>;
}

interface MediaPlaybackStoreState {
	/** Play queue, in open order. Persisted. */
	items: MediaItem[];
	/** Item whose player is mounted. Null when nothing is loaded. Persisted. */
	activeItemId: string | null;
	/** Recently played, newest first. Per-boot: never persisted. */
	history: MediaItem[];
	/** Whether the active player is currently playing. */
	playing: boolean;
	/**
	 * Player minimized to the Left Bar header. Playback continues - minimizing is
	 * not stopping. Cleared by opening a media file, by the now-playing pill's
	 * restore button, or by the "Show Floating Media Player" command.
	 */
	dismissed: boolean;
	/** One-shot: start playing once the active item is ready. */
	pendingAutoplay: boolean;
	/**
	 * Incremented to ask the player to toggle play/pause. A nonce rather than a
	 * function in state, so the Left Bar's now-playing pill can drive the element
	 * without anyone holding a ref across the frame boundary.
	 */
	toggleRequest: number;
	/** Item ID -> last playback position, so coming back resumes. Persisted. */
	resumeTimes: Record<string, number>;
	/**
	 * Item ID -> length in seconds, learned when a file loads. Persisted, so the
	 * queue and history lists can show how long something is without having to
	 * mount it first.
	 */
	durations: Record<string, number>;
	/** Where the player sits. Null until the user moves or resizes it. Persisted. */
	floatPosition: { top: number; left: number } | null;
	/**
	 * Width the user last chose, per media kind. Height is derived from the
	 * media, so it is never stored. Persisted.
	 */
	floatWidths: Partial<Record<MediaKind, number>>;
	/**
	 * Item ID -> picture aspect ratio, learned from the file when it loads.
	 *
	 * Per boot: it costs one frame to re-learn and would otherwise be one more
	 * thing on disk that could disagree with the file.
	 */
	aspects: Record<string, number>;

	/**
	 * Queue a file the user just opened and play it.
	 *
	 * Re-opening a file already in the queue reuses its entry rather than
	 * stacking a duplicate, so it resumes where it left off.
	 */
	openMedia: (request: MediaOpenRequest) => void;
	/**
	 * Add files to the end of the queue without interrupting what is playing.
	 *
	 * The one exception is an idle player: with nothing loaded there is no
	 * widget on screen, so the first queued file becomes the active one (paused,
	 * not autoplaying) rather than landing in a queue the user cannot see.
	 *
	 * @returns How many files were newly queued. Already-queued files are left
	 *   where they are, so "add to queue" twice does not reorder anything.
	 */
	enqueueMedia: (requests: MediaOpenRequest[]) => number;
	/**
	 * Make a queued item the active player, un-hiding the widget.
	 *
	 * @param itemId - Queue entry to activate.
	 * @param opts.autoplay - Start playing when ready. Set when the user opened
	 *   the file or navigated here with the player's own controls.
	 */
	setActiveItem: (itemId: string, opts?: { autoplay?: boolean }) => void;
	setPlaying: (playing: boolean) => void;
	/**
	 * Hand off to the next queued item when one finishes.
	 *
	 * Distinct from the transport's next button only in what happens at the end
	 * of the queue: there is nothing to advance to, so the finished item stays
	 * loaded and paused rather than the player going blank.
	 */
	advanceAfterEnded: () => void;
	/** Consume the one-shot autoplay request. */
	consumeAutoplay: () => void;
	/** Ask the active player to toggle play/pause. */
	requestToggle: () => void;
	/** Drop an item from the queue. Releases the player if it was active. */
	closeItem: (itemId: string) => void;
	/** Empty the queue and release the player. */
	clearQueue: () => void;
	/** Drop one entry from the recently-played list. Leaves the queue alone. */
	removeHistoryItem: (itemId: string) => void;
	/** Forget everything played this session. */
	clearHistory: () => void;
	/** Hide the player without stopping playback. */
	dismiss: () => void;
	/** Bring the player back. */
	restore: () => void;
	/**
	 * Remember where the user put the player, and how wide they made it for this
	 * kind of media.
	 */
	setFloatGeometry: (kind: MediaKind, rect: { top: number; left: number; width: number }) => void;
	/** Remember where an item was paused, so returning to it resumes. */
	rememberTime: (itemId: string, seconds: number) => void;
	/** Record how long a file is, for the queue and history lists. */
	rememberDuration: (itemId: string, seconds: number) => void;
	/** Record a video's real shape, so the frame can fit it. */
	rememberAspect: (itemId: string, aspect: number) => void;
}

function persistFloat(float: PersistedMediaFloat): void {
	window.maestro?.settings?.set(MEDIA_FLOAT_SETTINGS_KEY, float);
}

/**
 * Queue writes are debounced because `rememberTime` fires several times a
 * second while media plays. Half a second is short enough that a restart loses
 * nothing a listener would notice, and long enough to collapse a burst of
 * position updates (or a ten-file "add to queue") into one settings write.
 */
const QUEUE_PERSIST_DELAY_MS = 500;
let queuePersistTimer: ReturnType<typeof setTimeout> | null = null;

/** Write the queue, the loaded item, and every remembered position to settings. */
function writeQueueNow(): void {
	const { items, activeItemId, resumeTimes, durations } = useMediaPlaybackStore.getState();
	const queued = new Set(items.map((item) => item.id));
	// Durations outlive the queue in memory, because history rows still show the
	// length of a file that was removed. On disk they are pruned to the queue, or
	// every file the user ever played would accumulate there forever.
	const persistedDurations: Record<string, number> = {};
	for (const [id, seconds] of Object.entries(durations)) {
		if (queued.has(id)) persistedDurations[id] = seconds;
	}
	const payload: PersistedMediaQueue = {
		items,
		activeItemId,
		resumeTimes,
		durations: persistedDurations,
	};
	window.maestro?.settings?.set(MEDIA_QUEUE_SETTINGS_KEY, payload);
}

function persistQueue(): void {
	if (queuePersistTimer) clearTimeout(queuePersistTimer);
	queuePersistTimer = setTimeout(() => {
		queuePersistTimer = null;
		writeQueueNow();
	}, QUEUE_PERSIST_DELAY_MS);
}

/** Flush a pending queue write immediately. Used when the window is going away. */
export function flushMediaQueuePersist(): void {
	if (!queuePersistTimer) return;
	clearTimeout(queuePersistTimer);
	queuePersistTimer = null;
	writeQueueNow();
}

/**
 * History patch for a change of loaded track.
 *
 * Enforces one invariant: **the loaded track is never in history.** "Recently
 * played" means what you already heard and are not hearing now, so the track in
 * the player is excluded - it is named in the title bar two inches away, and
 * listing it in both places at once is what made a single open file appear
 * twice.
 *
 * That takes two moves, not one. The outgoing track joins the list, because it
 * has just become something you played rather than something you are playing.
 * The incoming track leaves it, which matters when you replay something from
 * history: without the removal it would sit at the top of "recently played"
 * while audibly playing.
 *
 * @returns A `history` patch, or nothing when neither move applies.
 */
function historyForActiveChange(
	state: MediaPlaybackStoreState,
	incomingId: string | null
): { history: MediaItem[] } | undefined {
	const outgoingId = state.activeItemId;
	let history = state.history;

	if (outgoingId && outgoingId !== incomingId) {
		// Prefer the queue's copy for fresh metadata, but fall back to the history
		// entry so a track already dropped from the queue still records its exit.
		const outgoing =
			state.items.find((item) => item.id === outgoingId) ??
			state.history.find((item) => item.id === outgoingId);
		if (outgoing) history = pushMediaHistory(history, outgoing, MEDIA_HISTORY_LIMIT);
	}

	if (incomingId) {
		const withoutIncoming = history.filter((item) => item.id !== incomingId);
		if (withoutIncoming.length !== history.length) history = withoutIncoming;
	}

	return history === state.history ? undefined : { history };
}

export const useMediaPlaybackStore = create<MediaPlaybackStoreState>()((set, get) => ({
	items: [],
	activeItemId: null,
	history: [],
	playing: false,
	dismissed: false,
	pendingAutoplay: false,
	toggleRequest: 0,
	resumeTimes: {},
	durations: {},
	floatPosition: null,
	floatWidths: {},
	aspects: {},

	openMedia: (request) => {
		set((state) => {
			const id = mediaItemId(request.sessionId, request.path);
			const existing = state.items.find((item) => item.id === id);
			const item: MediaItem = { ...request, id };
			const items = existing
				? // Keep its queue position (prev/next order is open order) but refresh
					// the metadata, since the agent may have been renamed since.
					state.items.map((current) => (current.id === id ? item : current))
				: [...state.items, item];

			return {
				items: trimMediaQueue(items, MEDIA_QUEUE_LIMIT, id),
				activeItemId: id,
				...historyForActiveChange(state, id),
				// Opening is an explicit request to hear it, even if it was already
				// active and paused.
				pendingAutoplay: true,
				dismissed: false,
				// Switching items unmounts the outgoing player, which pauses it. Only
				// one element is ever mounted, so overlapping audio is structurally
				// impossible rather than something we have to remember to prevent.
				...(state.activeItemId === id ? {} : { playing: false }),
			};
		});
		persistQueue();
	},

	enqueueMedia: (requests) => {
		if (requests.length === 0) return 0;
		let added = 0;
		set((state) => {
			const items = [...state.items];
			const known = new Set(items.map((item) => item.id));
			for (const request of requests) {
				const id = mediaItemId(request.sessionId, request.path);
				if (known.has(id)) continue;
				known.add(id);
				items.push({ ...request, id });
				added++;
			}
			if (added === 0) return state;

			// Nothing loaded means no widget on screen, so the queue would be
			// invisible. Load the first entry paused: the user asked to queue, not
			// to listen, so it does not start itself.
			const activeItemId = state.activeItemId ?? items[0].id;
			return {
				items: trimMediaQueue(items, MEDIA_QUEUE_LIMIT, activeItemId),
				activeItemId,
				...(state.activeItemId ? {} : { dismissed: false }),
			};
		});
		if (added > 0) persistQueue();
		return added;
	},

	setActiveItem: (itemId, opts) => {
		set((state) => {
			const target = state.items.find((item) => item.id === itemId);
			if (!target) return state;
			const autoplay = opts?.autoplay ?? false;
			if (state.activeItemId === itemId) {
				// Already active. Honor a fresh autoplay request and un-hide, but do
				// not restart something mid-listen.
				if (!autoplay && !state.dismissed) return state;
				return {
					dismissed: false,
					pendingAutoplay: state.pendingAutoplay || autoplay,
				};
			}
			return {
				activeItemId: itemId,
				...historyForActiveChange(state, itemId),
				playing: false,
				dismissed: false,
				pendingAutoplay: autoplay,
			};
		});
		persistQueue();
	},

	setPlaying: (playing) => set((state) => (state.playing === playing ? state : { playing })),

	advanceAfterEnded: () => {
		const { items, activeItemId, setActiveItem, rememberTime } = get();
		const index = items.findIndex((item) => item.id === activeItemId);
		// A finished file should start from the top next time, not from its own
		// end - otherwise coming back to it plays nothing.
		if (activeItemId) rememberTime(activeItemId, 0);
		if (index === -1) return;
		const next = items[index + 1];
		if (!next) return;
		setActiveItem(next.id, { autoplay: true });
	},

	consumeAutoplay: () =>
		set((state) => (state.pendingAutoplay ? { pendingAutoplay: false } : state)),

	requestToggle: () => set((state) => ({ toggleRequest: state.toggleRequest + 1 })),

	closeItem: (itemId) => {
		let changed = false;
		set((state) => {
			if (!state.items.some((item) => item.id === itemId)) return state;
			changed = true;
			const items = state.items.filter((item) => item.id !== itemId);
			const resumeTimes = { ...state.resumeTimes };
			delete resumeTimes[itemId];

			return {
				items,
				resumeTimes,
				// Closing the playing item releases the player rather than
				// auto-advancing: closing is "stop", not "skip". The track is leaving
				// the player, so it lands in history the same as if the next one had
				// started - otherwise playing something and then closing it would
				// lose it from "recently played" entirely.
				...(state.activeItemId === itemId
					? {
							activeItemId: null,
							playing: false,
							pendingAutoplay: false,
							...historyForActiveChange(state, null),
						}
					: {}),
			};
		});
		if (changed) persistQueue();
	},

	clearQueue: () => {
		set((state) => {
			// Clears what is QUEUED, which no longer includes the track in the
			// player: the menu this button lives in lists what plays next, so
			// emptying it must not also stop the music. Closing (the `x`) is what
			// stops playback, and it is one button away.
			const loaded = state.items.find((item) => item.id === state.activeItemId);
			const items = loaded ? [loaded] : [];
			if (items.length === state.items.length) return state;

			const resumeTimes = loaded ? { [loaded.id]: state.resumeTimes[loaded.id] ?? 0 } : {};
			return { items, resumeTimes };
		});
		persistQueue();
	},

	removeHistoryItem: (itemId) =>
		set((state) => {
			const history = state.history.filter((entry) => entry.id !== itemId);
			return history.length === state.history.length ? state : { history };
		}),

	clearHistory: () => set((state) => (state.history.length === 0 ? state : { history: [] })),

	dismiss: () => set((state) => (state.dismissed ? state : { dismissed: true })),

	restore: () => set((state) => (state.dismissed ? { dismissed: false } : state)),

	setFloatGeometry: (kind, rect) => {
		set((state) => {
			const float: PersistedMediaFloat = {
				top: rect.top,
				left: rect.left,
				widths: { ...state.floatWidths, [kind]: rect.width },
			};
			persistFloat(float);
			return { floatPosition: { top: float.top, left: float.left }, floatWidths: float.widths };
		});
	},

	rememberTime: (itemId, seconds) => {
		set((state) => ({ resumeTimes: { ...state.resumeTimes, [itemId]: seconds } }));
		persistQueue();
	},

	rememberDuration: (itemId, seconds) => {
		// A live or unknown-length stream reports Infinity; the lists show `--:--`
		// for it rather than a nonsense number.
		if (!Number.isFinite(seconds) || seconds <= 0) return;
		if (useMediaPlaybackStore.getState().durations[itemId] === seconds) return;
		set((state) => ({ durations: { ...state.durations, [itemId]: seconds } }));
		persistQueue();
	},

	rememberAspect: (itemId, aspect) =>
		set((state) => {
			const value = normalizeMediaAspect(aspect);
			if (state.aspects[itemId] === value) return state;
			return { aspects: { ...state.aspects, [itemId]: value } };
		}),
}));

/** Non-React access, for callers outside the component tree. */
export function getMediaPlaybackActions() {
	const state = useMediaPlaybackStore.getState();
	return {
		openMedia: state.openMedia,
		enqueueMedia: state.enqueueMedia,
		setActiveItem: state.setActiveItem,
		setPlaying: state.setPlaying,
		dismiss: state.dismiss,
		restore: state.restore,
		closeItem: state.closeItem,
	};
}

/** Whether a hidden player could be brought back right now. */
export function selectCanRestoreFloatingPlayer(state: MediaPlaybackStoreState): boolean {
	return state.dismissed && state.activeItemId !== null;
}

/** The loaded item, or null when the player is idle. */
export function selectActiveMediaItem(state: MediaPlaybackStoreState): MediaItem | null {
	if (!state.activeItemId) return null;
	return state.items.find((item) => item.id === state.activeItemId) ?? null;
}
