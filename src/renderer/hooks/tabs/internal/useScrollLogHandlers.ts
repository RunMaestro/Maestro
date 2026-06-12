import { useCallback } from 'react';
import { selectActiveSession, updateAiTab, useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types';
import { getActiveTab } from '../../../utils/tabHelpers';
import { logger } from '../../../utils/logger';
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

	const handleScrollPositionChange = useCallback((scrollTop: number) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		if (session.inputMode === 'ai') {
			const currentActiveTab = getActiveTab(session);
			if (!currentActiveTab) return;
			updateAiTab(session.id, currentActiveTab.id, (tab) => ({ ...tab, scrollTop }));
		} else {
			useSessionStore.getState().updateSession(session.id, { terminalScrollTop: scrollTop });
		}
	}, []);

	const handleAtBottomChange = useCallback((isAtBottom: boolean) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		if (session.inputMode === 'ai') {
			const currentActiveTab = getActiveTab(session);
			if (!currentActiveTab) return;
			updateAiTab(session.id, currentActiveTab.id, (tab) => ({
				...tab,
				isAtBottom,
				hasUnread: isAtBottom ? false : tab.hasUnread,
			}));
		}
	}, []);

	return {
		handleScrollPositionChange,
		handleAtBottomChange,
		handleDeleteLog,
	};
}
