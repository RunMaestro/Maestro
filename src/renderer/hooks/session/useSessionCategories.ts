import { useCallback, useMemo } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import type { Session, Group } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { sidebarSessionEquality } from '../../stores/sessionEquality';
import { compareNamesIgnoringEmojis as compareSessionNames } from '../../../shared/emojiUtils';

export interface SessionCategories {
	worktreeChildrenByParentId: Map<string, Session[]>;
	sortedWorktreeChildrenByParentId: Map<string, Session[]>;
	sortedSessionIndexById: Map<string, number>;
	getWorktreeChildren: (parentId: string) => Session[];

	bookmarkedSessions: Session[];
	sortedBookmarkedSessions: Session[];
	sortedBookmarkedParentSessions: Session[];
	sortedGroupSessionsById: Map<string, Session[]>;
	ungroupedSessions: Session[];
	sortedUngroupedSessions: Session[];
	sortedUngroupedParentSessions: Session[];
	sortedFilteredSessions: Session[];
	sortedGroups: Group[];
}

export function useSessionCategories(
	sessionFilter: string,
	sortedSessions: Session[],
	showUnreadAgentsOnly = false,
	activeSessionId?: string | null,
	activeBatchSessionIds: string[] = [],
	// Multi-window: optionally narrow the session universe BEFORE categorization so
	// a secondary window's Left Bar categorizes only the agents it owns. This hook
	// reads `sessions` straight from the store (below) rather than from the
	// `sortedSessions` param, so scoping the param alone would NOT scope the
	// rendered category lists - the scope has to be applied here. No-op (identity)
	// when omitted, so the primary window and every existing caller are unchanged.
	scopeSessions?: (list: Session[]) => Session[],
	// Comma-joined signature of agents with an active Agent Resilience outage.
	// Stuck agents are treated as "needs attention" and surface in the unread
	// filter alongside genuinely unread ones (see stuckOutageSessionIds below).
	stuckOutageSignature = ''
): SessionCategories {
	// PERF: Match SessionList's sidebar-only equality so categorization doesn't
	// recompute on every streaming flush — only when a sidebar-relevant field
	// (state, name, group/bookmark/parent membership, AI tab unread/state) shifts.
	const allSessions = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		sidebarSessionEquality
	);
	const sessions = useMemo(
		() => (scopeSessions ? scopeSessions(allSessions) : allSessions),
		[allSessions, scopeSessions]
	);
	const groups = useSessionStore((s) => s.groups);

	// PR-A 1.3: collapse what used to be four chained `useMemo`s
	// (worktreeChildrenByParentId → sortedWorktreeChildrenByParentId →
	// sortedSessionIndexById → getWorktreeChildren) into a single pass.
	// All four invalidate together when either `sessions` or `sortedSessions`
	// changes, so chaining gave us four cascading recomputations on every
	// session mutation. Computing them in one memo with a shared loop drops
	// the per-mutation render cost roughly in proportion to the number of
	// chained memos eliminated.
	//
	// See CLAUDE-PERFORMANCE.md§"Consolidate chained `useMemo` calls".
	const { worktreeChildrenByParentId, sortedWorktreeChildrenByParentId, sortedSessionIndexById } =
		useMemo(() => {
			const childMap = new Map<string, Session[]>();
			for (const session of sessions) {
				if (!session.parentSessionId) continue;
				const siblings = childMap.get(session.parentSessionId);
				if (siblings) {
					siblings.push(session);
				} else {
					childMap.set(session.parentSessionId, [session]);
				}
			}

			const sortedChildMap = new Map<string, Session[]>();
			for (const [parentId, children] of childMap) {
				sortedChildMap.set(
					parentId,
					[...children].sort((a, b) => compareSessionNames(a.name, b.name))
				);
			}

			const indexMap = new Map<string, number>();
			for (let i = 0; i < sortedSessions.length; i++) {
				indexMap.set(sortedSessions[i].id, i);
			}

			return {
				worktreeChildrenByParentId: childMap,
				sortedWorktreeChildrenByParentId: sortedChildMap,
				sortedSessionIndexById: indexMap,
			};
		}, [sessions, sortedSessions]);

	const getWorktreeChildren = useCallback(
		(parentId: string): Session[] => worktreeChildrenByParentId.get(parentId) || [],
		[worktreeChildrenByParentId]
	);

	// Consolidated session categorization and sorting - computed in a single pass
	const groupIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);

	// Stable Set of stuck (outage) agent ids, recomputed only when the signature
	// changes so the categorization memo isn't invalidated on unrelated renders.
	const stuckOutageSessionIds = useMemo(
		() => new Set(stuckOutageSignature ? stuckOutageSignature.split(',') : []),
		[stuckOutageSignature]
	);

	const sessionCategories = useMemo(() => {
		// Step 1: Filter sessions based on search query and unread filter
		const query = sessionFilter?.toLowerCase() ?? '';
		const filtered: Session[] = [];

		// Auto Run agents (the AUTO badge) sit between prompts in state 'idle', so
		// the busy/unread checks below would drop them. Keep them visible in the
		// unread filter using the same set that drives the badge.
		const batchSessionIds = new Set(activeBatchSessionIds);

		for (const s of sessions) {
			// Exclude worktree children from main list (they appear under parent)
			if (s.parentSessionId) continue;

			// Pianola is the pinned manager agent: it renders in its own top
			// section, never in Bookmarks/Groups/Ungrouped, so exclude it here.
			if (s.isPianola) continue;

			// Apply unread agents filter (also keep busy/working agents visible)
			// Always keep the active session (or its parent) visible so user doesn't lose their place
			const isActiveOrParentOfActive =
				s.id === activeSessionId ||
				worktreeChildrenByParentId.get(s.id)?.some((child) => child.id === activeSessionId);
			if (showUnreadAgentsOnly && !isActiveOrParentOfActive) {
				const hasUnread = s.aiTabs?.some((tab) => tab.hasUnread);
				const isBusy = s.state === 'busy';
				const isAutoRunning = batchSessionIds.has(s.id);
				// A stuck (auto-retrying) agent needs attention just like an unread
				// one, so keep it visible under the unread filter.
				const isStuck = stuckOutageSessionIds.has(s.id);
				// Also check if any worktree children have unread, are busy, are
				// auto-running, or are stuck in an outage.
				const children = worktreeChildrenByParentId.get(s.id);
				const hasActiveChildren = children?.some(
					(child) =>
						child.aiTabs?.some((tab) => tab.hasUnread) ||
						child.state === 'busy' ||
						batchSessionIds.has(child.id) ||
						stuckOutageSessionIds.has(child.id)
				);
				if (!hasUnread && !isBusy && !isAutoRunning && !isStuck && !hasActiveChildren) continue;
			}

			if (!query) {
				filtered.push(s);
			} else {
				// Match session name
				if (s.name.toLowerCase().includes(query)) {
					filtered.push(s);
					continue;
				}
				// Match any AI tab name
				if (s.aiTabs?.some((tab) => tab.name?.toLowerCase().includes(query))) {
					filtered.push(s);
					continue;
				}
				// Match worktree children branch names
				const worktreeChildren = worktreeChildrenByParentId.get(s.id);
				if (
					worktreeChildren?.some(
						(child) =>
							child.worktreeBranch?.toLowerCase().includes(query) ||
							child.name.toLowerCase().includes(query)
					)
				) {
					filtered.push(s);
				}
			}
		}

		// Step 2: Categorize sessions in a single pass
		const bookmarked: Session[] = [];
		const ungrouped: Session[] = [];
		const groupedMap = new Map<string, Session[]>();

		for (const s of filtered) {
			if (s.bookmarked) {
				bookmarked.push(s);
			}
			if (s.groupId && groupIds.has(s.groupId)) {
				const list = groupedMap.get(s.groupId);
				if (list) {
					list.push(s);
				} else {
					groupedMap.set(s.groupId, [s]);
				}
			} else {
				ungrouped.push(s);
			}
		}

		// Step 3: Sort each category once
		const sortFn = (a: Session, b: Session) => compareSessionNames(a.name, b.name);

		const sortedFiltered = [...filtered].sort(sortFn);
		const sortedBookmarked = [...bookmarked].sort(sortFn);
		const sortedBookmarkedParent = bookmarked.filter((s) => !s.parentSessionId).sort(sortFn);
		const sortedUngrouped = [...ungrouped].sort(sortFn);
		const sortedUngroupedParent = ungrouped.filter((s) => !s.parentSessionId).sort(sortFn);

		// Sort sessions within each group
		const sortedGrouped = new Map<string, Session[]>();
		groupedMap.forEach((groupSessions, groupId) => {
			sortedGrouped.set(groupId, [...groupSessions].sort(sortFn));
		});

		return {
			filtered,
			bookmarked,
			ungrouped,
			groupedMap,
			sortedFiltered,
			sortedBookmarked,
			sortedBookmarkedParent,
			sortedUngrouped,
			sortedUngroupedParent,
			sortedGrouped,
		};
	}, [
		sessionFilter,
		showUnreadAgentsOnly,
		activeSessionId,
		activeBatchSessionIds,
		sessions,
		worktreeChildrenByParentId,
		groupIds,
		stuckOutageSessionIds,
	]);

	const sortedGroups = useMemo(
		() => [...groups].sort((a, b) => compareSessionNames(a.name, b.name)),
		[groups]
	);

	return {
		worktreeChildrenByParentId,
		sortedWorktreeChildrenByParentId,
		sortedSessionIndexById,
		getWorktreeChildren,
		bookmarkedSessions: sessionCategories.bookmarked,
		sortedBookmarkedSessions: sessionCategories.sortedBookmarked,
		sortedBookmarkedParentSessions: sessionCategories.sortedBookmarkedParent,
		sortedGroupSessionsById: sessionCategories.sortedGrouped,
		ungroupedSessions: sessionCategories.ungrouped,
		sortedUngroupedSessions: sessionCategories.sortedUngrouped,
		sortedUngroupedParentSessions: sessionCategories.sortedUngroupedParent,
		sortedFilteredSessions: sessionCategories.sortedFiltered,
		sortedGroups,
	};
}
