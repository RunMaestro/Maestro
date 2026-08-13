import { memo } from 'react';
import { Music } from 'lucide-react';

import {
	selectActiveMediaItem,
	selectCanRestoreFloatingPlayer,
	useMediaPlaybackStore,
} from '../../stores/mediaPlaybackStore';
import type { Theme } from '../../types';

interface NowPlayingIndicatorProps {
	theme: Theme;
	/**
	 * Icon-only, for a Left Bar with no room for a label - the collapsed rail,
	 * or an expanded sidebar too narrow to take a filename without pushing the
	 * hamburger off the edge.
	 */
	compact?: boolean;
}

/**
 * "Maestro is the thing making noise" - the Left Bar's stand-in for the hidden
 * floating player.
 *
 * Hiding the player does not stop playback, which without this leaves audio
 * coming from nowhere and no obvious way back: the widget is gone, and the only
 * route to it is a command palette entry the user has to know about. So the
 * moment the player is hidden with something loaded, its file name shows up
 * here, and one click brings the widget back.
 *
 * It appears only while the player is hidden - with the widget on screen it
 * would just be a second copy of the same information - and it disappears with
 * the last queue entry.
 */
export const NowPlayingIndicator = memo(function NowPlayingIndicator({
	theme,
	compact = false,
}: NowPlayingIndicatorProps) {
	const hidden = useMediaPlaybackStore(selectCanRestoreFloatingPlayer);
	const active = useMediaPlaybackStore(selectActiveMediaItem);
	const playing = useMediaPlaybackStore((s) => s.playing);
	const restore = useMediaPlaybackStore((s) => s.restore);

	if (!hidden || !active) return null;

	return (
		<button
			type="button"
			data-testid="now-playing-indicator"
			onClick={restore}
			// `shrink-0` on the icon and a capped, truncating label: the header row
			// neither wraps nor scrolls, so this pill must never be the thing that
			// pushes the hamburger menu off the edge.
			className={`flex items-center gap-1 shrink-0 rounded text-[10px] font-bold transition-colors hover:bg-white/10 ${
				compact ? 'p-1' : 'px-1.5 py-0.5'
			}`}
			style={{ color: playing ? theme.colors.accent : theme.colors.textDim }}
			title={`${playing ? 'Playing' : 'Paused'}: ${active.name} - click to show the player`}
			aria-label={`${playing ? 'Playing' : 'Paused'} ${active.name}. Show the media player`}
		>
			{/* Animated only while it is actually making sound, so the pill reads as
			    a live indicator rather than a permanent button. */}
			<Music className={`w-3 h-3 shrink-0${playing ? ' animate-pulse' : ''}`} />
			{!compact && <span className="max-w-[7rem] truncate font-normal">{active.name}</span>}
		</button>
	);
});
