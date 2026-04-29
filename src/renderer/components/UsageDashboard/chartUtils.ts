/**
 * Shared utilities for UsageDashboard chart components.
 *
 * Worktree differentiation helpers let charts visually distinguish
 * worktree child agents from regular agents and parent agents.
 */

import type { Session } from '../../types';

/**
 * Returns true if the session is a worktree child (was spawned from a parent agent).
 */
export function isWorktreeAgent(session: Session): boolean {
	return !!session.parentSessionId;
}

/**
 * Returns true if the session is a parent agent that manages worktree children.
 */
export function isParentAgent(session: Session): boolean {
	return !!session.worktreeConfig;
}

/**
 * Resolve a stats `sessionId` (which may include suffixes like tab IDs) to the
 * matching Session by prefix. Returns undefined if no match is found.
 */
export function findSessionByStatId(
	statSessionId: string,
	sessions: Session[] | undefined
): Session | undefined {
	if (!sessions || sessions.length === 0) return undefined;
	return sessions.find((s) => statSessionId.startsWith(s.id));
}
