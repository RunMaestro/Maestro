/**
 * Media Playback Store
 *
 * State for the app's single audio/video player.
 *
 * Media never becomes a file preview tab. Opening an audio or video file adds
 * it to this queue and shows the floating player - that widget is the only
 * surface media appears on, and it can be dragged anywhere, minimized to a
 * pill, or hidden without stopping playback. Nothing takes over the main panel,
 * so a podcast plays while the user keeps working.
 *
 * Exactly one item plays at a time. Several can be queued, but only the
 * **active** one has a mounted player; the transport's prev/next move between
 * them and the history menu jumps by recency. Switching pauses whatever was
 * playing, which is what keeps two audio streams from ever overlapping.
 *
 * The element itself lives in `MediaPlaybackHost`, mounted once in `App.tsx`
 * and never unmounted: removing a media element from the document runs the HTML
 * spec's internal pause steps, so anything that renders per-tab or per-agent
 * would kill playback on every switch.
 *
 * Only the float geometry persists (via settings). The queue does not survive a
 * restart, and `maestro-media://` stream URLs are re-minted per boot anyway.
 *
 * Multi-window note: each renderer holds its own copy of this store, so on a
 * multi-window build two windows can each own a player.
 */

import { create } from 'zustand';

import { mediaItemId, type MediaItem } from '../utils/mediaItems';

/** Position and size of the floating player. */
export interface MediaFloatRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** Everything needed to queue a file, minus the derived ID. */
export type MediaOpenRequest = Omit<MediaItem, 'id'>;

/**
 * Entries kept in the history menu. Deep enough to cover a listening session,
 * shallow enough that the menu stays scannable.
 */
export const MEDIA_HISTORY_LIMIT = 20;

interface MediaPlaybackStoreState {
	/** Play queue, in open order. */
	items: MediaItem[];
	/** Item whose player is mounted. Null when nothing is loaded. */
	activeItemId: string | null;
	/** Item IDs in most-recently-played order, newest first. */
	history: string[];
	/** Whether the active player is currently playing. */
	playing: boolean;
	/**
	 * User hid the player. Playback continues - hiding a control does not stop
	 * media. Cleared by opening a media file or by the "Show Floating Media
	 * Player" command.
	 */
	dismissed: boolean;
	/** Player collapsed to a compact pill. */
	minimized: boolean;
	/** One-shot: start playing once the active item is ready. */
	pendingAutoplay: boolean;
	/**
	 * Incremented to ask the player to toggle play/pause. A nonce rather than a
	 * function in state, so the minimized pill's button can drive the element
	 * without anyone holding a ref across the frame boundary.
	 */
	toggleRequest: number;
	/** Item ID -> last playback position, so coming back resumes. */
	resumeTimes: Record<string, number>;
	/** Floating player geometry. Null until the user moves or resizes it. */
	floatRect: MediaFloatRect | null;

	/**
	 * Queue a file the user just opened and play it.
	 *
	 * Re-opening a file already in the queue reuses its entry rather than
	 * stacking a duplicate, so it resumes where it left off.
	 */
	openMedia: (request: MediaOpenRequest) => void;
	/**
	 * Make a queued item the active player, un-hiding the widget.
	 *
	 * @param itemId - Queue entry to activate.
	 * @param opts.autoplay - Start playing when ready. Set when the user opened
	 *   the file or navigated here with the player's own controls.
	 */
	setActiveItem: (itemId: string, opts?: { autoplay?: boolean }) => void;
	setPlaying: (playing: boolean) => void;
	/** Consume the one-shot autoplay request. */
	consumeAutoplay: () => void;
	/** Ask the active player to toggle play/pause. */
	requestToggle: () => void;
	/** Drop an item from the queue. Releases the player if it was active. */
	closeItem: (itemId: string) => void;
	/** Hide the player without stopping playback. */
	dismiss: () => void;
	/** Bring the player back. */
	restore: () => void;
	setMinimized: (minimized: boolean) => void;
	setFloatRect: (rect: MediaFloatRect) => void;
	/** Remember where an item was paused, so returning to it resumes. */
	rememberTime: (itemId: string, seconds: number) => void;
}

function persistFloatRect(rect: MediaFloatRect): void {
	window.maestro?.settings?.set('mediaPlayerFloatRect', rect);
}

/** Push an ID to the front of the history list, deduped and capped. */
function pushHistory(history: string[], itemId: string): string[] {
	return [itemId, ...history.filter((id) => id !== itemId)].slice(0, MEDIA_HISTORY_LIMIT);
}

export const useMediaPlaybackStore = create<MediaPlaybackStoreState>()((set) => ({
	items: [],
	activeItemId: null,
	history: [],
	playing: false,
	dismissed: false,
	minimized: false,
	pendingAutoplay: false,
	toggleRequest: 0,
	resumeTimes: {},
	floatRect: null,

	openMedia: (request) =>
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
				items,
				activeItemId: id,
				history: pushHistory(state.history, id),
				// Opening is an explicit request to hear it, even if it was already
				// active and paused.
				pendingAutoplay: true,
				dismissed: false,
				// Switching items unmounts the outgoing player, which pauses it. Only
				// one element is ever mounted, so overlapping audio is structurally
				// impossible rather than something we have to remember to prevent.
				...(state.activeItemId === id ? {} : { playing: false }),
			};
		}),

	setActiveItem: (itemId, opts) =>
		set((state) => {
			if (!state.items.some((item) => item.id === itemId)) return state;
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
				history: pushHistory(state.history, itemId),
				playing: false,
				dismissed: false,
				pendingAutoplay: autoplay,
			};
		}),

	setPlaying: (playing) => set((state) => (state.playing === playing ? state : { playing })),

	consumeAutoplay: () =>
		set((state) => (state.pendingAutoplay ? { pendingAutoplay: false } : state)),

	requestToggle: () => set((state) => ({ toggleRequest: state.toggleRequest + 1 })),

	closeItem: (itemId) =>
		set((state) => {
			if (!state.items.some((item) => item.id === itemId)) return state;
			const items = state.items.filter((item) => item.id !== itemId);
			const resumeTimes = { ...state.resumeTimes };
			delete resumeTimes[itemId];

			return {
				items,
				resumeTimes,
				history: state.history.filter((id) => id !== itemId),
				// Closing the playing item releases the player rather than
				// auto-advancing: closing is "stop", not "skip".
				...(state.activeItemId === itemId
					? { activeItemId: null, playing: false, pendingAutoplay: false }
					: {}),
			};
		}),

	dismiss: () => set((state) => (state.dismissed ? state : { dismissed: true })),

	restore: () => set((state) => (state.dismissed ? { dismissed: false } : state)),

	setMinimized: (minimized) =>
		set((state) => (state.minimized === minimized ? state : { minimized })),

	setFloatRect: (rect) => {
		persistFloatRect(rect);
		set({ floatRect: rect });
	},

	rememberTime: (itemId, seconds) =>
		set((state) => ({ resumeTimes: { ...state.resumeTimes, [itemId]: seconds } })),
}));

/** Non-React access, for callers outside the component tree. */
export function getMediaPlaybackActions() {
	const state = useMediaPlaybackStore.getState();
	return {
		openMedia: state.openMedia,
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
