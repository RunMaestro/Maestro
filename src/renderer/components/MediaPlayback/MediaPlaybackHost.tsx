import { memo, useEffect, useState } from 'react';

import { ActiveMediaPlayer } from './ActiveMediaPlayer';
import { FloatingMediaPlayer } from './FloatingMediaPlayer';
import { useEventListener } from '../../hooks/utils/useEventListener';
import {
	flushMediaQueuePersist,
	selectActiveMediaItem,
	useMediaPlaybackStore,
} from '../../stores/mediaPlaybackStore';
import { installMediaPlaybackReplica } from '../../stores/mediaPlaybackReplica';
import { floatingWidgetsAvailable } from '../../utils/floatingWidgetMode';
import type { Theme } from '../../types';

interface MediaPlaybackHostProps {
	theme: Theme;
}

/**
 * App-level owner of the one audio/video element.
 *
 * Mounted exactly once, near the root, and never unmounted. Media does not get
 * a file preview tab, a main panel view, or any other placement: opening an
 * audio or video file shows the floating player and nothing else. That is both
 * a product decision (a podcast should not cost the user their workspace) and a
 * technical one - anything rendered per-tab or per-agent is torn down on every
 * switch, and removing a media element from the document runs the HTML spec's
 * internal pause steps, killing playback.
 *
 * Exactly one player exists at a time, which makes overlapping audio
 * structurally impossible instead of a rule to enforce. Which file it holds
 * follows the user: opening one activates it, the transport's prev/next step
 * through the queue in open order, and the history menu jumps by recency.
 *
 * In the desktop app (`floatingWidgetsAvailable()`) that one element lives in
 * the media widget window (`floatingWidget/MediaPlayerWidget.tsx`), and this
 * window's store becomes its replica: this host installs the replica and draws
 * nothing. The widget window mounts `FloatingWidgetRoot`, never this host, so
 * the element cannot appear twice. The browser build keeps the element here.
 */
export const MediaPlaybackHost = memo(function MediaPlaybackHost({
	theme,
}: MediaPlaybackHostProps) {
	// Constant for the life of the window, so the branch never swaps trees.
	if (floatingWidgetsAvailable()) return <MediaPlaybackReplica />;
	return <InAppMediaPlayer theme={theme} />;
});

/** Forwards this window's media commands to the widget window. Draws nothing. */
function MediaPlaybackReplica() {
	useEffect(() => installMediaPlaybackReplica(), []);
	return null;
}

/** The browser build's player: the element inside the in-app floating frame. */
function InAppMediaPlayer({ theme }: MediaPlaybackHostProps) {
	const active = useMediaPlaybackStore(selectActiveMediaItem);
	const dismissed = useMediaPlaybackStore((s) => s.dismissed);
	const aspects = useMediaPlaybackStore((s) => s.aspects);

	// One measurement for the whole app: the transport is the same strip whatever
	// is loaded, so re-measuring per file would only re-report the same number.
	const [transportHeight, setTransportHeight] = useState<number | null>(null);

	// Queue writes are debounced, so a window closing mid-debounce would lose the
	// last position (or the last thing queued). Flush before it goes away.
	useEventListener('beforeunload', flushMediaQueuePersist);

	if (!active) return null;

	// ONE render path, minimized or not. Branching here - a bare wrapper div when
	// minimized, the frame otherwise - put the media element at a different
	// position in the React tree, so toggling minimize unmounted and remounted
	// it. Removing a media element from the document runs the HTML spec's
	// internal pause steps, which is exactly how minimizing ended up silently
	// stopping playback. The frame hides itself instead.
	return (
		<FloatingMediaPlayer
			title={active.name}
			subtitle={active.sessionName}
			kind={active.kind}
			aspect={aspects[active.id]}
			transportHeight={transportHeight}
			hidden={dismissed}
			theme={theme}
		>
			<ActiveMediaPlayer item={active} onTransportHeightChange={setTransportHeight} theme={theme} />
		</FloatingMediaPlayer>
	);
}
