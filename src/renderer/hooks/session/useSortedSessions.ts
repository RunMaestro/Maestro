import { useCallback, useMemo } from 'react';
import type { Session, Group } from '../../types';
import { stripLeadingEmojis, compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import {
	sessionOrChildrenNeedAttention,
	type AttentionContext,
} from '../../utils/sessionAttention';

// Re-export for backwards compatibility with existing imports
export { stripLeadingEmojis, compareNamesIgnoringEmojis };

/**
 * Dependencies for the useSortedSessions hook.
 */
export interface UseSortedSessionsDeps {
	/** All sessions */
	sessions: Session[];
	/** All groups */
	groups: Group[];
	/** Whether the bookmarks folder is collapsed */
	bookmarksCollapsed: boolean;
	/**
	 * When true, visibleSessions excludes agents that don't need attention (and
	 * whose worktree children likewise don't). The active session (or its parent)
	 * is always kept visible so the user doesn't lose their place. Uses the same
	 * `sessionNeedsAttention` predicate as useSessionCategories so jump numbers
	 * and Alt+Cmd+N shortcuts match the rendered list.
	 */
	showUnreadAgentsOnly?: boolean;
	/** Active session id - kept visible even when the unread filter would exclude it */
	activeSessionId?: string | null;
	/** Agent ids auto-running an Auto Run playbook (the AUTO badge). */
	activeBatchSessionIds?: string[];
	/** Agent ids stuck auto-retrying an Agent Resilience outage. */
	stuckOutageSessionIds?: string[];
}

/**
 * Return type for useSortedSessions hook.
 */
export interface UseSortedSessionsReturn {
	/** All sessions sorted by group then alphabetically (ignoring leading emojis) */
	sortedSessions: Session[];
	/**
	 * Sessions visible for jump shortcuts (Opt+Cmd+NUMBER).
	 * Order: Bookmarked sessions first (if bookmarks expanded), then expanded groups/ungrouped.
	 * Note: A session may appear twice if bookmarked and in an expanded group.
	 */
	visibleSessions: Session[];
	/**
	 * Sessions in visual navigation order for keyboard arrow-key navigation.
	 * Order: Bookmarked sessions first (with worktree children), then group sessions,
	 * then ungrouped sessions. Bookmarked sessions appear in BOTH positions (bookmark
	 * section and their group) so they're navigable from either context.
	 */
	navSessions: Session[];
	/** Number of items in the bookmarks section of navSessions (including worktree children) */
	bookmarkNavSize: number;
	/**
	 * Maps render context keys to indices in navSessions for keyboard selection highlighting.
	 * Key format: 'bookmark:{id}', 'bookmark:wt:{childId}', 'group:{groupId}:{id}',
	 * 'group:{groupId}:wt:{childId}', 'ungrouped:{id}', 'ungrouped:wt:{childId}'
	 */
	navIndexMap: Map<string, number>;
}

/**
 * Hook for computing sorted and visible session lists.
 *
 * This hook handles:
 * 1. sortedSessions - All sessions sorted by group membership, then alphabetically
 *    (ignoring leading emojis for proper alphabetization)
 * 2. visibleSessions - Sessions visible for keyboard shortcuts (Opt+Cmd+NUMBER),
 *    respecting bookmarks folder state and group collapse states
 *
 * @param deps - Hook dependencies containing sessions, groups, and collapse state
 * @returns Sorted and visible session arrays
 */
export function useSortedSessions(deps: UseSortedSessionsDeps): UseSortedSessionsReturn {
	const {
		sessions,
		groups,
		bookmarksCollapsed,
		showUnreadAgentsOnly,
		activeSessionId,
		activeBatchSessionIds,
		stuckOutageSessionIds,
	} = deps;

	// Memoize worktree children lookup for O(1) access instead of O(n) per parent
	// This reduces complexity from O(n²) to O(n) when building sorted sessions
	const worktreeChildrenByParent = useMemo(() => {
		const map = new Map<string, Session[]>();
		for (const s of sessions) {
			if (s.parentSessionId) {
				const existing = map.get(s.parentSessionId);
				if (existing) {
					existing.push(s);
				} else {
					map.set(s.parentSessionId, [s]);
				}
			}
		}
		// Sort each group once
		for (const [, children] of map) {
			children.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		}
		return map;
	}, [sessions]);

	// Create sorted sessions array that matches visual display order (includes ALL sessions)
	// Note: sorting ignores leading emojis for proper alphabetization
	// Worktree children are inserted after their parent when the parent's worktrees are expanded
	const sortedSessions = useMemo(() => {
		const sorted: Session[] = [];

		// Helper to add session with its worktree children - now O(1) lookup
		const addSessionWithWorktrees = (session: Session) => {
			// Skip worktree children - they're added with their parent
			if (session.parentSessionId) return;

			sorted.push(session);

			// Add worktree children if expanded
			if (session.worktreesExpanded !== false) {
				const children = worktreeChildrenByParent.get(session.id);
				if (children) {
					sorted.push(...children);
				}
			}
		};

		// First, add sessions from sorted groups (ignoring leading emojis)
		const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		sortedGroups.forEach((group) => {
			const groupSessions = sessions
				.filter((s) => s.groupId === group.id && !s.parentSessionId)
				.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
			groupSessions.forEach(addSessionWithWorktrees);
		});

		// Then, add ungrouped sessions (sorted alphabetically, ignoring leading emojis)
		const ungroupedSessions = sessions
			.filter((s) => !s.groupId && !s.parentSessionId)
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		ungroupedSessions.forEach(addSessionWithWorktrees);

		return sorted;
	}, [sessions, groups, worktreeChildrenByParent]);

	// Create a Map for O(1) group lookup instead of O(n) find() calls
	const groupsById = useMemo(() => {
		const map = new Map<string, Group>();
		for (const g of groups) {
			map.set(g.id, g);
		}
		return map;
	}, [groups]);

	// Build navSessions: matches visual rendering order for keyboard navigation.
	// Bookmarked sessions first (with worktree children), then group sessions, then ungrouped.
	// Bookmarked sessions that belong to a group appear in BOTH positions.
	const { navSessions, navIndexMap, bookmarkNavSize } = useMemo(() => {
		const result: Session[] = [];
		const indexMap = new Map<string, number>();
		let idx = 0;

		const addWithWorktrees = (session: Session, keyPrefix: string) => {
			if (session.parentSessionId) return;
			result.push(session);
			indexMap.set(`${keyPrefix}:${session.id}`, idx++);
			if (session.worktreesExpanded !== false) {
				const children = worktreeChildrenByParent.get(session.id);
				if (children) {
					for (const child of children) {
						result.push(child);
						indexMap.set(`${keyPrefix}:wt:${child.id}`, idx++);
					}
				}
			}
		};

		// 1. Bookmarked sessions first
		const bookmarkedParents = sessions
			.filter((s) => s.bookmarked && !s.parentSessionId)
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		for (const session of bookmarkedParents) {
			addWithWorktrees(session, 'bookmark');
		}
		const bmSize = idx;

		// 2. Group sessions (same order as sortedSessions - all members including bookmarked)
		const navSortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		for (const group of navSortedGroups) {
			const groupSessions = sessions
				.filter((s) => s.groupId === group.id && !s.parentSessionId)
				.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
			for (const session of groupSessions) {
				addWithWorktrees(session, `group:${group.id}`);
			}
		}

		// 3. Ungrouped sessions
		const navUngrouped = sessions
			.filter((s) => !s.groupId && !s.parentSessionId)
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		for (const session of navUngrouped) {
			addWithWorktrees(session, 'ungrouped');
		}

		return { navSessions: result, navIndexMap: indexMap, bookmarkNavSize: bmSize };
	}, [sessions, groups, worktreeChildrenByParent]);

	// Build a lookup of worktree children by parent id for unread-filter checks.
	// Reuses the same child list already computed above.
	const childrenByParentId = worktreeChildrenByParent;

	// Rebuilt only when the id sets actually change - both arrive as arrays from
	// their stores, so a fresh Set every render would invalidate the memo below.
	const batchSignature = activeBatchSessionIds?.join(',') ?? '';
	const outageSignature = stuckOutageSessionIds?.join(',') ?? '';
	const attentionCtx = useMemo<AttentionContext>(
		() => ({
			batchSessionIds: new Set(batchSignature ? batchSignature.split(',') : []),
			stuckOutageIds: new Set(outageSignature ? outageSignature.split(',') : []),
		}),
		[batchSignature, outageSignature]
	);

	// Same `sessionNeedsAttention` predicate the Left Bar renders with, so
	// visibleSessions (jump badges + Alt+Cmd+N) stays in sync with the rendered
	// list. This used to be a second, narrower copy that knew nothing about error
	// states, Auto Run batches, or outages, so the two lists disagreed about which
	// agents the unread filter keeps.
	const passesUnreadFilter = useCallback(
		(session: Session): boolean => {
			if (!showUnreadAgentsOnly) return true;
			const children = childrenByParentId.get(session.id);
			const isActiveOrParentOfActive =
				session.id === activeSessionId ||
				children?.some((child) => child.id === activeSessionId) ||
				false;
			if (isActiveOrParentOfActive) return true;
			return sessionOrChildrenNeedAttention(session, children, attentionCtx);
		},
		[showUnreadAgentsOnly, activeSessionId, childrenByParentId, attentionCtx]
	);

	// Create visible sessions array for session jump shortcuts (Opt+Cmd+NUMBER)
	// Order: Bookmarked sessions first (if bookmarks folder expanded), then groups/ungrouped
	// Note: A session can appear twice if it's both bookmarked and in an expanded group
	// Note: Worktree children are excluded - they don't display jump numbers and shouldn't consume slots
	const visibleSessions = useMemo(() => {
		const result: Session[] = [];

		// Add bookmarked sessions first (if bookmarks folder is expanded)
		// Exclude worktree children (they don't show jump numbers)
		if (!bookmarksCollapsed) {
			const bookmarkedSessions = sessions
				.filter((s) => s.bookmarked && !s.parentSessionId && passesUnreadFilter(s))
				.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
			result.push(...bookmarkedSessions);
		}

		// Add sessions from expanded groups and ungrouped sessions
		// Exclude worktree children (they don't show jump numbers)
		// Use Map for O(1) group lookup instead of O(n) find()
		const groupAndUngrouped = sortedSessions.filter((session) => {
			// Exclude worktree children - they're nested under parent and don't show jump badges
			if (session.parentSessionId) return false;
			if (!passesUnreadFilter(session)) return false;
			if (!session.groupId) return true; // Ungrouped sessions always visible
			const group = groupsById.get(session.groupId);
			return group && !group.collapsed; // Only show if group is expanded
		});
		result.push(...groupAndUngrouped);

		return result;
	}, [sortedSessions, groupsById, sessions, bookmarksCollapsed, passesUnreadFilter]);

	return {
		sortedSessions,
		visibleSessions,
		navSessions,
		bookmarkNavSize,
		navIndexMap,
	};
}
