/**
 * Media Playback Store
 *
 * Transient state for the app's single audio/video player.
 *
 * Exactly one media file plays at a time. Several media tabs can be open, but
 * only the **active** one has a mounted player; the widget navigates between
 * them rather than stacking one control per file. Switching pauses whatever was
 * playing, which is what keeps two audio streams from ever overlapping.
 *
 * The player has two placements, both driven from here:
 *  - **Docked** - the owning tab is on screen, so the player fills the
 *    `MediaViewportSlot` that `FilePreview` renders in place of its content.
 *  - **Floating** - the owning tab is not on screen, so the player becomes a
 *    draggable, resizable now-playing widget that survives switching tabs and
 *    agents.
 *
 * Why the element cannot live in FilePreview: `MainPanelContent` renders it only
 * for the active file tab of the active session, so switching tabs or agents
 * unmounts it, and removing a media element from the document runs the HTML
 * spec's internal pause steps. The element therefore lives in
 * `MediaPlaybackHost`, mounted once in `App.tsx`; this store is how the in-tab
 * slot and that host talk to each other.
 *
 * Only the float geometry persists (via settings). Which file was playing does
 * not survive a restart, and `maestro-media://` stream URLs are re-minted per
 * boot anyway.
 *
 * Multi-window note: each renderer holds its own copy of this store. On a build
 * with multiple windows, two windows each showing a media tab would each mount a
 * player. Single-window builds cannot hit this.
 */

import { create } from 'zustand';

/** Viewport rect (CSS pixels, viewport-relative) of a media tab's docked slot. */
export interface MediaSlotRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** Position and size of the floating widget. */
export interface MediaFloatRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

export interface MediaSlotState {
	/**
	 * Last known rect of the in-tab slot. Retained even while hidden so a docked
	 * player keeps non-zero dimensions - a zero-sized video can get its decode
	 * pipeline torn down, the same failure `visibility: hidden` (rather than
	 * unmounting) exists to avoid for terminals and browser tabs.
	 */
	rect: MediaSlotRect;
	/** Whether the owning tab is currently on screen. */
	visible: boolean;
}

interface MediaPlaybackStoreState {
	/** File tab whose player is mounted. Null when no media is loaded. */
	activeTabId: string | null;
	/** Whether the active player is currently playing. */
	playing: boolean;
	/**
	 * User closed the floating widget. Playback continues - dismissing hides a
	 * control, it does not stop media. Cleared by opening a media file or by the
	 * "Show Floating Media Player" command.
	 */
	dismissed: boolean;
	/** Floating widget collapsed to a compact pill. */
	minimized: boolean;
	/** One-shot: start playing once the active file is ready. */
	pendingAutoplay: boolean;
	/**
	 * Incremented to ask the player to toggle play/pause. A nonce rather than a
	 * function in state, so the minimized pill's button can drive the element
	 * without anyone holding a ref across the floating frame boundary.
	 */
	toggleRequest: number;
	/** File tab ID -> where to park a docked player. */
	slots: Record<string, MediaSlotState>;
	/** File tab ID -> last playback position, so navigating back resumes. */
	resumeTimes: Record<string, number>;
	/** Floating widget geometry. Null until the user moves or resizes it. */
	floatRect: MediaFloatRect | null;

	/**
	 * Make a tab the active player, un-dismissing the widget.
	 *
	 * @param tabId - Media file tab to activate.
	 * @param opts.autoplay - Start playing when ready. Set when the user opened
	 *   the file or navigated here with the widget's own controls.
	 */
	setActiveTab: (tabId: string, opts?: { autoplay?: boolean }) => void;
	setPlaying: (playing: boolean) => void;
	/** Consume the one-shot autoplay request. */
	consumeAutoplay: () => void;
	/** Ask the active player to toggle play/pause. */
	requestToggle: () => void;
	/** Publish the docked slot rect and mark the tab visible. */
	setSlotRect: (tabId: string, rect: MediaSlotRect) => void;
	/** Mark a slot off screen, keeping its last rect. */
	hideSlot: (tabId: string) => void;
	/** Drop everything for a tab. Called when the tab itself goes away. */
	clearTab: (tabId: string) => void;
	/** Hide the floating widget without stopping playback. */
	dismiss: () => void;
	/** Bring the floating widget back. */
	restore: () => void;
	setMinimized: (minimized: boolean) => void;
	setFloatRect: (rect: MediaFloatRect) => void;
	/** Remember where a tab was paused, so returning to it resumes. */
	rememberTime: (tabId: string, seconds: number) => void;
}

function persistFloatRect(rect: MediaFloatRect): void {
	window.maestro?.settings?.set('mediaPlayerFloatRect', rect);
}

export const useMediaPlaybackStore = create<MediaPlaybackStoreState>()((set) => ({
	activeTabId: null,
	playing: false,
	dismissed: false,
	minimized: false,
	pendingAutoplay: false,
	toggleRequest: 0,
	slots: {},
	resumeTimes: {},
	floatRect: null,

	setActiveTab: (tabId, opts) =>
		set((state) => {
			const autoplay = opts?.autoplay ?? false;
			if (state.activeTabId === tabId) {
				// Already active. Still honor a fresh autoplay request (re-opening a
				// paused file should play it) and un-dismiss, but do not restart.
				if (!autoplay && !state.dismissed) return state;
				return {
					dismissed: false,
					pendingAutoplay: state.pendingAutoplay || autoplay,
				};
			}
			// Switching files: the outgoing player unmounts, which pauses it. Only
			// one media element is ever mounted, so overlapping audio is structurally
			// impossible rather than something we have to remember to prevent.
			return {
				activeTabId: tabId,
				playing: false,
				dismissed: false,
				pendingAutoplay: autoplay,
			};
		}),

	setPlaying: (playing) => set((state) => (state.playing === playing ? state : { playing })),

	consumeAutoplay: () =>
		set((state) => (state.pendingAutoplay ? { pendingAutoplay: false } : state)),

	requestToggle: () => set((state) => ({ toggleRequest: state.toggleRequest + 1 })),

	setSlotRect: (tabId, rect) =>
		set((state) => {
			const prev = state.slots[tabId];
			if (
				prev?.visible &&
				prev.rect.top === rect.top &&
				prev.rect.left === rect.left &&
				prev.rect.width === rect.width &&
				prev.rect.height === rect.height
			) {
				// Identical rect: bail out so ResizeObserver churn does not re-render
				// the host and with it the media element.
				return state;
			}
			return { slots: { ...state.slots, [tabId]: { rect, visible: true } } };
		}),

	hideSlot: (tabId) =>
		set((state) => {
			const prev = state.slots[tabId];
			if (!prev || !prev.visible) return state;
			return { slots: { ...state.slots, [tabId]: { ...prev, visible: false } } };
		}),

	clearTab: (tabId) =>
		set((state) => {
			const hasSlot = state.slots[tabId] !== undefined;
			const hasTime = state.resumeTimes[tabId] !== undefined;
			const isActive = state.activeTabId === tabId;
			if (!hasSlot && !hasTime && !isActive) return state;

			const slots = { ...state.slots };
			const resumeTimes = { ...state.resumeTimes };
			delete slots[tabId];
			delete resumeTimes[tabId];

			return {
				slots,
				resumeTimes,
				// Closing the playing tab releases the player. The host picks a
				// remaining media tab on its next pass if there is one.
				...(isActive ? { activeTabId: null, playing: false, pendingAutoplay: false } : {}),
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

	rememberTime: (tabId, seconds) =>
		set((state) => ({ resumeTimes: { ...state.resumeTimes, [tabId]: seconds } })),
}));

/** Non-React access, for callers outside the component tree. */
export function getMediaPlaybackActions() {
	const state = useMediaPlaybackStore.getState();
	return {
		setActiveTab: state.setActiveTab,
		setPlaying: state.setPlaying,
		dismiss: state.dismiss,
		restore: state.restore,
		clearTab: state.clearTab,
	};
}

/** Whether a floating widget could be restored right now. */
export function selectCanRestoreFloatingPlayer(state: MediaPlaybackStoreState): boolean {
	return state.dismissed && state.activeTabId !== null;
}
