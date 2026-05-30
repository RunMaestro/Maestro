import { useCallback } from 'react';
import { useModalStore } from '../../../stores/modalStore';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import { useTabStore } from '../../../stores/tabStore';
import { getTerminalSessionId } from '../../../utils/terminalTabHelpers';
import { captureMessage } from '../../../utils/sentry';
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
			const ptySessionId = getTerminalSessionId(session.id, tabId);
			window.maestro.process
				.isTerminalBusy(ptySessionId)
				.then((busy) => {
					if (busy) {
						useModalStore.getState().openModal('confirm', {
							message: 'This terminal is running a command. Close it and stop the command?',
							onConfirm: () => closeTerminalTab(tabId),
							destructive: true,
						});
					} else {
						closeTerminalTab(tabId);
					}
				})
				.catch((err) => {
					captureMessage('isTerminalBusy IPC failed, closing tab without prompt', {
						level: 'warning',
						extra: { ptySessionId, tabId, err: String(err) },
					});
					closeTerminalTab(tabId);
				});
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
