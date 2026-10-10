import { useCallback } from 'react';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import { useTabStore } from '../../../stores/tabStore';
import type { Session } from '../../../types';
import { getActiveTab } from '../../../utils/tabHelpers';
import { logger } from '../../../utils/logger';
import { deleteShellCommandLog } from './deleteShellCommandLog';
import type { ScrollLogHandlersReturn } from './types';

export function useScrollLogHandlers(): ScrollLogHandlersReturn {
	const handleDeleteLog = useCallback((logId: string): number | null => {
		const { setSessions } = useSessionStore.getState();
		const currentSession = selectActiveSession(useSessionStore.getState());
		if (!currentSession) return null;

		const isAIMode = currentSession.inputMode === 'ai';
		const currentActiveTab = isAIMode ? getActiveTab(currentSession) : null;
		const logs = isAIMode ? currentActiveTab?.logs || [] : currentSession.shellLogs;

		const logIndex = logs.findIndex((log) => log.id === logId);
		if (logIndex === -1) return null;

		const log = logs[logIndex];

		// A command-mode card is self-contained: it owns its command AND its
		// output, and the agent never saw either. So it deletes as a single entry
		// rather than as the span-to-the-next-user-message the branch below walks,
		// and it must NOT reach the provider-transcript deletion down there - there
		// is no message pair in the agent's session to delete.
		if (log.shellCommand) {
			if (!isAIMode || !currentActiveTab) return null;
			setSessions((prev: Session[]) =>
				deleteShellCommandLog(prev, {
					sessionId: currentSession.id,
					tabId: currentActiveTab.id,
					logId,
					command: log.shellCommand!.command,
				})
			);
			// No scroll target: removing one card should leave the reader where
			// they are, not jump them to some other message.
			return null;
		}

		if (log.source !== 'user') return null;

		let endIndex = logs.length;
		for (let i = logIndex + 1; i < logs.length; i++) {
			if (logs[i].source === 'user') {
				endIndex = i;
				break;
			}
		}

		const newLogs = [...logs.slice(0, logIndex), ...logs.slice(endIndex)];

		let nextUserCommandIndex: number | null = null;
		for (let i = logIndex; i < newLogs.length; i++) {
			if (newLogs[i].source === 'user') {
				nextUserCommandIndex = i;
				break;
			}
		}
		if (nextUserCommandIndex === null) {
			for (let i = logIndex - 1; i >= 0; i--) {
				if (newLogs[i].source === 'user') {
					nextUserCommandIndex = i;
					break;
				}
			}
		}

		if (isAIMode && currentActiveTab) {
			const agentSessionId = currentActiveTab.agentSessionId;
			if (agentSessionId && currentSession.cwd) {
				window.maestro.claude
					.deleteMessagePair(currentSession.cwd, agentSessionId, logId, log.text)
					.then((result) => {
						if (!result.success) {
							logger.warn(
								'[handleDeleteLog] Failed to delete from Claude session:',
								undefined,
								result.error
							);
						}
					})
					.catch((err) => {
						logger.error('[handleDeleteLog] Error deleting from Claude session:', undefined, err);
					});
			}

			const commandText = log.text.trim();

			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== currentSession.id) return s;
					const newAICommandHistory = (s.aiCommandHistory || []).filter(
						(cmd) => cmd !== commandText
					);
					return {
						...s,
						aiCommandHistory: newAICommandHistory,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === currentActiveTab.id ? { ...tab, logs: newLogs } : tab
						),
					};
				})
			);
		} else {
			const commandText = log.text.trim();

			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== currentSession.id) return s;
					const newShellCommandHistory = (s.shellCommandHistory || []).filter(
						(cmd) => cmd !== commandText
					);
					return {
						...s,
						shellLogs: newLogs,
						shellCommandHistory: newShellCommandHistory,
					};
				})
			);
		}

		return nextUserCommandIndex;
	}, []);

	// Both scroll handlers resolve the ACTIVE AI tab and then defer to the
	// tab-id-keyed store actions. A tiled AI pane can't use these - a wheel scroll
	// never focuses a pane, so a background pane would write its offset onto the
	// focused tab - so it calls the same store actions with its own tab id instead.
	const handleScrollPositionChange = useCallback((scrollTop: number) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		if (session.inputMode === 'ai') {
			const currentActiveTab = getActiveTab(session);
			if (!currentActiveTab) return;
			useTabStore.getState().setAiTabScrollTop(currentActiveTab.id, scrollTop);
		} else {
			useSessionStore.getState().updateSession(session.id, { terminalScrollTop: scrollTop });
		}
	}, []);

	const handleAtBottomChange = useCallback((isAtBottom: boolean) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		if (session.inputMode !== 'ai') return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		useTabStore.getState().setAiTabAtBottom(currentActiveTab.id, isAtBottom);
	}, []);

	return {
		handleScrollPositionChange,
		handleAtBottomChange,
		handleDeleteLog,
	};
}
