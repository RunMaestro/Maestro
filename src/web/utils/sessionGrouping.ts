/**
 * Session Grouping Utilities
 *
 * Shared logic for organizing sessions into groups (bookmarks, named groups, ungrouped).
 * Used by Sidebar, AllSessionsView, and SessionPillBar to avoid duplication.
 */

import type { Session, GroupInfo } from '../hooks/useSessions';

/**
 * Find the parent session for a worktree child.
 * Uses parentSessionId when available, falls back to path pattern matching.
 */
export function findParentSession(session: Session, sessions: Session[]): Session | null {
	if (session.parentSessionId) {
		return sessions.find((s) => s.id === session.parentSessionId) || null;
	}

	// Try to infer parent from worktree path patterns
	const cwd = session.cwd;
	const worktreeMatch = cwd.match(/^(.+?)[-]?WorkTrees[\/\\]([^\/\\]+)/i);

	if (worktreeMatch) {
		const basePath = worktreeMatch[1];
		return (
			sessions.find(
				(s) =>
					s.id !== session.id &&
					!s.parentSessionId &&
					(s.cwd === basePath ||
						s.cwd.startsWith(basePath + '/') ||
						s.cwd.startsWith(basePath + '\\'))
			) || null
		);
	}

	return null;
}

/**
 * Compute display name for a session.
 * Worktree children show "ParentName: branch-name".
 */
export function getSessionDisplayName(session: Session, sessions: Session[]): string {
	const parent = findParentSession(session, sessions);
	if (parent) {
		const branchName = session.worktreeBranch || session.name;
		return `${parent.name}: ${branchName}`;
	}
	return session.name;
}

/**
 * Get the effective group for a session.
 * Worktree children inherit their parent's group.
 */
export function getSessionEffectiveGroup(
	session: Session,
	sessions: Session[]
): { groupId: string | null; groupName: string | null; groupEmoji: string | null } {
	const parent = findParentSession(session, sessions);
	if (parent) {
		return {
			groupId: parent.groupId || null,
			groupName: parent.groupName || null,
			groupEmoji: parent.groupEmoji || null,
		};
	}
	return {
		groupId: session.groupId || null,
		groupName: session.groupName || null,
		groupEmoji: session.groupEmoji || null,
	};
}

/**
 * Result of grouping sessions
 */
export interface GroupedSessions {
	sessionsByGroup: Record<string, GroupInfo>;
	sortedGroupKeys: string[];
}

/**
 * Organize sessions into groups with bookmarks first and ungrouped last.
 *
 * @param filteredSessions - Sessions after any search filtering
 * @param allSessions - All sessions (needed for worktree parent lookup)
 */
export function groupSessions(filteredSessions: Session[], allSessions: Session[]): GroupedSessions {
	const groups: Record<string, GroupInfo> = {};

	// Exclude worktree children from the main list (they nest under their parent in the Electron app)
	const topLevelSessions = filteredSessions.filter((s) => !s.parentSessionId);

	// Add bookmarked sessions to a special "bookmarks" group
	const bookmarkedSessions = topLevelSessions.filter((s) => s.bookmarked);
	if (bookmarkedSessions.length > 0) {
		groups['bookmarks'] = {
			id: 'bookmarks',
			name: 'Bookmarks',
			emoji: null,
			sessions: bookmarkedSessions,
		};
	}

	// Organize sessions by their effective group
	for (const session of topLevelSessions) {
		const effectiveGroup = getSessionEffectiveGroup(session, allSessions);
		const groupKey = effectiveGroup.groupId || 'ungrouped';

		if (!groups[groupKey]) {
			groups[groupKey] = {
				id: effectiveGroup.groupId,
				name: effectiveGroup.groupName || 'Ungrouped',
				emoji: effectiveGroup.groupEmoji,
				sessions: [],
			};
		}
		groups[groupKey].sessions.push(session);
	}

	// Sort: bookmarks first, named groups alphabetically, ungrouped last
	const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
		if (a === 'bookmarks') return -1;
		if (b === 'bookmarks') return 1;
		if (a === 'ungrouped') return 1;
		if (b === 'ungrouped') return -1;
		return groups[a].name.localeCompare(groups[b].name);
	});

	return { sessionsByGroup: groups, sortedGroupKeys };
}

/**
 * Filter sessions by a search query against name, cwd, toolType, and worktree branch.
 */
export function filterSessions(
	sessions: Session[],
	query: string,
	allSessions: Session[]
): Session[] {
	if (!query.trim()) return sessions;
	const q = query.toLowerCase();
	return sessions.filter((session) => {
		const displayName = getSessionDisplayName(session, allSessions);
		return (
			displayName.toLowerCase().includes(q) ||
			session.name.toLowerCase().includes(q) ||
			session.cwd.toLowerCase().includes(q) ||
			(session.toolType && session.toolType.toLowerCase().includes(q)) ||
			(session.worktreeBranch && session.worktreeBranch.toLowerCase().includes(q))
		);
	});
}
