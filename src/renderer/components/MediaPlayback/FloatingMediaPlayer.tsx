import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
	FileAudio,
	FileVideo,
	GripVertical,
	History,
	Minus,
	Pause,
	Play,
	Square,
	X,
} from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { ModalResizeGrip } from '../ui/ModalResizeGrip';
import { MediaHistoryMenu } from './MediaHistoryMenu';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useMediaPlaybackStore, type MediaFloatRect } from '../../stores/mediaPlaybackStore';
import { resolveMediaHistory } from '../../utils/mediaItems';
import {
	MEDIA_FLOAT_DEFAULT_SIZE,
	clampMediaFloatRect,
	initialMediaFloatRect,
} from '../../utils/mediaFloatGeometry';
import type { MediaKind } from '../../../shared/mediaTypes';
import type { Theme } from '../../types';

interface FloatingMediaPlayerProps {
	/** File name with extension, shown in the title bar. */
	title: string;
	/** Agent the file was opened from, so the widget says where it came from. */
	subtitle: string;
	kind: MediaKind;
	/** Whether the media is playing, for the minimized pill's button. */
	playing: boolean;
	/** The player. Kept mounted while minimized so playback continues. */
	children: ReactNode;
	theme: Theme;
}

/** Height of the collapsed pill; the player is clipped but still mounted. */
const PILL_HEIGHT = 40;
/** Movement below this is a click, not a drag, so a shaky hand still clicks. */
const DRAG_SLOP_PX = 4;
/**
 * Below modals (9999) and Center Flash (100001) so the widget can never cover an
 * overlay, but above the main panel content it floats over.
 */
const FLOAT_Z_INDEX = 60;

/** Current viewport, read at call time so a resize is always measured fresh. */
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

const clampToViewport = (rect: MediaFloatRect): MediaFloatRect =>
	clampMediaFloatRect(rect, viewport());

/**
 * The media player: a draggable, resizable now-playing widget.
 *
 * This is the only surface media appears on. Opening an audio or video file
 * does not create a tab or take over the main panel, so the widget floats over
 * whatever the user is actually working on and follows them across agents and
 * tabs. It can be dragged anywhere on screen, collapsed to a pill, or hidden.
 *
 * There is only ever one, because only one media file plays at a time - the
 * transport's prev/next step through the queue instead of spawning a second
 * widget, and the history menu jumps to anything played earlier.
 *
 * Hiding it does not stop playback: hiding a control should not have the side
 * effect of stopping media. It comes back by opening a media file or via the
 * "Show Floating Media Player" command. The transport's own controls are what
 * actually pause.
 */
export const FloatingMediaPlayer = memo(function FloatingMediaPlayer({
	title,
	subtitle,
	kind,
	playing,
	children,
	theme,
}: FloatingMediaPlayerProps) {
	const storedRect = useMediaPlaybackStore((s) => s.floatRect);
	const setFloatRect = useMediaPlaybackStore((s) => s.setFloatRect);
	const minimized = useMediaPlaybackStore((s) => s.minimized);
	const setMinimized = useMediaPlaybackStore((s) => s.setMinimized);
	const dismiss = useMediaPlaybackStore((s) => s.dismiss);
	const requestToggle = useMediaPlaybackStore((s) => s.requestToggle);
	const items = useMediaPlaybackStore((s) => s.items);
	const history = useMediaPlaybackStore((s) => s.history);
	const activeItemId = useMediaPlaybackStore((s) => s.activeItemId);
	const setActiveItem = useMediaPlaybackStore((s) => s.setActiveItem);
	const closeItem = useMediaPlaybackStore((s) => s.closeItem);

	// Live geometry. Seeded from the persisted rect, or parked bottom-right.
	const [rect, setRect] = useState<MediaFloatRect>(() =>
		storedRect ? clampToViewport(storedRect) : initialMediaFloatRect(kind, viewport())
	);

	const historyButtonRef = useRef<HTMLButtonElement>(null);
	const historyMenuRef = useRef<HTMLDivElement>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const historyEntries = useMemo(() => resolveMediaHistory(items, history), [items, history]);

	// Drag/resize bookkeeping. Held in a ref so the window-level listeners stay
	// stable and never re-subscribe mid-gesture.
	const gestureRef = useRef<{
		mode: 'move' | 'resize';
		startX: number;
		startY: number;
		origin: MediaFloatRect;
	} | null>(null);
	const [gesturing, setGesturing] = useState(false);

	const beginMove = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			gestureRef.current = { mode: 'move', startX: e.clientX, startY: e.clientY, origin: rect };
			setGesturing(true);
		},
		[rect]
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
					clampToViewport({
						...gesture.origin,
						left: gesture.origin.left + dx,
						top: gesture.origin.top + dy,
					})
				);
			} else {
				setRect(
					clampToViewport({
						...gesture.origin,
						width: gesture.origin.width + dx,
						height: gesture.origin.height + dy,
					})
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
			setFloatRect(rect);
		},
		{ enabled: gesturing }
	);

	// A window resize can leave the widget partly or wholly off screen.
	useEventListener('resize', () => setRect((prev) => clampToViewport(prev)));

	// Close the history menu on any outside click. Both the button and the
	// portaled list count as inside - the list is not a DOM descendant.
	useEventListener(
		'mousedown',
		(e) => {
			const target = e.target as Node;
			if (historyMenuRef.current?.contains(target) || historyButtonRef.current?.contains(target)) {
				return;
			}
			setHistoryOpen(false);
		},
		{ enabled: historyOpen }
	);

	// Adopt a size that suits the media kind when switching between an audio file
	// and a video one, but never override a size the user chose themselves.
	useEffect(() => {
		if (storedRect) return;
		const size = MEDIA_FLOAT_DEFAULT_SIZE[kind];
		setRect((prev) => clampToViewport({ ...prev, width: size.width, height: size.height }));
	}, [kind, storedRect]);

	const KindIcon = kind === 'video' ? FileVideo : FileAudio;
	const height = minimized ? PILL_HEIGHT : rect.height;

	return (
		<div
			data-testid="floating-media-player"
			className="fixed flex flex-col rounded-lg shadow-2xl border overflow-hidden select-none"
			style={{
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height,
				zIndex: FLOAT_Z_INDEX,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{/* Title bar doubles as the drag handle */}
			<div
				className="shrink-0 flex items-center gap-1.5 pl-1 pr-2 h-10 border-b"
				style={{
					borderColor: minimized ? 'transparent' : theme.colors.border,
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
					{!minimized && (
						<span
							className="text-[10px] truncate max-w-full"
							style={{ color: theme.colors.textDim }}
						>
							{subtitle}
						</span>
					)}
				</div>

				{/* Minimized keeps a play/pause on the pill, since the transport is
				    clipped out of view. */}
				{minimized && (
					<GhostIconButton
						onClick={requestToggle}
						onMouseDown={(e) => e.stopPropagation()}
						title={playing ? 'Pause' : 'Play'}
						ariaLabel={playing ? 'Pause' : 'Play'}
						color={theme.colors.textMain}
					>
						{playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
					</GhostIconButton>
				)}

				{/* Jump to anything played earlier. Prev/next only walk the queue in
				    open order, and with no tabs this is the only way back to a file
				    that is neither adjacent nor loaded. */}
				<GhostIconButton
					ref={historyButtonRef}
					onClick={() => setHistoryOpen((open) => !open)}
					onMouseDown={(e) => e.stopPropagation()}
					title="Recently played"
					ariaLabel="Recently played"
					color={historyOpen ? theme.colors.accent : theme.colors.textDim}
				>
					<History className="w-3.5 h-3.5" />
				</GhostIconButton>

				<GhostIconButton
					onClick={() => setMinimized(!minimized)}
					onMouseDown={(e) => e.stopPropagation()}
					title={minimized ? 'Expand' : 'Minimize'}
					ariaLabel={minimized ? 'Expand player' : 'Minimize player'}
					color={theme.colors.textDim}
				>
					{minimized ? <Square className="w-3 h-3" /> : <Minus className="w-3.5 h-3.5" />}
				</GhostIconButton>

				<GhostIconButton
					onClick={dismiss}
					onMouseDown={(e) => e.stopPropagation()}
					title="Hide player (keeps playing)"
					ariaLabel="Hide player"
					color={theme.colors.textDim}
				>
					<X className="w-3.5 h-3.5" />
				</GhostIconButton>
			</div>

			{historyOpen && (
				<MediaHistoryMenu
					anchorRef={historyButtonRef}
					menuRef={historyMenuRef}
					entries={historyEntries}
					activeItemId={activeItemId}
					onSelect={(itemId) => {
						setActiveItem(itemId, { autoplay: true });
						setHistoryOpen(false);
					}}
					onRemove={closeItem}
					theme={theme}
				/>
			)}

			{/* The player stays mounted while minimized - unmounting it would pause
			    the media, which is the whole thing this component exists to avoid. */}
			<div className={`flex-1 min-h-0 ${minimized ? 'hidden' : ''}`}>{children}</div>

			{!minimized && (
				<ModalResizeGrip
					theme={theme}
					onResizeStart={beginResize}
					onReset={() => {
						const size = MEDIA_FLOAT_DEFAULT_SIZE[kind];
						setRect((prev) => clampToViewport({ ...prev, ...size }));
					}}
					canReset
				/>
			)}
		</div>
	);
});
