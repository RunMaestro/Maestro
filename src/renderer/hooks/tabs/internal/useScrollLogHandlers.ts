import { useCallback } from 'react';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import { useTabStore } from '../../../stores/tabStore';
import { notifyToast } from '../../../stores/notificationStore';
import type { Session } from '../../../types';
import { getActiveTab } from '../../../utils/tabHelpers';
import { logger } from '../../../utils/logger';
import { projectTabProvider, resolveTabNativeProvider } from '../../../utils/providerTabSessions';
import { resolveSessionProjectPath } from '../../../components/AgentSessionsBrowser/utils/sessionProjectPath';
import { resolveTurnProvider } from '../../../../shared/maestro-lib/agents/providerSwap';
import { deleteShellCommandLog } from './deleteShellCommandLog';
import type { ScrollLogHandlersReturn } from './types';

export function useScrollLogHandlers(): ScrollLogHandlersReturn {
	const handleDeleteLog = useCallback(async (logId: string): Promise<number | null> => {
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

		if (
			isAIMode &&
			currentActiveTab &&
			(currentSession.toolType === 'grok' ||
				resolveTurnProvider(currentActiveTab, currentSession) === 'grok' ||
				currentActiveTab.providerSessions?.grok)
		) {
			// A rendered log ID is not a native prompt index. Neither the Claude
			// API nor the unscoped generic deletion API can mutate Grok safely.
			// Logs retain no per-row provider ownership after a switch. Refuse
			// mixed history too, even after a newer turn on another provider.
			notifyToast({
				color: 'yellow',
				title: 'Grok history deletion unavailable',
				message:
					'Maestro cannot safely delete or edit Grok native history. This conversation is unchanged. Manage the session in Grok CLI using the same account and host, then refresh History.',
				sessionId: currentSession.id,
				tabId: currentActiveTab.id,
			});
			return null;
		}

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
			const provider =
				log.turnProvider ?? resolveTabNativeProvider(currentActiveTab, currentSession);
			const projected = projectTabProvider(currentSession, currentActiveTab, provider);
			const agentSessionId = projected.tab?.agentSessionId;
			if (agentSessionId) {
				try {
					// A remote agent's transcript lives on its SSH remote, under the
					// remote working directory rather than the local cwd.
					const { projectPathForSessions, sshRemoteId } = resolveSessionProjectPath(
						projected.agent
					);
					const result = await window.maestro.agentSessions.deleteMessagePair(
						provider,
						sshRemoteId ? (projectPathForSessions ?? currentSession.cwd) : currentSession.cwd,
						agentSessionId,
						logId,
						log.text,
						sshRemoteId
					);
					if (!result.success) throw new Error(result.error || 'The provider refused deletion.');
				} catch (error) {
					logger.error('[handleDeleteLog] Provider deletion failed', undefined, error);
					notifyToast({
						type: 'error',
						title: 'Message was not deleted',
						message: `It remains in the agent's context. ${error instanceof Error ? error.message : String(error)}`,
						sessionId: currentSession.id,
						tabId: currentActiveTab.id,
					});
					return null;
				}
			}

			const commandText = log.text.trim();
			const deletedLogIds = new Set(logs.slice(logIndex, endIndex).map((entry) => entry.id));

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
							tab.id === currentActiveTab.id
								? { ...tab, logs: tab.logs.filter((entry) => !deletedLogIds.has(entry.id)) }
								: tab
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
