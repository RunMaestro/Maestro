/**
 * useAgentCommandExitListener — registers `window.maestro.process.onCommandExit`
 *
 * Fires when a shell command spawned via `runCommand` finishes. Native OMP
 * sends an explicit turn-completion payload on the same channel: that settles
 * only the routed AI tab while keeping its RPC process alive for the next
 * prompt. Legacy command exits retain their shell semantics.
 *
 * Skips the no-op render when the session does not exist.
 */

import { useEffect } from 'react';
import type { LogEntry, SessionState } from '../../../types';
import { useSessionStore } from '../../../stores/sessionStore';
import { generateId } from '../../../utils/ids';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { isOmpNativeTurnCompletion } from '../../../../shared/omp-native-session';
import { useOwnedSessionGate } from './useOwnedSessionGate';

export function useAgentCommandExitListener(): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;

		const unsubscribe = window.maestro.process.onCommandExit(
			(sessionId: string, code: number, completion?: unknown) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;

				const nativeTurnComplete = isOmpNativeTurnCompletion(completion);
				const aiTabMatch = nativeTurnComplete ? sessionId.match(REGEX_AI_TAB) : null;
				const actualSessionId = aiTabMatch ? aiTabMatch[1] : sessionId;
				const tabId = aiTabMatch?.[2];
				if (!getSessions().some((session) => session.id === actualSessionId)) return;

				setSessions((prev) =>
					prev.map((session) => {
						if (session.id !== actualSessionId) return session;

						if (nativeTurnComplete && tabId) {
							const aiTabs = session.aiTabs.map((tab) =>
								tab.id === tabId
									? { ...tab, state: 'idle' as const, thinkingStartTime: undefined }
									: tab
							);
							const anyAiTabBusy = aiTabs.some((tab) => tab.state === 'busy');
							return {
								...session,
								aiTabs,
								state: anyAiTabBusy ? ('busy' as SessionState) : ('idle' as SessionState),
								busySource: anyAiTabBusy ? ('ai' as const) : undefined,
								thinkingStartTime: anyAiTabBusy ? session.thinkingStartTime : undefined,
							};
						}

						const anyAiTabBusy = session.aiTabs?.some((tab) => tab.state === 'busy') || false;

						const newState = anyAiTabBusy ? ('busy' as SessionState) : ('idle' as SessionState);
						const newBusySource = anyAiTabBusy ? ('ai' as const) : undefined;

						if (code !== 0) {
							const exitLog: LogEntry = {
								id: generateId(),
								timestamp: Date.now(),
								source: 'system',
								text: `Command exited with code ${code}`,
							};
							return {
								...session,
								state: newState,
								busySource: newBusySource,
								// TODO: Remove shellLogs once terminal tabs migration is complete
								...(!session.terminalTabs?.length && {
									shellLogs: [...session.shellLogs, exitLog],
								}),
							};
						}

						return {
							...session,
							state: newState,
							busySource: newBusySource,
						};
					})
				);
			}
		);

		return () => {
			unsubscribe();
		};
	}, [ownedGate]);
}
