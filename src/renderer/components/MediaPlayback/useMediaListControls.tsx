import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { History, ListMusic } from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { MediaListMenu } from './MediaListMenu';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
import { upcomingMediaItems } from '../../utils/mediaItems';
import type { Theme } from '../../types';

export type MediaListKind = 'queue' | 'history';

interface MediaListControlsOptions {
	theme: Theme;
	/**
	 * Where the caret goes when a list closes from inside (pick, clear, Escape).
	 * The list takes focus on open (see `MediaListMenu`), so closing without
	 * handing it back leaves focus on `<body>`.
	 */
	returnFocusRef?: RefObject<HTMLElement | null>;
}

interface MediaListControls {
	/** The open list, or null. Escape handlers close this before anything else. */
	openList: MediaListKind | null;
	closeList: () => void;
	/** The queue and history buttons, for the player's title strip. */
	buttons: ReactNode;
	/** The open list's menu (portaled), rendered anywhere inside the player. */
	menus: ReactNode;
}

/**
 * The player's queue and history chrome, shared by the in-app floating player
 * and the media widget window so both offer the same lists with the same rules.
 *
 * Each button appears only when its list has something in it, so a single file
 * playing on its own shows neither and the title strip stays uncluttered. One
 * menu is open at a time: they hang off adjacent buttons, so two open at once
 * would overlap each other.
 */
export function useMediaListControls({
	theme,
	returnFocusRef,
}: MediaListControlsOptions): MediaListControls {
	const items = useMediaPlaybackStore((s) => s.items);
	const history = useMediaPlaybackStore((s) => s.history);
	const activeItemId = useMediaPlaybackStore((s) => s.activeItemId);
	const durations = useMediaPlaybackStore((s) => s.durations);
	const resumeTimes = useMediaPlaybackStore((s) => s.resumeTimes);
	const setActiveItem = useMediaPlaybackStore((s) => s.setActiveItem);
	const closeItem = useMediaPlaybackStore((s) => s.closeItem);
	const removeHistoryItem = useMediaPlaybackStore((s) => s.removeHistoryItem);
	const clearHistory = useMediaPlaybackStore((s) => s.clearHistory);
	const clearQueue = useMediaPlaybackStore((s) => s.clearQueue);
	const openMedia = useMediaPlaybackStore((s) => s.openMedia);

	// The queue menu lists what is coming NEXT, so the loaded track is filtered
	// out of it. It stays in `items` because that is how prev/next find their
	// place - this is a display filter only.
	const upcoming = useMemo(() => upcomingMediaItems(items, activeItemId), [items, activeItemId]);

	const [openList, setOpenList] = useState<MediaListKind | null>(null);
	const queueButtonRef = useRef<HTMLButtonElement>(null);
	const historyButtonRef = useRef<HTMLButtonElement>(null);
	const listMenuRef = useRef<HTMLDivElement>(null);

	/**
	 * Dismisses the open list and puts the caret back on the player.
	 *
	 * Handing focus back is the whole point: without it the NEXT Escape does
	 * nothing - the player is on screen, apparently ready, and swallowing the
	 * key. Deliberately not wired to the outside-click path, which closes the
	 * list precisely because the user went to click something else.
	 */
	const closeList = useCallback(() => {
		setOpenList(null);
		returnFocusRef?.current?.focus();
	}, [returnFocusRef]);

	// Close the open list on any outside click. Both buttons and the portaled
	// list count as inside - the list is not a DOM descendant.
	useEventListener(
		'mousedown',
		(e) => {
			const target = e.target as Node;
			if (
				listMenuRef.current?.contains(target) ||
				queueButtonRef.current?.contains(target) ||
				historyButtonRef.current?.contains(target)
			) {
				return;
			}
			setOpenList(null);
		},
		{ enabled: openList !== null }
	);

	const buttons = (
		<>
			{upcoming.length > 0 && (
				<GhostIconButton
					ref={queueButtonRef}
					onClick={() => setOpenList((open) => (open === 'queue' ? null : 'queue'))}
					// Stops the in-app frame's title bar from starting a drag.
					onMouseDown={(e) => e.stopPropagation()}
					title={`Play queue (${upcoming.length})`}
					ariaLabel={`Play queue, ${upcoming.length} item${upcoming.length === 1 ? '' : 's'}`}
					color={openList === 'queue' ? theme.colors.accent : theme.colors.textDim}
				>
					<ListMusic className="w-3.5 h-3.5" />
				</GhostIconButton>
			)}

			{/* Jump to anything played earlier. Prev/next only walk the queue in
			    open order, and with no tabs this is the only way back to a file
			    that is neither adjacent nor loaded. */}
			{history.length > 0 && (
				<GhostIconButton
					ref={historyButtonRef}
					onClick={() => setOpenList((open) => (open === 'history' ? null : 'history'))}
					onMouseDown={(e) => e.stopPropagation()}
					title="Recently played"
					ariaLabel="Recently played"
					color={openList === 'history' ? theme.colors.accent : theme.colors.textDim}
				>
					<History className="w-3.5 h-3.5" />
				</GhostIconButton>
			)}
		</>
	);

	const menus = (
		<>
			{openList === 'queue' && (
				<MediaListMenu
					anchorRef={queueButtonRef}
					menuRef={listMenuRef}
					title={`Play Queue (${upcoming.length})`}
					listLabel="queue"
					entries={upcoming}
					durations={durations}
					resumeTimes={resumeTimes}
					onSelect={(item) => {
						setActiveItem(item.id, { autoplay: true });
						closeList();
					}}
					onRemove={closeItem}
					onClear={() => {
						clearQueue();
						closeList();
					}}
					onClose={closeList}
					testId="media-queue-menu"
					theme={theme}
				/>
			)}

			{openList === 'history' && (
				<MediaListMenu
					anchorRef={historyButtonRef}
					menuRef={listMenuRef}
					title="Recently Played"
					listLabel="history"
					entries={history}
					durations={durations}
					resumeTimes={resumeTimes}
					// A history entry can name a file that is no longer queued (the
					// user removed it), so picking one re-queues and plays it rather
					// than activating a queue slot that may not exist.
					onSelect={(item) => {
						openMedia(item);
						closeList();
					}}
					onRemove={removeHistoryItem}
					onClear={() => {
						clearHistory();
						closeList();
					}}
					onClose={closeList}
					testId="media-history-menu"
					theme={theme}
				/>
			)}
		</>
	);

	return { openList, closeList, buttons, menus };
}
