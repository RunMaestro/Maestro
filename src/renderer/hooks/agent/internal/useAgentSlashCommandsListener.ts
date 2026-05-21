/**
 * useAgentSlashCommandsListener — registers `window.maestro.process.onSlashCommands`
 *
 * Routes the discovered slash commands to the matching session via
 * `parseSessionId` then writes them on `session.agentCommands` with
 * descriptions resolved via `getSlashCommandDescription`.
 *
 * No shared state with other listeners. Single setSessions write per event.
 * Performance: bails early when the session does not exist (orphan event).
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { parseSessionId } from '../../../utils/sessionIdParser';
import { getSlashCommandDescription } from '../../../constants/app';
import { useProcessWindowScope } from './useProcessWindowScope';

export function useAgentSlashCommandsListener(): void {
	const isSessionInCurrentWindow = useProcessWindowScope();

	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;

		const unsubscribe = window.maestro.process.onSlashCommands(
			(sessionId: string, slashCommands: string[]) => {
				if (!isSessionInCurrentWindow(sessionId)) return;

				const actualSessionId = parseSessionId(sessionId).baseSessionId;

				// Perf: orphan event — skip the no-op map.
				if (!getSessions().some((s) => s.id === actualSessionId)) return;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						const commands = slashCommands.map((cmd) => ({
							command: cmd.startsWith('/') ? cmd : `/${cmd}`,
							description: getSlashCommandDescription(cmd, s.toolType),
						}));
						return { ...s, agentCommands: commands };
					})
				);
			}
		);

		return () => {
			unsubscribe();
		};
	}, [isSessionInCurrentWindow]);
}
