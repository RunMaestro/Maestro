/**
 * useAgentCommandExitListener — registers `window.maestro.process.onCommandExit`
 *
 * Fires when a shell command spawned via `runCommand` finishes. If any AI
 * tab is still busy the session stays busy (the exit code only governs the
 * shell side); otherwise the session transitions to idle. Non-zero exit
 * codes are appended to `shellLogs` as a system log.
 *
 * Skips the no-op render when the session does not exist.
 */

import { useEffect } from 'react';
import type { LogEntry, SessionState } from '../../../types';
import { useSessionStore } from '../../../stores/sessionStore';
import { generateId } from '../../../utils/ids';
import { useOwnedSessionGate } from './useOwnedSessionGate';

export function useAgentCommandExitListener(): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;

		const unsubscribe = window.maestro.process.onCommandExit((sessionId: string, code: number) => {
			// Window scoping: ignore agents this window doesn't own (broadcast events).
			if (!ownedGate.current?.(sessionId)) return;
			const actualSessionId = sessionId;
			if (!getSessions().some((s) => s.id === actualSessionId)) return;

			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== actualSessionId) return s;

					const anyAiTabBusy = s.aiTabs?.some((tab) => tab.state === 'busy') || false;

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
							...s,
							state: newState,
							busySource: newBusySource,
							// TODO: Remove shellLogs once terminal tabs migration is complete
							...(!s.terminalTabs?.length && { shellLogs: [...s.shellLogs, exitLog] }),
						};
					}

					return {
						...s,
						state: newState,
						busySource: newBusySource,
					};
				})
			);
		});

		return () => {
			unsubscribe();
		};
	}, [ownedGate]);
}
