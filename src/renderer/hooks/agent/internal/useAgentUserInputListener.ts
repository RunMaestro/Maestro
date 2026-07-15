/**
 * useAgentUserInputListener - mirrors submitted user messages across renderer
 * contexts. Agent output already travels through process:data; user messages are
 * local optimistic state, so web-desktop peers need this explicit event.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import type { LogEntry, SessionState } from '../../../types';
import { getInputBroadcastOriginId } from '../../../utils/ids';
import { getActiveTab } from '../../../utils/tabHelpers';
import { useOwnedSessionGate } from './useOwnedSessionGate';

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
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const unsubscribe = window.maestro.process.onUserInput((payload: ProcessUserInputPayload) => {
			if (payload.originId === getInputBroadcastOriginId()) return;
			// Window scoping: ignore agents this window doesn't own (broadcast events).
			if (!ownedGate.current?.(payload.sessionId)) return;

			useSessionStore.getState().setSessions((prev) =>
				prev.map((session) => {
					if (session.id !== payload.sessionId) return session;

					// A user-input broadcast means a turn is STARTING. Mark the
					// session/tab busy so observer renderers (web-desktop peers, the
					// sharing host) light up the thinking pill + tab/side-panel
					// indicators. The log push is deduped independently: the entry can
					// already be present from a session sync that raced the broadcast,
					// and busy must still be set in that case. Coupling busy to the log
					// append (the old `didChange` gate) dropped the busy state whenever
					// the entry pre-existed, leaving thoughts streaming with no pill.
					if (payload.inputMode !== 'ai') {
						const shellLogs = hasEntry(session.shellLogs, payload.entry.id)
							? session.shellLogs
							: [...session.shellLogs, payload.entry];
						return {
							...session,
							shellLogs,
							state: 'busy' as SessionState,
							busySource: 'terminal',
						};
					}

					const targetTabId = payload.tabId ?? getActiveTab(session)?.id;
					if (!targetTabId) return session;

					let tabFound = false;
					const aiTabs = session.aiTabs.map((tab) => {
						if (tab.id !== targetTabId) return tab;
						tabFound = true;
						const logs = hasEntry(tab.logs, payload.entry.id)
							? tab.logs
							: [...tab.logs, payload.entry];
						return {
							...tab,
							logs,
							state: 'busy' as const,
							thinkingStartTime: payload.entry.timestamp,
							awaitingSessionId: tab.agentSessionId ? tab.awaitingSessionId : true,
							agentError: undefined,
						};
					});

					if (!tabFound) return session;
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
	}, [ownedGate]);
}
