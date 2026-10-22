import { memo, useCallback, useEffect } from 'react';

import { MediaViewer } from '../FilePreview/MediaViewer';
import { stepMediaItem, type MediaItem } from '../../utils/mediaItems';
import { useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
import type { Theme } from '../../types';

interface ActiveMediaPlayerProps {
	/** The loaded item (`selectActiveMediaItem`). */
	item: MediaItem;
	/** Measured height of the transport strip, for whoever sizes the frame. */
	onTransportHeightChange?: (height: number) => void;
	theme: Theme;
}

/**
 * The one media element and its wiring to the media store.
 *
 * Both owners of the element render this: `MediaPlaybackHost` inside the
 * in-app floating player (the browser build), and `MediaPlayerWidget` inside
 * the media widget window (the desktop app). Only one of them exists in a
 * given client, so there is still exactly one element app-wide. The element
 * REPORTS (`setPlaying`, `rememberTime`, `advanceAfterEnded`, ...) are made
 * here and nowhere else, which is what lets the replica window forward only
 * commands.
 *
 * Callers must render it at one fixed place in their tree: removing a media
 * element from the document runs the HTML spec's internal pause steps.
 */
export const ActiveMediaPlayer = memo(function ActiveMediaPlayer({
	item,
	onTransportHeightChange,
	theme,
}: ActiveMediaPlayerProps) {
	const items = useMediaPlaybackStore((s) => s.items);
	const activeItemId = useMediaPlaybackStore((s) => s.activeItemId);
	const pendingAutoplay = useMediaPlaybackStore((s) => s.pendingAutoplay);
	const toggleRequest = useMediaPlaybackStore((s) => s.toggleRequest);
	const resumeTimes = useMediaPlaybackStore((s) => s.resumeTimes);
	const setActiveItem = useMediaPlaybackStore((s) => s.setActiveItem);
	const setPlaying = useMediaPlaybackStore((s) => s.setPlaying);
	const consumeAutoplay = useMediaPlaybackStore((s) => s.consumeAutoplay);
	const rememberTime = useMediaPlaybackStore((s) => s.rememberTime);
	const advanceAfterEnded = useMediaPlaybackStore((s) => s.advanceAfterEnded);
	const rememberAspect = useMediaPlaybackStore((s) => s.rememberAspect);
	const rememberDuration = useMediaPlaybackStore((s) => s.rememberDuration);

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

	return (
		<MediaViewer
			// Keyed on the item so switching files gets a fresh element rather than a
			// reused one carrying the previous file's state.
			key={item.id}
			kind={item.kind}
			name={item.name}
			path={item.path}
			autoplay={item.id === activeItemId && pendingAutoplay}
			resumeTime={resumeTimes[item.id] ?? 0}
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
			onTransportHeightChange={onTransportHeightChange}
			onPrev={stepMediaItem(items, activeItemId, -1) ? () => navigate(-1) : undefined}
			onNext={stepMediaItem(items, activeItemId, 1) ? () => navigate(1) : undefined}
			toggleRequest={toggleRequest}
			theme={theme}
		/>
	);
});
