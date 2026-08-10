import type { QuickAction } from '../types';

interface BuildMediaPlayerCommandsArgs {
	/** True when media is loaded but the user has hidden the floating widget. */
	canRestoreFloatingPlayer: boolean;
	restoreFloatingPlayer: () => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * Recovery command for a hidden media player.
 *
 * Dismissing the floating widget keeps playback going, so there has to be a way
 * back to the controls without hunting for the file's tab. Only offered when
 * there is actually something to restore, so the palette does not carry a
 * dead entry for users who never open media.
 */
export function buildMediaPlayerCommands({
	canRestoreFloatingPlayer,
	restoreFloatingPlayer,
	setQuickActionOpen,
}: BuildMediaPlayerCommandsArgs): QuickAction[] {
	if (!canRestoreFloatingPlayer) return [];

	return [
		{
			id: 'show-floating-media-player',
			label: 'Show Floating Media Player',
			subtext: 'Bring back the hidden now-playing controls',
			action: () => {
				restoreFloatingPlayer();
				setQuickActionOpen(false);
			},
		},
	];
}
