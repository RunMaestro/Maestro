import { memo, useCallback, useEffect, useMemo } from 'react';

import { MediaViewer } from '../FilePreview/MediaViewer';
import { FloatingMediaPlayer } from './FloatingMediaPlayer';
import { collectMediaTabs, getMediaTabLabel, stepMediaTab } from '../../utils/mediaTabs';
import { useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useTabStore } from '../../stores/tabStore';
import { fileTabFocusFields } from '../../utils/tabHelpers';
import type { Theme } from '../../types';

interface MediaPlaybackHostProps {
	theme: Theme;
}

/**
 * App-level owner of the one audio/video element.
 *
 * Mounted exactly once, near the root, and never unmounted. `MainPanelContent`
 * renders `FilePreview` only for the active file tab of the active session, so a
 * player living inside the tab would be torn down the moment the user looked
 * elsewhere - and removing a media element from the document runs the HTML
 * spec's internal pause steps, killing playback. Hosting it here is what lets a
 * podcast keep playing while the user works in other tabs and agents.
 *
 * Exactly one player exists at a time, which makes overlapping audio structurally
 * impossible instead of a rule to enforce. It renders in one of two placements:
 *
 *  - **Docked** over the `MediaViewportSlot` that `FilePreview` renders in place
 *    of its content, when the owning tab is on screen.
 *  - **Floating** as a draggable now-playing widget, when it is not.
 *
 * Which file is active follows the user: opening one activates it, viewing a
 * media tab claims it (see `MediaViewportSlot`), and the widget's prev/next step
 * through the open media tabs.
 */
export const MediaPlaybackHost = memo(function MediaPlaybackHost({
	theme,
}: MediaPlaybackHostProps) {
	const sessions = useSessionStore((s) => s.sessions);
	const setSessions = useSessionStore((s) => s.setSessions);
	const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
	const clearAutoplayFlag = useTabStore((s) => s.clearFileTabAutoplayMedia);

	const activeTabId = useMediaPlaybackStore((s) => s.activeTabId);
	const playing = useMediaPlaybackStore((s) => s.playing);
	const dismissed = useMediaPlaybackStore((s) => s.dismissed);
	const pendingAutoplay = useMediaPlaybackStore((s) => s.pendingAutoplay);
	const toggleRequest = useMediaPlaybackStore((s) => s.toggleRequest);
	const slots = useMediaPlaybackStore((s) => s.slots);
	const resumeTimes = useMediaPlaybackStore((s) => s.resumeTimes);
	const setActiveTab = useMediaPlaybackStore((s) => s.setActiveTab);
	const setPlaying = useMediaPlaybackStore((s) => s.setPlaying);
	const consumeAutoplay = useMediaPlaybackStore((s) => s.consumeAutoplay);
	const clearTab = useMediaPlaybackStore((s) => s.clearTab);
	const rememberTime = useMediaPlaybackStore((s) => s.rememberTime);

	const mediaTabs = useMemo(() => collectMediaTabs(sessions), [sessions]);
	const active = activeTabId ? mediaTabs.find((t) => t.tabId === activeTabId) : undefined;

	// Release the player when its tab closes. Guards the palette and the widget
	// against pointing at a tab that no longer exists.
	useEffect(() => {
		if (activeTabId && !mediaTabs.some((t) => t.tabId === activeTabId)) clearTab(activeTabId);
	}, [activeTabId, mediaTabs, clearTab]);

	// A freshly opened media file claims the player and starts playing. This is
	// the only place the tab-level one-shot is read, and it is cleared right after
	// so no later re-render can replay a file the user has since paused.
	useEffect(() => {
		const opened = mediaTabs.find((t) => t.autoplay);
		if (!opened) return;
		setActiveTab(opened.tabId, { autoplay: true });
		clearAutoplayFlag(opened.tabId);
	}, [mediaTabs, setActiveTab, clearAutoplayFlag]);

	const navigate = useCallback(
		(steps: number) => {
			const target = stepMediaTab(mediaTabs, activeTabId, steps);
			// Navigating with the transport means "play this now", matching what the
			// buttons look like they do.
			if (target) setActiveTab(target.tabId, { autoplay: true });
		},
		[mediaTabs, activeTabId, setActiveTab]
	);

	/** Focus the active file's tab, which re-docks the player into it. */
	const returnToTab = useCallback(() => {
		if (!active) return;
		setSessions((prev) =>
			prev.map((s) =>
				s.id === active.sessionId ? { ...s, ...fileTabFocusFields(active.tabId) } : s
			)
		);
		setActiveSessionId(active.sessionId);
	}, [active, setSessions, setActiveSessionId]);

	const handleTimeUpdate = useCallback(
		(seconds: number) => {
			if (activeTabId) rememberTime(activeTabId, seconds);
		},
		[activeTabId, rememberTime]
	);

	// Hand the one-shot back to the store once the player has it. In an effect,
	// not inline: a set during render is a React violation.
	useEffect(() => {
		if (pendingAutoplay) consumeAutoplay();
	}, [pendingAutoplay, consumeAutoplay]);

	if (!active) return null;

	const slot = slots[active.tabId];
	const docked = slot?.visible ?? false;
	const autoplay = active.autoplay || pendingAutoplay;

	const player = (
		<MediaViewer
			// Keyed on the tab so switching files gets a fresh element rather than a
			// reused one carrying the previous file's state.
			key={active.tabId}
			kind={active.kind}
			name={getMediaTabLabel(active)}
			path={active.path}
			autoplay={autoplay}
			resumeTime={resumeTimes[active.tabId] ?? 0}
			compact={!docked}
			onTimeUpdate={handleTimeUpdate}
			onPlayingChange={setPlaying}
			onPrev={stepMediaTab(mediaTabs, activeTabId, -1) ? () => navigate(-1) : undefined}
			onNext={stepMediaTab(mediaTabs, activeTabId, 1) ? () => navigate(1) : undefined}
			toggleRequest={toggleRequest}
			theme={theme}
		/>
	);

	if (docked) {
		return (
			<div
				data-media-frame={active.tabId}
				style={{
					position: 'fixed',
					top: slot.rect.top,
					left: slot.rect.left,
					width: slot.rect.width,
					height: slot.rect.height,
					// Above the file preview content it covers, far below modals (9999)
					// and Center Flash (100001) so it can never sit over an overlay.
					zIndex: 5,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				{player}
			</div>
		);
	}

	if (dismissed) {
		// Hidden by the user. Kept mounted and off screen so playback continues -
		// dismissing hides a control, it does not stop media. `visibility: hidden`
		// (not unmounting, not zero size) is what keeps a video's decode pipeline
		// alive, the same reason the terminal and browser tab overlays use it.
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
			title={getMediaTabLabel(active)}
			subtitle={active.sessionName}
			kind={active.kind}
			playing={playing}
			onReturnToTab={returnToTab}
			theme={theme}
		>
			{player}
		</FloatingMediaPlayer>
	);
});
