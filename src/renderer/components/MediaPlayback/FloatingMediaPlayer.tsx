import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileAudio, FileVideo, GripVertical, History, ListMusic, Minus, X } from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { ModalResizeGrip } from '../ui/ModalResizeGrip';
import { MediaListMenu } from './MediaListMenu';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
import {
	DEFAULT_MEDIA_ASPECT,
	MEDIA_FLOAT_DEFAULT_WIDTH,
	fitMediaFloatRect,
	initialMediaFloatRect,
	mediaFloatChromeHeight,
	mediaFloatResizeWidth,
	mediaFloatWidthFor,
	type MediaFloatFit,
	type MediaFloatRect,
} from '../../utils/mediaFloatGeometry';
import { upcomingMediaItems } from '../../utils/mediaItems';
import type { MediaKind } from '../../../shared/mediaTypes';
import type { Theme } from '../../types';

interface FloatingMediaPlayerProps {
	/** File name with extension, shown in the title bar. */
	title: string;
	/** Agent the file was opened from, so the widget says where it came from. */
	subtitle: string;
	kind: MediaKind;
	/**
	 * Picture aspect ratio of the loaded file, once its metadata says. The frame
	 * is sized to it, so a 4:3 recording and a vertical phone clip each get a box
	 * that fits instead of black bars. Ignored for audio.
	 */
	aspect?: number;
	/**
	 * Measured height of the transport inside `children`. The frame's height is
	 * chrome plus picture, and the chrome depends on font metrics, so it is
	 * measured rather than assumed.
	 */
	transportHeight?: number | null;
	/**
	 * Minimized to the Left Bar: the frame hides itself instead of being
	 * unmounted by the caller.
	 *
	 * This is a style flag rather than a `return null`, and that is load-bearing.
	 * The caller renders this component in exactly one place either way, so the
	 * media element keeps its position in the React tree; swapping to a different
	 * wrapper would unmount it, and removing a media element from the document
	 * runs the HTML spec's internal pause steps - silently stopping the audio
	 * that minimizing is supposed to preserve.
	 */
	hidden?: boolean;
	/**
	 * The player. Stays mounted while minimized - unmounting it would pause the
	 * media, which is the whole thing this component exists to avoid.
	 */
	children: ReactNode;
	theme: Theme;
}

/** Movement below this is a click, not a drag, so a shaky hand still clicks. */
const DRAG_SLOP_PX = 4;
/**
 * Below modals (9999) and Center Flash (100001) so the widget can never cover an
 * overlay, but above the main panel content it floats over.
 */
const FLOAT_Z_INDEX = 60;

/** Current viewport, read at call time so a resize is always measured fresh. */
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

/**
 * The media player: a draggable, resizable now-playing widget.
 *
 * This is the only surface media appears on. Opening an audio or video file
 * does not create a tab or take over the main panel, so the widget floats over
 * whatever the user is actually working on and follows them across agents and
 * tabs. It can be dragged anywhere on screen, or minimized to the Left Bar.
 *
 * There is only ever one, because only one media file plays at a time - the
 * transport's prev/next step through the queue instead of spawning a second
 * widget, and the history menu jumps to anything played earlier.
 *
 * **Minimize and close mean different things.** Minimizing parks the widget in
 * the Left Bar header and the audio keeps going, because hiding a control
 * should not have the side effect of stopping media; the header pill becomes
 * the play/pause button and brings the widget back. Closing releases the player
 * outright and the sound stops, which is what a close button has to do or the
 * user is left with audio coming from nowhere.
 *
 * The frame is sized to whatever is loaded rather than to a remembered box: an
 * audio file collapses it to the controls, and a video expands it to that
 * video's own aspect ratio. So a queue that alternates between the two reshapes
 * as it advances, and never plays a movie inside black bars or leaves dead
 * space under a podcast. Only the width is the user's to choose, and it is
 * remembered per kind.
 */
export const FloatingMediaPlayer = memo(function FloatingMediaPlayer({
	title,
	subtitle,
	kind,
	aspect = DEFAULT_MEDIA_ASPECT,
	transportHeight,
	hidden = false,
	children,
	theme,
}: FloatingMediaPlayerProps) {
	const storedPosition = useMediaPlaybackStore((s) => s.floatPosition);
	const storedWidths = useMediaPlaybackStore((s) => s.floatWidths);
	const setFloatGeometry = useMediaPlaybackStore((s) => s.setFloatGeometry);
	const dismiss = useMediaPlaybackStore((s) => s.dismiss);
	const items = useMediaPlaybackStore((s) => s.items);
	const history = useMediaPlaybackStore((s) => s.history);
	const activeItemId = useMediaPlaybackStore((s) => s.activeItemId);
	const durations = useMediaPlaybackStore((s) => s.durations);
	const resumeTimes = useMediaPlaybackStore((s) => s.resumeTimes);
	const setActiveItem = useMediaPlaybackStore((s) => s.setActiveItem);
	const closeItem = useMediaPlaybackStore((s) => s.closeItem);

	// The queue menu lists what is coming NEXT, so the loaded track is filtered
	// out of it. It stays in `items` because that is how prev/next find their
	// place - this is a display filter only.
	const upcoming = useMemo(() => upcomingMediaItems(items, activeItemId), [items, activeItemId]);

	// Everything that decides the frame's height. Held in a ref too, so the
	// window-level drag handlers can read it without re-subscribing.
	const fit: MediaFloatFit = useMemo(
		() => ({ kind, aspect, chromeHeight: mediaFloatChromeHeight(transportHeight) }),
		[kind, aspect, transportHeight]
	);
	const fitRef = useRef(fit);
	fitRef.current = fit;

	// Live geometry. Seeded from the remembered position and this kind's width,
	// or parked bottom-right at the kind's default.
	const [rect, setRect] = useState<MediaFloatRect>(() => {
		const initial = initialMediaFloatRect(fit, viewport());
		if (!storedPosition) return initial;
		return fitMediaFloatRect(
			{ ...storedPosition, width: mediaFloatWidthFor(kind, storedWidths) },
			fit,
			viewport()
		);
	});

	const removeHistoryItem = useMediaPlaybackStore((s) => s.removeHistoryItem);
	const clearHistory = useMediaPlaybackStore((s) => s.clearHistory);
	const clearQueue = useMediaPlaybackStore((s) => s.clearQueue);
	const openMedia = useMediaPlaybackStore((s) => s.openMedia);

	// One menu is open at a time: they hang off adjacent buttons, so two open at
	// once would overlap each other.
	const [openList, setOpenList] = useState<'queue' | 'history' | null>(null);
	const queueButtonRef = useRef<HTMLButtonElement>(null);
	const historyButtonRef = useRef<HTMLButtonElement>(null);
	const listMenuRef = useRef<HTMLDivElement>(null);

	// Drag/resize bookkeeping. Held in a ref so the window-level listeners stay
	// stable and never re-subscribe mid-gesture.
	const gestureRef = useRef<{
		mode: 'move' | 'resize';
		startX: number;
		startY: number;
		origin: MediaFloatRect;
	} | null>(null);
	const [gesturing, setGesturing] = useState(false);

	const frameRef = useRef<HTMLDivElement>(null);

	const beginMove = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			// `preventDefault` suppresses the click's own focus, so claim it here
			// instead. Without this, grabbing the title bar leaves focus wherever it
			// was and Escape would go to the surface behind the player the user is
			// currently holding onto.
			frameRef.current?.focus();
			gestureRef.current = { mode: 'move', startX: e.clientX, startY: e.clientY, origin: rect };
			setGesturing(true);
		},
		[rect]
	);

	/**
	 * Escape minimizes, matching every other dismissible surface in the app -
	 * except that for this one "dismiss" has to mean MINIMIZE, never close. The
	 * player is the one surface whose close button stops something the user is
	 * listening to, and a reflexive Escape must not be able to kill playback.
	 *
	 * Scoped to the widget rather than registered with the layer stack: the
	 * player is not modal, it floats over a workspace the user keeps typing in,
	 * so Escape belongs to it only while focus is actually inside it.
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
			// A fullscreen video is already using Escape to come back out of
			// fullscreen; minimizing on the way would hide the player the user was
			// only trying to un-maximize.
			if (document.fullscreenElement) return;
			// An open list is the innermost thing Escape can close, so it goes first.
			if (openList) {
				setOpenList(null);
			} else {
				dismiss();
			}
			e.preventDefault();
			e.stopPropagation();
		},
		[openList, dismiss]
	);

	const beginResize = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			gestureRef.current = { mode: 'resize', startX: e.clientX, startY: e.clientY, origin: rect };
			setGesturing(true);
		},
		[rect]
	);

	// Window-scoped so a fast drag that outruns the cursor does not drop the
	// gesture, which is what happens with element-scoped mousemove.
	useEventListener(
		'mousemove',
		(event) => {
			const gesture = gestureRef.current;
			if (!gesture) return;
			const e = event as MouseEvent;
			const dx = e.clientX - gesture.startX;
			const dy = e.clientY - gesture.startY;
			if (gesture.mode === 'move') {
				// Below the slop threshold this is still a click, so leave the widget
				// exactly where it was rather than nudging it by a pixel.
				if (Math.abs(dx) + Math.abs(dy) <= DRAG_SLOP_PX) return;
				setRect(
					fitMediaFloatRect(
						{
							width: gesture.origin.width,
							left: gesture.origin.left + dx,
							top: gesture.origin.top + dy,
						},
						fitRef.current,
						viewport()
					)
				);
			} else {
				// Only the width is dragged; the height follows the media. The grip is
				// a corner, so a downward drag still grows a video - whichever axis
				// moved further sets the width.
				setRect(
					fitMediaFloatRect(
						{
							top: gesture.origin.top,
							left: gesture.origin.left,
							width: mediaFloatResizeWidth(gesture.origin, { dx, dy }, fitRef.current),
						},
						fitRef.current,
						viewport()
					)
				);
			}
		},
		{ enabled: gesturing }
	);

	useEventListener(
		'mouseup',
		() => {
			if (!gestureRef.current) return;
			gestureRef.current = null;
			setGesturing(false);
			// Persist only on release, so a drag is one settings write, not hundreds.
			// The width is stored against this kind: a movie's width would be absurd
			// on the next podcast.
			setFloatGeometry(kind, { top: rect.top, left: rect.left, width: rect.width });
		},
		{ enabled: gesturing }
	);

	// A window resize can leave the widget partly or wholly off screen.
	useEventListener('resize', () =>
		setRect((prev) => fitMediaFloatRect(prev, fitRef.current, viewport()))
	);

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

	// Reshape for whatever is loaded now. A queue that alternates between a
	// podcast and a screen recording steps between a control strip and a picture
	// frame as it advances, at each kind's own width, without the user touching
	// anything. Position is left alone: the widget should not wander.
	useEffect(() => {
		setRect((prev) =>
			fitMediaFloatRect(
				{ top: prev.top, left: prev.left, width: mediaFloatWidthFor(kind, storedWidths) },
				fit,
				viewport()
			)
		);
	}, [fit, kind, storedWidths]);

	const KindIcon = kind === 'video' ? FileVideo : FileAudio;

	return (
		<div
			ref={frameRef}
			data-testid="floating-media-player"
			// Minimized keeps the frame mounted and merely invisible. `visibility:
			// hidden` (not unmounting, not zero size) is what keeps a video's decode
			// pipeline alive - the same reason the terminal and browser tab overlays
			// use it - and `aria-hidden` keeps the off-screen controls out of the
			// accessibility tree while the header pill stands in for them.
			aria-hidden={hidden || undefined}
			// Focusable but not in the tab order: the widget floats over a workspace
			// the user is typing in, so it must never steal a Tab. -1 is enough to
			// hold focus after a click, which is what scopes Escape to it.
			tabIndex={-1}
			onKeyDown={handleKeyDown}
			className="fixed flex flex-col rounded-lg shadow-2xl border overflow-hidden select-none outline-none"
			style={{
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height,
				zIndex: hidden ? -1 : FLOAT_Z_INDEX,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				visibility: hidden ? 'hidden' : undefined,
				pointerEvents: hidden ? 'none' : undefined,
			}}
		>
			{/* Title bar doubles as the drag handle */}
			<div
				className="shrink-0 flex items-center gap-1.5 pl-1 pr-2 h-10 border-b"
				style={{
					borderColor: theme.colors.border,
					cursor: gesturing ? 'grabbing' : 'grab',
				}}
				onMouseDown={beginMove}
				title="Drag to move"
			>
				{/* Explicit grip, so the widget looks movable instead of making the user
				    discover it. The whole bar drags; this is the affordance. */}
				<GripVertical
					className="w-3.5 h-4 shrink-0 opacity-60"
					style={{ color: theme.colors.textDim }}
					aria-hidden
				/>
				<KindIcon className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />

				{/* Drags with the bar rather than being an interactive target: there is
				    no tab to jump to, so the title is just a label on the handle. */}
				<div className="flex flex-col items-start min-w-0 flex-1" title={title}>
					<span
						className="text-xs font-medium truncate max-w-full"
						style={{ color: theme.colors.textMain }}
					>
						{title}
					</span>
					<span className="text-[10px] truncate max-w-full" style={{ color: theme.colors.textDim }}>
						{subtitle}
					</span>
				</div>

				{/* Queue and history. Each button appears only when its list has
				    something in it, so a single file playing on its own shows neither
				    and the title bar stays uncluttered. */}
				{upcoming.length > 0 && (
					<GhostIconButton
						ref={queueButtonRef}
						onClick={() => setOpenList((open) => (open === 'queue' ? null : 'queue'))}
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

				{/* Minimize and close are deliberately different: minimizing parks the
				    player in the Left Bar header and the audio keeps going, closing
				    stops it. Hiding a control should not silently stop media, and a
				    close button that only hid it would leave sound coming from
				    nowhere. */}
				<GhostIconButton
					onClick={dismiss}
					onMouseDown={(e) => e.stopPropagation()}
					title="Minimize to the Left Bar (keeps playing)"
					ariaLabel="Minimize player to the Left Bar"
					color={theme.colors.textDim}
				>
					<Minus className="w-3.5 h-3.5" />
				</GhostIconButton>

				<GhostIconButton
					onClick={() => activeItemId && closeItem(activeItemId)}
					onMouseDown={(e) => e.stopPropagation()}
					title="Close player (stops playback)"
					ariaLabel="Close player and stop playback"
					color={theme.colors.textDim}
				>
					<X className="w-3.5 h-3.5" />
				</GhostIconButton>
			</div>

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
						setOpenList(null);
					}}
					onRemove={closeItem}
					onClear={() => {
						clearQueue();
						setOpenList(null);
					}}
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
						setOpenList(null);
					}}
					onRemove={removeHistoryItem}
					onClear={() => {
						clearHistory();
						setOpenList(null);
					}}
					testId="media-history-menu"
					theme={theme}
				/>
			)}

			<div className="flex-1 min-h-0">{children}</div>

			<ModalResizeGrip
				theme={theme}
				onResizeStart={beginResize}
				onReset={() => {
					const width = MEDIA_FLOAT_DEFAULT_WIDTH[kind];
					setRect((prev) => fitMediaFloatRect({ ...prev, width }, fit, viewport()));
					setFloatGeometry(kind, { top: rect.top, left: rect.left, width });
				}}
				canReset
			/>
		</div>
	);
});
