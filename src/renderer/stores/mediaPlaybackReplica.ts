/**
 * Media Playback Replica
 *
 * While `floatingWidgetsAvailable()`, the one media element lives in the media
 * widget window, so that window's `useMediaPlaybackStore` is the AUTHORITY and
 * the primary window's copy is a REPLICA: its state is mirrored from the
 * authority, and every command called on it is forwarded there. The browser
 * build keeps today's single store with the element in the primary window.
 *
 * This header is the map of `mediaPlaybackStore.ts` the replica follows.
 *
 * (a) COMMANDS - actions any caller issues. In the replica each one is
 *     forwarded as `{ type: 'action', action, args }` and applied by calling
 *     the same action on the authority's store:
 *       - openMedia(request)              queue a file and autoplay it
 *       - enqueueMedia(requests) -> number  append without interrupting; returns
 *                                         how many were newly queued
 *       - setActiveItem(itemId, opts?)    load a queue entry (transport, menus)
 *       - requestToggle()                 bump the play/pause nonce
 *       - closeItem(itemId)               drop an entry, release the player
 *       - clearQueue()                    drop everything but the loaded item
 *       - removeHistoryItem(itemId)       drop one recently-played entry
 *       - clearHistory()                  forget recently played
 *       - dismiss()                       minimize without stopping playback
 *       - restore()                       un-minimize and bump focusRequest
 *       - openPlayer()                    palette / shortcut "Open Media Player"
 *     Item IDs are `mediaItemId(sessionId, path)`, deterministic, so forwarding
 *     a request creates the same ID the authority would.
 *
 * (b) ELEMENT REPORTS - only the player that owns the media element makes
 *     these, so they run on the authority only and are never forwarded:
 *       - setPlaying(playing)             element play/pause events
 *       - rememberTime(itemId, seconds)   several times a second while playing
 *       - rememberDuration(itemId, s)     once per load
 *       - rememberAspect(itemId, aspect)  once per video load
 *       - advanceAfterEnded()             `ended` event; calls rememberTime and
 *                                         setActiveItem itself through `get()`
 *       - consumeAutoplay()               hands the one-shot back after mount
 *       - setFloatGeometry(kind, rect)    in-app frame drag/resize (browser only)
 *       - setFloatFootprint(footprint)    in-app frame live rect (browser only)
 *     The two float actions and their fields (`floatPosition`, `floatWidths`,
 *     `floatFootprint`) belong to the in-app `FloatingMediaPlayer` frame, which
 *     only the browser build draws. The desktop window has its own bounds.
 *
 * (c) MIRRORED SNAPSHOT - the state fields a non-authority window reads:
 *       - items, activeItemId, history    queue, loaded item, recently played
 *       - playing                         Now Playing pill icon
 *       - dismissed, dormant              Now Playing pill visibility, palette
 *     Deliberately NOT mirrored:
 *       - resumeTimes, durations          only the player and its menus read
 *                                         them, and rememberTime would turn the
 *                                         relay into a several-per-second stream
 *       - aspects                         only the window that sizes the player
 *       - pendingAutoplay, toggleRequest, focusRequest  one-shots and nonces the
 *                                         element side consumes
 *       - floatPosition, floatWidths, floatFootprint    in-app frame only; the
 *                                         replica's footprint stays null so the
 *                                         toast stack never dodges a player that
 *                                         is not in this window
 *
 * (d) PERSISTENCE - who writes the settings store:
 *       - `mediaPlayerQueue`: `persistQueue()` (500 ms debounce, then
 *         `writeQueueNow()`) runs from openMedia, enqueueMedia (only when
 *         something was added), setActiveItem, closeItem, clearQueue,
 *         openPlayer, rememberTime and rememberDuration, and so indirectly from
 *         advanceAfterEnded. `flushMediaQueuePersist()` writes a pending one
 *         now; `MediaPlaybackHost` calls it on `beforeunload`.
 *       - `mediaPlayerFloatRect`: `persistFloat()` from setFloatGeometry.
 *       - Hydration is NOT an action: `settingsStore.loadAllSettings()` calls
 *         `useMediaPlaybackStore.setState` directly for both keys, and re-runs
 *         on resume and external settings edits (guarded by "store is empty").
 *         The replica must not hydrate the queue (the authority does), or it
 *         shows a dormant queue until the first snapshot lands.
 *     Only the authority may write `mediaPlayerQueue`. A replica write would
 *     race the authority's and could roll the queue back on disk.
 *
 * Renderer callers of `useMediaPlaybackStore`, by group:
 *   - components/QuickActionsModal/QuickActionsModal.tsx
 *       snapshot (selectCanOpenMediaPlayer) + command openPlayer
 *   - components/SessionList/SessionList.tsx
 *       snapshot (selectNowPlayingVisible)
 *   - components/MediaPlayback/NowPlayingIndicator.tsx
 *       snapshot (selectShowNowPlayingIndicator, selectActiveMediaItem, playing)
 *       + commands restore, requestToggle
 *   - hooks/keyboard/useMainKeyboardHandler.ts
 *       snapshot (activeItemId, items) + commands openPlayer, requestToggle,
 *       setActiveItem
 *   - hooks/tabs/internal/useFilePreviewTabHandlers.ts
 *       commands openMedia, enqueueMedia (opening a media file in the UI)
 *   - hooks/remote/useAppRemoteEventListeners.ts
 *       commands openMedia, enqueueMedia (`maestro-cli open-file [--queue]`)
 *   - components/Toast.tsx
 *       floatFootprint only (in-app frame; stays null in a replica)
 *   - stores/settingsStore.ts
 *       direct setState hydration of both persisted keys (see (d))
 *   - components/MediaPlayback/MediaPlaybackHost.tsx      -> AUTHORITY side
 *       state (items, activeItemId, dismissed, pendingAutoplay, toggleRequest,
 *       resumeTimes, aspects) + command setActiveItem (transport prev/next) +
 *       reports setPlaying, consumeAutoplay, rememberTime, advanceAfterEnded,
 *       rememberAspect, rememberDuration + flushMediaQueuePersist
 *   - components/MediaPlayback/FloatingMediaPlayer.tsx    -> AUTHORITY side
 *       state (items, history, activeItemId, durations, resumeTimes,
 *       focusRequest, floatPosition, floatWidths) + commands dismiss,
 *       setActiveItem, closeItem, clearQueue, removeHistoryItem, clearHistory,
 *       openMedia (history replay) + reports setFloatGeometry,
 *       setFloatFootprint. Its queue and history menus are the player's own
 *       chrome, so the widget window needs them too, not just `MediaViewer`.
 *   - `getMediaPlaybackActions()` in the store has no callers.
 */

import {
	MEDIA_COMMAND_ACTIONS,
	isMediaPlayerWidgetCommand,
	type MediaCommandAction,
	type MediaPlayerWidgetCommand,
	type MediaPlayerWidgetState,
} from '../../shared/floatingWidgets';
import { floatingWidgetsAvailable } from '../utils/floatingWidgetMode';
import {
	mirrorStoreState,
	onWidgetCommand,
	publishStoreState,
	sendWidgetCommand,
} from '../utils/windowStoreMirror';
import { setMediaQueuePersistEnabled, useMediaPlaybackStore } from './mediaPlaybackStore';

const WIDGET_ID = 'media-player';

type MediaPlaybackState = ReturnType<typeof useMediaPlaybackStore.getState>;
type MediaCommands = Pick<MediaPlaybackState, MediaCommandAction>;

const noop = () => {};

/**
 * The mirrored snapshot (map section (c)). The authority publishes it from its
 * store, and the replica applies it through the same pick, so a stray field in
 * a relayed payload never reaches the replica's store.
 */
export function selectMediaPlayerWidgetState(
	state: MediaPlayerWidgetState
): MediaPlayerWidgetState {
	return {
		items: state.items,
		activeItemId: state.activeItemId,
		history: state.history,
		playing: state.playing,
		dismissed: state.dismissed,
		dormant: state.dormant,
	};
}

/**
 * What a forwarded command returns to its caller. The authority answers
 * asynchronously, so only `enqueueMedia`'s count needs a stand-in: the number
 * of requests sent, which is what the callers report to the user.
 */
function forwardedResult(action: MediaCommandAction, args: unknown[]): unknown {
	if (action === 'enqueueMedia') return Array.isArray(args[0]) ? args[0].length : 0;
	return undefined;
}

/**
 * Make this window's media store a REPLICA of the media widget window's.
 *
 * Every COMMAND action is replaced by one that forwards it to the authority and
 * changes nothing here; the authority's snapshot is mirrored in; and this window
 * stops writing `mediaPlayerQueue`. A no-op outside the desktop app.
 *
 * @returns Uninstall: restores the original actions and queue persistence.
 */
export function installMediaPlaybackReplica(): () => void {
	if (!floatingWidgetsAvailable()) return noop;

	const state = useMediaPlaybackStore.getState();
	const originals = {} as Record<MediaCommandAction, unknown>;
	const forwarded = {} as Record<MediaCommandAction, unknown>;
	for (const action of MEDIA_COMMAND_ACTIONS) {
		originals[action] = state[action];
		forwarded[action] = (...args: unknown[]) => {
			const command: MediaPlayerWidgetCommand = { type: 'action', action, args };
			sendWidgetCommand(WIDGET_ID, command);
			return forwardedResult(action, args);
		};
	}

	setMediaQueuePersistEnabled(false);
	useMediaPlaybackStore.setState(forwarded as MediaCommands);
	const unmirror = mirrorStoreState<MediaPlaybackState, MediaPlayerWidgetState>(
		WIDGET_ID,
		useMediaPlaybackStore,
		selectMediaPlayerWidgetState
	);

	return () => {
		unmirror();
		useMediaPlaybackStore.setState(originals as MediaCommands);
		setMediaQueuePersistEnabled(true);
	};
}

/**
 * Make this window's media store the AUTHORITY: publish its snapshot and apply
 * every valid command a replica forwards by calling the same action here. A
 * command naming anything outside the COMMAND union is dropped. A no-op outside
 * the desktop app.
 *
 * @returns Uninstall: stops publishing and listening.
 */
export function installMediaPlaybackAuthority(): () => void {
	const unpublish = publishStoreState(
		WIDGET_ID,
		useMediaPlaybackStore,
		selectMediaPlayerWidgetState
	);
	const unlisten = onWidgetCommand<unknown>(WIDGET_ID, (command) => {
		if (!isMediaPlayerWidgetCommand(command)) return;
		const action = useMediaPlaybackStore.getState()[command.action] as (
			...args: unknown[]
		) => unknown;
		action(...command.args);
	});

	return () => {
		unpublish();
		unlisten();
	};
}
