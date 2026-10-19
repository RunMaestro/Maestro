/**
 * TabWindowTerminals - the terminal tabs of a tab window (Tab Windows, D5).
 *
 * The PTY lives in the main process and never moves. This window mounts its
 * own `TerminalView` on the same process ids, in attach mode: the owner window
 * still spawns each PTY and handles its exit (D1). Keystrokes and resizes go
 * straight to the PTY by process id, and output arrives on `process:data`,
 * which no agent gate filters.
 *
 * Every terminal tab of the strip stays mounted, the shown one visible, like
 * the main window's terminal panel. A view is the only place the scrollback
 * exists, so switching tabs must not unmount it.
 *
 * Scrollback crosses windows through the handoff (`services/terminalHandoff.ts`):
 * each view replays what the owner handed over when it mounts; it hands its own
 * over when its tab leaves this strip (dock) or the window unloads (closing a
 * tab window docks its tabs).
 */

import { useCallback, useMemo, useRef } from 'react';
import { TerminalView } from '../TerminalView';
import { useSurfaceTypography } from '../../hooks/ui/useSurfaceTypography';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { releaseRegisteredTerminalViews } from '../../services/terminalHandoff';
import type { Session, TerminalTab, Theme } from '../../types';
import type { TabWindowTabRef } from '../../../shared/tabWindowTypes';

export interface TabWindowTerminalsProps {
	theme: Theme;
	session: Session;
	/** This window's tabs, in its own strip order. */
	tabRefs: TabWindowTabRef[];
	/** The terminal tab shown now, or null when the shown tab is not a terminal. */
	shownTabId: string | null;
}

/** The owner patches tab state in; this view only reads it. */
const ignoreTabChange = () => {};

export function TabWindowTerminals({
	theme,
	session,
	tabRefs,
	shownTabId,
}: TabWindowTerminalsProps) {
	const terminal = useSurfaceTypography('terminal');

	// Only this strip's terminals, so a frozen tab of the owner never mounts here.
	const terminalTabs = useMemo<TerminalTab[]>(() => {
		const byId = new Map((session.terminalTabs ?? []).map((tab) => [tab.id, tab]));
		return tabRefs.flatMap((ref) => {
			const tab = ref.type === 'terminal' ? byId.get(ref.id) : undefined;
			return tab ? [tab] : [];
		});
	}, [session.terminalTabs, tabRefs]);
	const viewSession = useMemo<Session>(
		() => ({ ...session, terminalTabs, activeTerminalTabId: shownTabId }),
		[session, terminalTabs, shownTabId]
	);

	// A view whose tab left this strip is moving back to the owner: hand its
	// scrollback over. Read at unmount, so it sees the strip as it is then.
	const tabRefsRef = useRef(tabRefs);
	tabRefsRef.current = tabRefs;
	const releaseTabOnUnmount = useCallback(
		(tabId: string) =>
			!tabRefsRef.current.some((ref) => ref.type === 'terminal' && ref.id === tabId),
		[]
	);

	// Closing this window docks every tab while nothing unmounts.
	useEventListener('beforeunload', releaseRegisteredTerminalViews);

	if (terminalTabs.length === 0) return null;
	const shown = shownTabId !== null && terminalTabs.some((tab) => tab.id === shownTabId);

	return (
		<div
			className="absolute inset-0 flex flex-col"
			data-testid="tab-window-terminals"
			style={{ visibility: shown ? 'visible' : 'hidden', zIndex: shown ? 1 : -1 }}
		>
			<TerminalView
				session={viewSession}
				theme={theme}
				fontFamily={terminal.fontFamily}
				fontSize={terminal.fontSize}
				onTabStateChange={ignoreTabChange}
				onTabPidChange={ignoreTabChange}
				isVisible={shown}
				attachOnly
				releaseTabOnUnmount={releaseTabOnUnmount}
			/>
		</div>
	);
}
