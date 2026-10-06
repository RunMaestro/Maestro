import type { Session } from '../../../types';
import type { QuickAction } from '../types';
import type { WindowMoveTarget } from '../../../utils/windowTargets';

interface BuildWindowCommandsArgs {
	activeSession: Session | undefined;
	/**
	 * Windows the active agent can move into, already labeled and owner-flagged by
	 * `buildWindowMoveTargets`. Empty in a single-window app (registry not
	 * hydrated), which suppresses all move-to-window commands.
	 */
	windowTargets: WindowMoveTarget[];
	moveToNewWindow: (sessionId: string) => void | Promise<void>;
	moveToWindow: (sessionId: string, targetWindowId: string) => void | Promise<void>;
	setQuickActionOpen: (open: boolean) => void;
	/**
	 * True only when the palette is running in a SECONDARY window (Cmd+K outside
	 * the main window). Gates the "Rename This Window" command - the primary keeps
	 * its stable "Main Window" label and is never renamed from the palette.
	 */
	canRenameCurrentWindow?: boolean;
	/**
	 * Begin inline-renaming THIS window in the palette (seeds + shows the rename
	 * input; does NOT close the palette - the modal treats this command like a mode
	 * switch). Required for the rename command to appear.
	 */
	beginRenameCurrentWindow?: () => void;
}

/**
 * Cmd+K palette commands for the multi-window feature: rename the current window
 * (secondary windows only), and move the active agent between windows (detach
 * into a new window, or move into any existing window - "Move Agent to Main
 * Window" doubles as "bring back to the primary"). Mirrors the Left Bar's
 * Move-to-Window submenu so both surfaces stay in lockstep. Labels contain
 * "Window" / "Move Agent" / "Rename" so keyword search surfaces them.
 *
 * Returns `[]` when nothing applies (no rename affordance AND no active agent /
 * no enumerated windows), so a single-window app shows no window commands.
 */
export function buildWindowCommands({
	activeSession,
	windowTargets,
	moveToNewWindow,
	moveToWindow,
	setQuickActionOpen,
	canRenameCurrentWindow,
	beginRenameCurrentWindow,
}: BuildWindowCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [];

	// Rename This Window - only in a secondary window. Listed first so it is easy
	// to reach. Its action opens the inline rename input and must NOT close the
	// palette, so it does not call setQuickActionOpen (the modal keeps it open).
	if (canRenameCurrentWindow && beginRenameCurrentWindow) {
		commands.push({
			id: 'rename-current-window',
			label: 'Rename This Window',
			action: () => beginRenameCurrentWindow(),
		});
	}

	// Move commands need an active agent to move and at least one window to enumerate.
	if (activeSession && windowTargets.length > 0) {
		const sessionId = activeSession.id;
		commands.push({
			id: 'move-to-new-window',
			label: `Move Agent to New Window: ${activeSession.name}`,
			action: () => {
				void moveToNewWindow(sessionId);
				setQuickActionOpen(false);
			},
		});

		for (const target of windowTargets) {
			// The window that already surfaces the agent is not a move destination.
			if (target.isCurrentOwner) continue;
			commands.push({
				id: `move-to-window-${target.windowId}`,
				label: `Move Agent to ${target.label}`,
				action: () => {
					void moveToWindow(sessionId, target.windowId);
					setQuickActionOpen(false);
				},
			});
		}
	}

	return commands;
}
