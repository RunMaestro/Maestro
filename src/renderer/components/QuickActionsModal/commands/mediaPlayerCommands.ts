import type { QuickAction } from '../types';

interface BuildMediaPlayerCommandsArgs {
	/** True when there is anything to open: a loaded item, a queue, or history. */
	canOpenMediaPlayer: boolean;
	/** Open the player on its target item (loaded item, else most recent). */
	openMediaPlayer: () => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * The one way to reach the media player from the palette.
 *
 * There used to be a second entry, "Show Floating Media Player", which appeared
 * alongside this one whenever the widget happened to be minimized. Two commands
 * a word apart, both meaning "put the player on screen", is a choice the user
 * has to stop and read - and the distinction they encoded (restore a hidden
 * widget vs. open one on a target) is internal bookkeeping, not something
 * anyone forms an intention about. `openPlayer` already covers both cases.
 */
export function buildMediaPlayerCommands({
	canOpenMediaPlayer,
	openMediaPlayer,
	setQuickActionOpen,
}: BuildMediaPlayerCommandsArgs): QuickAction[] {
	return [
		{
			id: 'open-media-player',
			label: 'Open Media Player',
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
}
