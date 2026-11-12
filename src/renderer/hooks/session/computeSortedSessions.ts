import type { Session, Group } from '../../types';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import {
	sessionOrChildrenNeedAttention,
	type AttentionContext,
} from '../../utils/sessionAttention';

/**
 * Inputs for {@link computeSortedSessions}. Pure - safe to call from a Zustand
 * sync host or tests without React.
 */
export interface ComputeSortedSessionsInput {
	sessions: Session[];
	groups: Group[];
	bookmarksCollapsed: boolean;
	showUnreadAgentsOnly?: boolean;
	activeSessionId?: string | null;
	/** Session ids auto-running an Auto Run batch (the AUTO badge). */
	activeBatchSessionIds?: string[];
	/** Session ids stuck auto-retrying an Agent Resilience outage. */
	stuckOutageSessionIds?: string[];
}

/**
 * Sorted / nav / jump-badge projections for the Left Bar.
 * Same shape as the former `useSortedSessions` return value.
 */
export interface SortedSessionsProjection {
	sortedSessions: Session[];
	visibleSessions: Session[];
	navSessions: Session[];
	bookmarkNavSize: number;
	navIndexMap: Map<string, number>;
}

/**
 * Compute Left Bar session order projections.
 *
 * 1. sortedSessions - group then alpha (ignoring leading emojis), with worktrees
 * 2. visibleSessions - Opt+Cmd+NUMBER jump targets
 * 3. navSessions / navIndexMap - arrow-key visual order (bookmarks + group + ungrouped)
 */
export function computeSortedSessions(input: ComputeSortedSessionsInput): SortedSessionsProjection {
	const {
		sessions,
		groups,
		bookmarksCollapsed,
		showUnreadAgentsOnly,
		activeSessionId,
		activeBatchSessionIds,
		stuckOutageSessionIds,
	} = input;
	const attentionCtx: AttentionContext = {
		batchSessionIds: new Set(activeBatchSessionIds),
		stuckOutageIds: new Set(stuckOutageSessionIds),
	};

	const worktreeChildrenByParent = new Map<string, Session[]>();
	for (const s of sessions) {
		if (s.parentSessionId) {
			const existing = worktreeChildrenByParent.get(s.parentSessionId);
			if (existing) {
				existing.push(s);
			} else {
				worktreeChildrenByParent.set(s.parentSessionId, [s]);
			}
		}
	}
	for (const [, children] of worktreeChildrenByParent) {
		children.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
	}

	const sortedSessions: Session[] = [];
	const addSessionWithWorktrees = (session: Session) => {
		if (session.parentSessionId) return;
		sortedSessions.push(session);
		if (session.worktreesExpanded !== false) {
			const children = worktreeChildrenByParent.get(session.id);
			if (children) {
				sortedSessions.push(...children);
			}
		}
	};

	const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
	sortedGroups.forEach((group) => {
		const groupSessions = sessions
			.filter((s) => s.groupId === group.id && !s.parentSessionId)
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		groupSessions.forEach(addSessionWithWorktrees);
	});

	const ungroupedSessions = sessions
		.filter((s) => !s.groupId && !s.parentSessionId)
		.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
	ungroupedSessions.forEach(addSessionWithWorktrees);

	const groupsById = new Map<string, Group>();
	for (const g of groups) {
		groupsById.set(g.id, g);
	}

	const navSessions: Session[] = [];
	const navIndexMap = new Map<string, number>();
	let idx = 0;

	const addWithWorktrees = (session: Session, keyPrefix: string) => {
		if (session.parentSessionId) return;
		navSessions.push(session);
		navIndexMap.set(`${keyPrefix}:${session.id}`, idx++);
		if (session.worktreesExpanded !== false) {
			const children = worktreeChildrenByParent.get(session.id);
			if (children) {
				for (const child of children) {
					navSessions.push(child);
					navIndexMap.set(`${keyPrefix}:wt:${child.id}`, idx++);
				}
			}
		}
	};

	const bookmarkedParents = sessions
		.filter((s) => s.bookmarked && !s.parentSessionId)
		.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
	for (const session of bookmarkedParents) {
		addWithWorktrees(session, 'bookmark');
	}
	const bookmarkNavSize = idx;

	for (const group of sortedGroups) {
		const groupSessions = sessions
			.filter((s) => s.groupId === group.id && !s.parentSessionId)
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		for (const session of groupSessions) {
			addWithWorktrees(session, `group:${group.id}`);
		}
	}

	const navUngrouped = sessions
		.filter((s) => !s.groupId && !s.parentSessionId)
		.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
	for (const session of navUngrouped) {
		addWithWorktrees(session, 'ungrouped');
	}

	const passesUnreadFilter = (session: Session): boolean => {
		if (!showUnreadAgentsOnly) return true;
		const isActiveOrParentOfActive =
			session.id === activeSessionId ||
			worktreeChildrenByParent.get(session.id)?.some((child) => child.id === activeSessionId) ||
			false;
		if (isActiveOrParentOfActive) return true;
		return sessionOrChildrenNeedAttention(
			session,
			worktreeChildrenByParent.get(session.id),
			attentionCtx
		);
	};

	const visibleSessions: Session[] = [];
	if (!bookmarksCollapsed) {
		const bookmarkedSessions = sessions
			.filter((s) => s.bookmarked && !s.parentSessionId && passesUnreadFilter(s))
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		visibleSessions.push(...bookmarkedSessions);
	}

	const groupAndUngrouped = sortedSessions.filter((session) => {
		if (session.parentSessionId) return false;
		if (!passesUnreadFilter(session)) return false;
		if (!session.groupId) return true;
		const group = groupsById.get(session.groupId);
		return group && !group.collapsed;
	});
	visibleSessions.push(...groupAndUngrouped);

	return {
		sortedSessions,
		visibleSessions,
		navSessions,
		bookmarkNavSize,
		navIndexMap,
	};
}
