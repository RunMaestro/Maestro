/**
 * MediaPlayerWidget - the media player in its own desktop-level window.
 *
 * Unlike the gauge, this window is the AUTHORITY: it owns the one media
 * element app-wide, its `useMediaPlaybackStore` is the real store, and it
 * persists the queue. The primary window's store is a replica that mirrors the
 * snapshot published here and forwards every command it is given (see
 * `stores/mediaPlaybackReplica.ts`).
 *
 * The persisted queue hydrates through the window-settings bundle
 * `FloatingWidgetRoot` runs (`loadAllSettings`), exactly as the primary window
 * does in the browser build: back hidden, paused and dormant. The root reports
 * the window ready only after that load, so a command main held for this window
 * (the first `open-file`) lands on the hydrated queue instead of racing it.
 *
 * The window shows while there is a loaded, undismissed item and hides
 * otherwise. The X and Escape dismiss (minimize): the audio keeps going and the
 * primary window's Now Playing pill brings the window back. The stop button is
 * what releases the player.
 *
 * The window sizes itself to what it plays (a transport strip for audio, the
 * picture plus transport for video) until the user resizes it; see
 * `mediaWindowSize.ts` for when it re-sizes and when it leaves the user's size.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Copy, FileAudio, FileVideo, Square } from 'lucide-react';

import { ActiveMediaPlayer } from '../components/MediaPlayback/ActiveMediaPlayer';
import { copyMediaFileName } from '../components/MediaPlayback/copyMediaFileName';
import { useMediaListControls } from '../components/MediaPlayback/useMediaListControls';
import { GhostIconButton } from '../components/ui/GhostIconButton';
import { useEventListener } from '../hooks/utils/useEventListener';
import {
	flushMediaQueuePersist,
	selectActiveMediaItem,
	useMediaPlaybackStore,
} from '../stores/mediaPlaybackStore';
import { installMediaPlaybackAuthority } from '../stores/mediaPlaybackReplica';
import type { Theme } from '../types';
import type { MediaKind } from '../../shared/mediaTypes';
import { safeStorageGet, safeStorageSet } from '../utils/safeLocalStorage';
import { captureException } from '../utils/sentry';
import { FloatingWidgetFrame } from './FloatingWidgetFrame';
import {
	mediaWindowBaselineAfter,
	planMediaWindowSize,
	sanitizeMediaWindowBaseline,
	type MediaWindowBaseline,
} from './mediaWindowSize';

const WIDGET_ID = 'media-player';

/**
 * Where the last size the widget gave its window is kept. Per device, like the
 * window's own bounds, and across launches: without it a size the user chose
 * last session would read as "never resized" and be overwritten on the next.
 */
export const MEDIA_WINDOW_BASELINE_STORAGE_KEY = 'maestro:mediaWindowBaseline';

function readMediaWindowBaseline(): MediaWindowBaseline | null {
	const raw = safeStorageGet(MEDIA_WINDOW_BASELINE_STORAGE_KEY);
	if (!raw) return null;
	try {
		return sanitizeMediaWindowBaseline(JSON.parse(raw));
	} catch {
		// A damaged value means no baseline, which only costs one re-size.
		return null;
	}
}

function writeMediaWindowBaseline(baseline: MediaWindowBaseline | null): void {
	if (baseline) safeStorageSet(MEDIA_WINDOW_BASELINE_STORAGE_KEY, JSON.stringify(baseline));
}

/**
 * Size the window to the loaded media while the user has not resized it.
 *
 * Runs when the kind changes and when what the size is computed from arrives
 * (a video's aspect, the transport's measured height). Each pass reads the
 * window's bounds and the baseline fresh, and passes run one at a time, so a
 * pass never plans against a size an earlier pass is still setting.
 */
function useMediaWindowSizing(
	kind: MediaKind | null,
	aspect: number | undefined,
	transportHeight: number | null
): void {
	const queue = useRef<Promise<void>>(Promise.resolve());

	useEffect(() => {
		const api = window.maestro?.floatingWidgets;
		if (!kind || !api) return;
		let cancelled = false;
		const fit = { kind, aspect: kind === 'video' ? aspect : undefined, transportHeight };

		const pass = async () => {
			if (cancelled) return;
			const current = await api.getBounds(WIDGET_ID);
			// A newer fit superseded this one while the bounds were in flight.
			if (cancelled) return;
			const stored = readMediaWindowBaseline();
			const plan = planMediaWindowSize(fit, current, stored);
			if (!plan.apply) {
				if (plan.baseline !== stored) writeMediaWindowBaseline(plan.baseline);
				return;
			}
			const actual = await api.setBounds(WIDGET_ID, plan.apply);
			writeMediaWindowBaseline(mediaWindowBaselineAfter(kind, plan.apply, actual));
		};
		// A failed pass is reported, not left to break the chain: the next fit
		// still gets its turn.
		queue.current = queue.current.then(pass).catch((error) => {
			captureException(error, { extra: { action: 'media-window-size' } });
		});

		return () => {
			cancelled = true;
		};
	}, [kind, aspect, transportHeight]);
}

interface MediaPlayerWidgetProps {
	theme: Theme;
}

export const MediaPlayerWidget = memo(function MediaPlayerWidget({
	theme,
}: MediaPlayerWidgetProps) {
	const active = useMediaPlaybackStore(selectActiveMediaItem);
	const dismissed = useMediaPlaybackStore((s) => s.dismissed);
	const dismiss = useMediaPlaybackStore((s) => s.dismiss);
	const closeItem = useMediaPlaybackStore((s) => s.closeItem);
	const aspect = useMediaPlaybackStore((s) =>
		s.activeItemId ? s.aspects[s.activeItemId] : undefined
	);

	// The transport is the same strip whatever is loaded, so one measurement
	// serves every file (the in-app player does the same).
	const [transportHeight, setTransportHeight] = useState<number | null>(null);

	useEffect(() => installMediaPlaybackAuthority(), []);

	useMediaWindowSizing(active?.kind ?? null, aspect, transportHeight);

	// Queue writes are debounced, so a window closing mid-debounce would lose the
	// last position (or the last thing queued). Flush before it goes away.
	useEventListener('beforeunload', flushMediaQueuePersist);

	const visible = active !== null && !dismissed;
	useEffect(() => {
		const api = window.maestro?.floatingWidgets;
		if (!api) return;
		void (visible ? api.show(WIDGET_ID) : api.hide(WIDGET_ID));
	}, [visible]);

	const {
		openList,
		closeList,
		buttons: listButtons,
		menus: listMenus,
	} = useMediaListControls({
		theme,
	});

	// Escape (and the X) close the innermost thing first: an open list, then the
	// player, which minimizes rather than stops so a reflexive key never kills
	// playback. A fullscreen video is already using Escape to leave fullscreen.
	const handleClose = useCallback(() => {
		if (document.fullscreenElement) return;
		if (openList) closeList();
		else dismiss();
	}, [openList, closeList, dismiss]);

	if (!active) return null;

	const KindIcon = active.kind === 'video' ? FileVideo : FileAudio;

	return (
		<FloatingWidgetFrame
			theme={theme}
			icon={<KindIcon className="w-3.5 h-3.5" />}
			title={active.name}
			subtitle={active.sessionName}
			onClose={handleClose}
			closeLabel="Minimize player (keeps playing)"
			actions={
				<>
					<GhostIconButton
						onClick={() => void copyMediaFileName(active.name)}
						title="Copy file name"
						ariaLabel="Copy file name"
						color={theme.colors.textDim}
						testId="media-copy-name"
					>
						<Copy className="w-3.5 h-3.5" />
					</GhostIconButton>
					{listButtons}
					<GhostIconButton
						onClick={() => closeItem(active.id)}
						title="Close player (stops playback)"
						ariaLabel="Close player and stop playback"
						color={theme.colors.textDim}
						testId="media-stop"
					>
						<Square className="w-3.5 h-3.5" />
					</GhostIconButton>
				</>
			}
		>
			<div data-testid="media-player-widget" className="flex-1 min-h-0">
				<ActiveMediaPlayer
					item={active}
					onTransportHeightChange={setTransportHeight}
					theme={theme}
				/>
			</div>
			{listMenus}
		</FloatingWidgetFrame>
	);
});
