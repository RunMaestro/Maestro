/**
 * Writing a provider conversation's user-assigned name into the generic session-origins store (every
 * provider but Claude Code, which has its own: `claude-session-origins.ts`).
 *
 * The `agentSessions:setSessionName` handler and the runtime's rename side effect (4.9 of the desktop
 * migration plan) both go through here, so a name written by a window and one written for a command
 * from the TUI cannot disagree about the shape of the entry or about clearing it.
 */

import type Store from 'electron-store';

import type { AgentSessionOriginsData } from '../stores/types';

export function setAgentSessionName(
	originsStore: Store<AgentSessionOriginsData>,
	agentId: string,
	projectPath: string,
	sessionId: string,
	sessionName: string | null
): void {
	const allOrigins = originsStore.get('origins', {});
	if (!allOrigins[agentId]) allOrigins[agentId] = {};
	if (!allOrigins[agentId][projectPath]) allOrigins[agentId][projectPath] = {};

	if (sessionName) {
		allOrigins[agentId][projectPath][sessionId] = {
			...allOrigins[agentId][projectPath][sessionId],
			sessionName,
		};
	} else {
		// Remove sessionName
		const existing = allOrigins[agentId][projectPath][sessionId];
		if (existing) {
			delete existing.sessionName;
			// Clean up if empty
			if (!existing.starred && !existing.origin) {
				delete allOrigins[agentId][projectPath][sessionId];
			}
		}
	}
	originsStore.set('origins', allOrigins);
}
