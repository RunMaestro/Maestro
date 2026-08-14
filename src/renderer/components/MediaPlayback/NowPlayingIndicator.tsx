import { memo } from 'react';
import { Maximize2, Pause, Play } from 'lucide-react';

import {
	selectActiveMediaItem,
	selectCanRestoreFloatingPlayer,
	useMediaPlaybackStore,
} from '../../stores/mediaPlaybackStore';
import type { Theme } from '../../types';

interface NowPlayingIndicatorProps {
	theme: Theme;
	/**
	 * Drop the filename, for a Left Bar with no room for it - the collapsed
	 * rail, or an expanded sidebar too narrow to take a label without pushing
	 * the hamburger off the edge. Both buttons still render: they are the only
	 * controls a minimized player has.
	 */
	compact?: boolean;
}

/**
 * The minimized media player: a play/pause button in the Left Bar header.
 *
 * Minimizing the floating widget parks it here rather than stopping it, so this
 * is both the "Maestro is the thing making noise" indicator and the transport
 * for it. The icon is the current state's *action*, the way a media control
 * always is: a pause glyph while it plays, a play glyph while it is paused.
 *
 * The restore button next to it is what brings the widget back, and it is
 * deliberately separate rather than sharing the click - a single control that
 * both toggled playback and reopened a window would do one of them by accident
 * every time. It renders in compact mode too: a narrow sidebar must not be the
 * one place with no way back to the player.
 *
 * Shown only while the player is minimized (with the widget on screen it would
 * be a second copy of its own transport), and it disappears when the player is
 * closed or the queue empties.
 */
export const NowPlayingIndicator = memo(function NowPlayingIndicator({
	theme,
	compact = false,
}: NowPlayingIndicatorProps) {
	const minimized = useMediaPlaybackStore(selectCanRestoreFloatingPlayer);
	const active = useMediaPlaybackStore(selectActiveMediaItem);
	const playing = useMediaPlaybackStore((s) => s.playing);
	const restore = useMediaPlaybackStore((s) => s.restore);
	const requestToggle = useMediaPlaybackStore((s) => s.requestToggle);

	if (!minimized || !active) return null;

	// One bordered pill with a divider between the halves, so the two buttons
	// read as the minimized player rather than as unrelated header icons that
	// happen to sit together. Never shrinks: the header row neither wraps nor
	// scrolls, so these controls must not be what gets squeezed - the wordmark
	// is the row's shrink target.
	return (
		<div
			data-testid="now-playing-indicator"
			className="flex items-stretch shrink-0 rounded border overflow-hidden"
			style={{ borderColor: theme.colors.border }}
		>
			<button
				type="button"
				data-testid="now-playing-toggle"
				onClick={requestToggle}
				className={`flex items-center gap-1 text-[10px] font-bold transition-colors hover:bg-white/10 ${
					compact ? 'px-1 py-1' : 'pl-1.5 pr-1.5 py-0.5'
				}`}
				style={{ color: playing ? theme.colors.accent : theme.colors.textDim }}
				title={`${active.name} - click to ${playing ? 'pause' : 'play'}`}
				aria-label={playing ? `Pause ${active.name}` : `Play ${active.name}`}
			>
				{playing ? <Pause className="w-3 h-3 shrink-0" /> : <Play className="w-3 h-3 shrink-0" />}
				{!compact && <span className="max-w-[7rem] truncate font-normal">{active.name}</span>}
			</button>

			{/* The divider is what makes the pill read as two controls rather than
			    one wide button, so a click lands where the user meant. */}
			<div className="w-px shrink-0" style={{ backgroundColor: theme.colors.border }} aria-hidden />

			<button
				type="button"
				data-testid="now-playing-restore"
				onClick={restore}
				className="px-1 transition-colors hover:bg-white/10"
				style={{ color: theme.colors.textDim }}
				title="Show the media player"
				aria-label="Show the media player"
			>
				<Maximize2 className="w-3 h-3 shrink-0" />
			</button>
		</div>
	);
});
