/**
 * useAgentUserInputListener — mirrors submitted user messages across renderer
 * contexts. Agent output already travels through process:data; user messages are
 * local optimistic state, so web-desktop peers need this explicit event.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import type { LogEntry, SessionState } from '../../../types';
import { getInputBroadcastOriginId } from '../../../utils/ids';
import { getActiveTab } from '../../../utils/tabHelpers';

interface ProcessUserInputPayload {
	originId: string;
	sessionId: string;
	tabId?: string;
	inputMode: 'ai' | 'terminal';
	entry: LogEntry;
}

function hasEntry(logs: LogEntry[] | undefined, id: string): boolean {
	return !!logs?.some((entry) => entry.id === id);
}

export function useAgentUserInputListener(): void {
	useEffect(() => {
		const unsubscribe = window.maestro.process.onUserInput((payload: ProcessUserInputPayload) => {
			if (payload.originId === getInputBroadcastOriginId()) return;

			useSessionStore.getState().setSessions((prev) =>
				prev.map((session) => {
					if (session.id !== payload.sessionId) return session;

					if (payload.inputMode !== 'ai') {
						if (hasEntry(session.shellLogs, payload.entry.id)) return session;
						return {
							...session,
							shellLogs: [...session.shellLogs, payload.entry],
							state: 'busy' as SessionState,
							busySource: 'terminal',
						};
					}

					const targetTabId = payload.tabId ?? getActiveTab(session)?.id;
					if (!targetTabId) return session;

					let didChange = false;
					const aiTabs = session.aiTabs.map((tab) => {
						if (tab.id !== targetTabId || hasEntry(tab.logs, payload.entry.id)) return tab;
						didChange = true;
						return {
							...tab,
							logs: [...tab.logs, payload.entry],
							state: 'busy' as const,
							thinkingStartTime: payload.entry.timestamp,
							awaitingSessionId: tab.agentSessionId ? tab.awaitingSessionId : true,
							agentError: undefined,
						};
					});

					if (!didChange) return session;
					return {
						...session,
						state: 'busy' as SessionState,
						busySource: 'ai',
						thinkingStartTime: payload.entry.timestamp,
						currentCycleTokens: 0,
						currentCycleBytes: 0,
						agentError: undefined,
						agentErrorTabId: undefined,
						agentErrorPaused: false,
						aiTabs,
					};
				})
			);
		});

		return () => unsubscribe();
	}, []);
}
