import { useCallback } from 'react';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import { useTabStore } from '../../../stores/tabStore';
import { getTerminalSessionId } from '../../../utils/terminalTabHelpers';
import { closeTerminalTabWithConfirm } from '../../../services/tabCloseConfirm';
import type { TerminalTabHandlersReturn } from './types';

export function useTerminalTabHandlers(): TerminalTabHandlersReturn {
	const { createTerminalTab, closeTerminalTab, selectTerminalTab, renameTerminalTab } =
		useTabStore();

	const handleOpenTerminalTab = useCallback(
		(options?: { shell?: string; cwd?: string; name?: string | null }) => {
			createTerminalTab(options);
		},
		[createTerminalTab]
	);

	const handleCloseTerminalTab = useCallback(
		(tabId: string) => {
			const session = selectActiveSession(useSessionStore.getState());
			if (!session) {
				closeTerminalTab(tabId);
				return;
			}
			closeTerminalTabWithConfirm(getTerminalSessionId(session.id, tabId), () =>
				closeTerminalTab(tabId)
			);
		},
		[closeTerminalTab]
	);

	const handleSelectTerminalTab = useCallback(
		(tabId: string) => {
			selectTerminalTab(tabId);
		},
		[selectTerminalTab]
	);

	const handleRenameTerminalTab = useCallback(
		(tabId: string, name: string) => {
			renameTerminalTab(tabId, name);
		},
		[renameTerminalTab]
	);

	return {
		handleOpenTerminalTab,
		handleCloseTerminalTab,
		handleSelectTerminalTab,
		handleRenameTerminalTab,
	};
}
