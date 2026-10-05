/**
 * Starring a provider conversation: the origin record's `starred` flag and the starred transcript mirror
 * that keeps the conversation alive if the provider later deletes its own copy.
 *
 * The `claude:updateSessionStarred` and `agentSessions:setSessionStarred` handlers and the runtime's star
 * side effect (4.9 of the desktop migration plan) all go through here, so a star set from a window and one
 * set for a command from the TUI cannot disagree about the entry's shape, about clearing it, or about the
 * mirror. Claude Code has its own origins store (`claude-session-origins.ts`); every other provider shares
 * the generic one (`agent-session-origins.ts`).
 *
 * The mirror work is fire-and-forget: a star must not wait on disk I/O.
 */

import type Store from 'electron-store';

import type { AgentSessionOriginsData, ClaudeSessionOriginsData } from '../stores/types';
import { setClaudeSessionOrigin } from './claude-session-origins';
import { releaseTranscriptMirror, snapshotStarredTranscript } from './starred-transcript-mirror';

export function setClaudeSessionStar(
	store: Store<ClaudeSessionOriginsData>,
	projectPath: string,
	agentSessionId: string,
	starred: boolean
): void {
	const entry = setClaudeSessionOrigin(store, projectPath, agentSessionId, { starred });
	if (starred) {
		const sessionName = typeof entry === 'object' ? entry.sessionName : undefined;
		void snapshotStarredTranscript({
			agentId: 'claude-code',
			projectPath,
			sessionId: agentSessionId,
			sessionName,
		});
	} else {
		void releaseTranscriptMirror({ agentId: 'claude-code', sessionId: agentSessionId });
	}
}

export function setAgentSessionStar(
	store: Store<AgentSessionOriginsData>,
	agentId: string,
	projectPath: string,
	sessionId: string,
	starred: boolean
): void {
	const allOrigins = store.get('origins', {});
	if (!allOrigins[agentId]) allOrigins[agentId] = {};
	if (!allOrigins[agentId][projectPath]) allOrigins[agentId][projectPath] = {};

	if (starred) {
		allOrigins[agentId][projectPath][sessionId] = {
			...allOrigins[agentId][projectPath][sessionId],
			starred: true,
		};
	} else {
		// Remove starred
		const existing = allOrigins[agentId][projectPath][sessionId];
		if (existing) {
			delete existing.starred;
			// Clean up if empty
			if (!existing.sessionName && !existing.origin) {
				delete allOrigins[agentId][projectPath][sessionId];
			}
		}
	}
	store.set('origins', allOrigins);

	// Keep Maestro's own transcript mirror in sync with the star: snapshot on star so the conversation
	// survives provider-side deletion, drop the mirror on unstar so it ages out naturally again.
	if (starred) {
		const sessionName = allOrigins[agentId]?.[projectPath]?.[sessionId]?.sessionName;
		void snapshotStarredTranscript({ agentId, projectPath, sessionId, sessionName });
	} else {
		void releaseTranscriptMirror({ agentId, sessionId });
	}
}
