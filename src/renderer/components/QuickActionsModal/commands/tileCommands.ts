import type { Session } from '../../../types';
import type { QuickAction } from '../types';
import { isWebDesktop } from '../../../utils/runtimeContext';
import { tileNewTabInSession } from '../../../services/tileNewTabAction';
import { canTileNewTab, type TileableTabKind } from '../../../hooks/tabs/tileNewTab';

interface BuildTileCommandsArgs {
	activeSession: Session | undefined;
	setQuickActionOpen: (open: boolean) => void;
	/** Hotkeys to show on the rows that have one. Only the terminal kind does. */
	shortcuts?: {
		tileTerminalBelow?: QuickAction['shortcut'];
	};
}

/**
 * The tile-below family, in the order they read in the palette. Every label
 * starts with "Tile" so typing `tile` surfaces the whole set at once (the
 * palette filters on a plain substring of the label and sorts alphabetically,
 * so the shared prefix is what clusters them).
 */
const TILE_KINDS: ReadonlyArray<{ kind: TileableTabKind; label: string; subtext: string }> = [
	{
		kind: 'ai',
		label: 'Tile New AI Chat Below',
		subtext: 'Split the current view and open a new AI chat in the bottom half',
	},
	{
		kind: 'browser',
		label: 'Tile New Browser Below',
		subtext: 'Split the current view and open a new browser tab in the bottom half',
	},
	{
		kind: 'file',
		label: 'Tile New File Below',
		subtext: 'Split the current view and open a new file tab in the bottom half',
	},
	{
		kind: 'terminal',
		label: 'Tile New Terminal Below',
		subtext: 'Split the current view and open a new terminal in the bottom half',
	},
];

/**
 * Commands that create a tab AND tile it under the current view in one step,
 * so a user never has to open a tab and then drag it into place. The work is
 * done by {@link tileNewTab}, which reuses the same layout primitives as the
 * drag-to-tile path.
 *
 * Emitted only when there is a tab on screen to split against - with no tabs at
 * all these would just be slower versions of the New Tab commands.
 */
export function buildTileCommands({
	activeSession,
	setQuickActionOpen,
	shortcuts,
}: BuildTileCommandsArgs): QuickAction[] {
	if (!canTileNewTab(activeSession) || !activeSession) return [];
	const sessionId = activeSession.id;

	return TILE_KINDS.filter(
		// Browser tabs need the Electron <webview>, which is inert in the
		// web-desktop bundle; tiling one there would place an empty pane.
		({ kind }) => kind !== 'browser' || !isWebDesktop()
	).map(({ kind, label, subtext }) => ({
		id: `tileBelow:${kind}`,
		label,
		subtext,
		shortcut: kind === 'terminal' ? shortcuts?.tileTerminalBelow : undefined,
		action: () => {
			setQuickActionOpen(false);
			tileNewTabInSession(sessionId, kind);
		},
	}));
}
