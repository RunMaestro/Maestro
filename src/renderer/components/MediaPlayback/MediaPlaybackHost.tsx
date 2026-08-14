import { memo, useCallback, useEffect, useState } from 'react';

import { MediaViewer } from '../FilePreview/MediaViewer';
import { FloatingMediaPlayer } from './FloatingMediaPlayer';
import { stepMediaItem } from '../../utils/mediaItems';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { flushMediaQueuePersist, useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
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
 */
export const MediaPlaybackHost = memo(function MediaPlaybackHost({
	theme,
}: MediaPlaybackHostProps) {
	const items = useMediaPlaybackStore((s) => s.items);
	const activeItemId = useMediaPlaybackStore((s) => s.activeItemId);
	const dismissed = useMediaPlaybackStore((s) => s.dismissed);
	const pendingAutoplay = useMediaPlaybackStore((s) => s.pendingAutoplay);
	const toggleRequest = useMediaPlaybackStore((s) => s.toggleRequest);
	const resumeTimes = useMediaPlaybackStore((s) => s.resumeTimes);
	const setActiveItem = useMediaPlaybackStore((s) => s.setActiveItem);
	const setPlaying = useMediaPlaybackStore((s) => s.setPlaying);
	const consumeAutoplay = useMediaPlaybackStore((s) => s.consumeAutoplay);
	const rememberTime = useMediaPlaybackStore((s) => s.rememberTime);
	const advanceAfterEnded = useMediaPlaybackStore((s) => s.advanceAfterEnded);
	const aspects = useMediaPlaybackStore((s) => s.aspects);
	const rememberAspect = useMediaPlaybackStore((s) => s.rememberAspect);
	const rememberDuration = useMediaPlaybackStore((s) => s.rememberDuration);

	// One measurement for the whole app: the transport is the same strip whatever
	// is loaded, so re-measuring per file would only re-report the same number.
	const [transportHeight, setTransportHeight] = useState<number | null>(null);

	// Queue writes are debounced, so a window closing mid-debounce would lose the
	// last position (or the last thing queued). Flush before it goes away.
	useEventListener('beforeunload', flushMediaQueuePersist);

	const active = activeItemId ? items.find((item) => item.id === activeItemId) : undefined;

	const navigate = useCallback(
		(steps: number) => {
			const target = stepMediaItem(items, activeItemId, steps);
			// Navigating with the transport means "play this now", matching what the
			// buttons look like they do.
			if (target) setActiveItem(target.id, { autoplay: true });
		},
		[items, activeItemId, setActiveItem]
	);

	const handleTimeUpdate = useCallback(
		(seconds: number) => {
			if (activeItemId) rememberTime(activeItemId, seconds);
		},
		[activeItemId, rememberTime]
	);

	const handleAspectChange = useCallback(
		(aspect: number) => {
			if (activeItemId) rememberAspect(activeItemId, aspect);
		},
		[activeItemId, rememberAspect]
	);

	const handleDurationKnown = useCallback(
		(seconds: number) => {
			if (activeItemId) rememberDuration(activeItemId, seconds);
		},
		[activeItemId, rememberDuration]
	);

	// Hand the one-shot back to the store once the player has it. In an effect,
	// not inline: a set during render is a React violation.
	useEffect(() => {
		if (pendingAutoplay) consumeAutoplay();
	}, [pendingAutoplay, consumeAutoplay]);

	if (!active) return null;

	const player = (
		<MediaViewer
			// Keyed on the item so switching files gets a fresh element rather than a
			// reused one carrying the previous file's state.
			key={active.id}
			kind={active.kind}
			name={active.name}
			path={active.path}
			autoplay={active.id === activeItemId && pendingAutoplay}
			resumeTime={resumeTimes[active.id] ?? 0}
			compact
			onTimeUpdate={handleTimeUpdate}
			onPlayingChange={setPlaying}
			// A finished file hands off to the next queued one, which is what makes
			// "queue an mp4 behind this mp3" mean anything.
			onEnded={advanceAfterEnded}
			// The frame sizes itself to the file, so it needs the file's own shape
			// and the true height of the controls under it.
			onAspectChange={handleAspectChange}
			// Only the loaded file is ever mounted, so this is the one chance to
			// learn how long it is for the queue and history lists.
			onDurationKnown={handleDurationKnown}
			onTransportHeightChange={setTransportHeight}
			onPrev={stepMediaItem(items, activeItemId, -1) ? () => navigate(-1) : undefined}
			onNext={stepMediaItem(items, activeItemId, 1) ? () => navigate(1) : undefined}
			toggleRequest={toggleRequest}
			theme={theme}
		/>
	);

	if (dismissed) {
		// Minimized to the Left Bar. Kept mounted and off screen so playback
		// continues - minimizing is not stopping, and the header pill drives this
		// same element. `visibility: hidden` (not unmounting, not zero size) is
		// what keeps a video's decode pipeline alive, the same reason the terminal
		// and browser tab overlays use it.
		return (
			<div
				data-testid="media-player-hidden"
				style={{
					position: 'fixed',
					top: 0,
					left: 0,
					width: 480,
					height: 270,
					visibility: 'hidden',
					pointerEvents: 'none',
					zIndex: -1,
				}}
			>
				{player}
			</div>
		);
	}

	return (
		<FloatingMediaPlayer
			title={active.name}
			subtitle={active.sessionName}
			kind={active.kind}
			aspect={aspects[active.id]}
			transportHeight={transportHeight}
			theme={theme}
		>
			{player}
		</FloatingMediaPlayer>
	);
});
