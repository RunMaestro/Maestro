import type { QuickAction } from '../types';

interface BuildMediaPlayerCommandsArgs {
	/** True when media is loaded but the user has hidden the floating widget. */
	canRestoreFloatingPlayer: boolean;
	restoreFloatingPlayer: () => void;
	/** True when there is anything to open: a loaded item, a queue, or history. */
	canOpenMediaPlayer: boolean;
	/** Open the player on its target item (loaded item, else most recent). */
	openMediaPlayer: () => void;
	openMediaPlayerShortcut?: QuickAction['shortcut'];
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
	canOpenMediaPlayer,
	openMediaPlayer,
	openMediaPlayerShortcut,
	setQuickActionOpen,
}: BuildMediaPlayerCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [
		{
			id: 'open-media-player',
			label: 'Open Media Player',
			shortcut: openMediaPlayerShortcut,
			// Listed even when there is nothing to play. Hiding a command is how a
			// user concludes a feature does not exist; a subtext that says why it
			// will not do anything is strictly more useful than an empty palette.
			subtext: canOpenMediaPlayer
				? 'Show the floating player and its queue'
				: 'Nothing has been played yet',
			action: () => {
				if (canOpenMediaPlayer) openMediaPlayer();
				setQuickActionOpen(false);
			},
		},
	];

	if (!canRestoreFloatingPlayer) return commands;

	commands.push({
		id: 'show-floating-media-player',
		label: 'Show Floating Media Player',
		subtext: 'Bring back the hidden now-playing controls',
		action: () => {
			restoreFloatingPlayer();
			setQuickActionOpen(false);
		},
	});

	return commands;
}
