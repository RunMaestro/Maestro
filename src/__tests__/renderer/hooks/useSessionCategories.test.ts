import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionCategories } from '../../../renderer/hooks/session/useSessionCategories';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, Group } from '../../../renderer/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function makeSession(overrides: Partial<Session> = {}): Session {
	idCounter++;
	return {
		id: `s${idCounter}`,
		name: `Session ${idCounter}`,
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		...overrides,
	} as Session;
}

function makeGroup(overrides: Partial<Group> = {}): Group {
	idCounter++;
	return {
		id: `g${idCounter}`,
		name: `Group ${idCounter}`,
		emoji: '📁',
		collapsed: false,
		...overrides,
	};
}

function resetStore(sessions: Session[] = [], groups: Group[] = []) {
	useSessionStore.setState({ sessions, groups } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSessionCategories', () => {
	beforeEach(() => {
		idCounter = 0;
		resetStore();
	});

	// -----------------------------------------------------------------------
	// Empty state
	// -----------------------------------------------------------------------
	describe('empty state', () => {
		it('returns empty collections when no sessions exist', () => {
			const { result } = renderHook(() => useSessionCategories('', []));

			expect(result.current.worktreeChildrenByParentId.size).toBe(0);
			expect(result.current.sortedWorktreeChildrenByParentId.size).toBe(0);
			expect(result.current.sortedSessionIndexById.size).toBe(0);
			expect(result.current.bookmarkedSessions).toEqual([]);
			expect(result.current.ungroupedSessions).toEqual([]);
			expect(result.current.sortedFilteredSessions).toEqual([]);
			expect(result.current.sortedGroups).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	// Worktree hierarchy
	// -----------------------------------------------------------------------
	describe('worktree hierarchy', () => {
		it('maps worktree children to parent IDs', () => {
			const parent = makeSession({ id: 'parent' });
			const child1 = makeSession({ id: 'child1', name: 'Branch A', parentSessionId: 'parent' });
			const child2 = makeSession({ id: 'child2', name: 'Branch B', parentSessionId: 'parent' });
			resetStore([parent, child1, child2]);

			const { result } = renderHook(() => useSessionCategories('', [parent]));

			const children = result.current.worktreeChildrenByParentId.get('parent');
			expect(children).toHaveLength(2);
			expect(children!.map((c) => c.id)).toContain('child1');
			expect(children!.map((c) => c.id)).toContain('child2');
		});

		it('sorts worktree children alphabetically ignoring emojis', () => {
			const parent = makeSession({ id: 'parent' });
			const childZ = makeSession({ id: 'cz', name: '🔥 Zulu', parentSessionId: 'parent' });
			const childA = makeSession({ id: 'ca', name: '🌟 Alpha', parentSessionId: 'parent' });
			resetStore([parent, childZ, childA]);

			const { result } = renderHook(() => useSessionCategories('', [parent]));

			const sorted = result.current.sortedWorktreeChildrenByParentId.get('parent')!;
			expect(sorted[0].id).toBe('ca'); // Alpha before Zulu
			expect(sorted[1].id).toBe('cz');
		});

		it('getWorktreeChildren returns children for a parent', () => {
			const parent = makeSession({ id: 'p1' });
			const child = makeSession({ id: 'c1', parentSessionId: 'p1' });
			resetStore([parent, child]);

			const { result } = renderHook(() => useSessionCategories('', [parent]));

			expect(result.current.getWorktreeChildren('p1')).toHaveLength(1);
			expect(result.current.getWorktreeChildren('p1')[0].id).toBe('c1');
		});

		it('getWorktreeChildren returns empty array for unknown parent', () => {
			const { result } = renderHook(() => useSessionCategories('', []));
			expect(result.current.getWorktreeChildren('nonexistent')).toEqual([]);
		});

		it('excludes worktree children from categorized lists', () => {
			const parent = makeSession({ id: 'parent', name: 'Parent' });
			const child = makeSession({ id: 'child', name: 'Child', parentSessionId: 'parent' });
			resetStore([parent, child]);

			const { result } = renderHook(() => useSessionCategories('', [parent, child]));

			// Only the parent should appear in ungrouped/filtered
			expect(result.current.ungroupedSessions).toHaveLength(1);
			expect(result.current.ungroupedSessions[0].id).toBe('parent');
			expect(result.current.sortedFilteredSessions).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// Session index
	// -----------------------------------------------------------------------
	describe('sortedSessionIndexById', () => {
		it('maps session IDs to their index in sortedSessions', () => {
			const s1 = makeSession({ id: 'a' });
			const s2 = makeSession({ id: 'b' });
			const s3 = makeSession({ id: 'c' });
			resetStore([s1, s2, s3]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2, s3]));

			expect(result.current.sortedSessionIndexById.get('a')).toBe(0);
			expect(result.current.sortedSessionIndexById.get('b')).toBe(1);
			expect(result.current.sortedSessionIndexById.get('c')).toBe(2);
		});
	});

	// -----------------------------------------------------------------------
	// Filtering
	// -----------------------------------------------------------------------
	describe('filtering', () => {
		it('returns all parent sessions when filter is empty', () => {
			const s1 = makeSession({ name: 'Alpha' });
			const s2 = makeSession({ name: 'Beta' });
			resetStore([s1, s2]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2]));

			expect(result.current.sortedFilteredSessions).toHaveLength(2);
		});

		it('filters by session name (case-insensitive)', () => {
			const s1 = makeSession({ name: 'Frontend Work' });
			const s2 = makeSession({ name: 'Backend API' });
			resetStore([s1, s2]);

			const { result } = renderHook(() => useSessionCategories('front', [s1, s2]));

			expect(result.current.sortedFilteredSessions).toHaveLength(1);
			expect(result.current.sortedFilteredSessions[0].name).toBe('Frontend Work');
		});

		it('filters by AI tab name', () => {
			const s1 = makeSession({
				name: 'Agent 1',
				aiTabs: [{ name: 'refactoring-task' } as any],
			});
			const s2 = makeSession({ name: 'Agent 2' });
			resetStore([s1, s2]);

			const { result } = renderHook(() => useSessionCategories('refactoring', [s1, s2]));

			expect(result.current.sortedFilteredSessions).toHaveLength(1);
			expect(result.current.sortedFilteredSessions[0].name).toBe('Agent 1');
		});

		it('filters by worktree child branch name', () => {
			const parent = makeSession({ id: 'p1', name: 'Main Agent' });
			const child = makeSession({
				id: 'c1',
				name: 'Worktree',
				parentSessionId: 'p1',
				worktreeBranch: 'feature/dark-mode',
			});
			resetStore([parent, child]);

			const { result } = renderHook(() => useSessionCategories('dark-mode', [parent]));

			// Parent should match because its child's branch matches
			expect(result.current.sortedFilteredSessions).toHaveLength(1);
			expect(result.current.sortedFilteredSessions[0].id).toBe('p1');
		});

		it('filters by worktree child name', () => {
			const parent = makeSession({ id: 'p1', name: 'Main Agent' });
			const child = makeSession({
				id: 'c1',
				name: 'Dark Mode Feature',
				parentSessionId: 'p1',
			});
			resetStore([parent, child]);

			const { result } = renderHook(() => useSessionCategories('dark mode', [parent]));

			expect(result.current.sortedFilteredSessions).toHaveLength(1);
			expect(result.current.sortedFilteredSessions[0].id).toBe('p1');
		});

		it('returns empty when nothing matches', () => {
			const s1 = makeSession({ name: 'Alpha' });
			resetStore([s1]);

			const { result } = renderHook(() => useSessionCategories('zzzzz', [s1]));

			expect(result.current.sortedFilteredSessions).toEqual([]);
			expect(result.current.ungroupedSessions).toEqual([]);
			expect(result.current.bookmarkedSessions).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	// Unread agents filter
	// -----------------------------------------------------------------------
	describe('showUnreadAgentsOnly', () => {
		it('returns all sessions when showUnreadAgentsOnly is false', () => {
			const s1 = makeSession({ name: 'Alpha' });
			const s2 = makeSession({ name: 'Beta' });
			resetStore([s1, s2]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2], false));
			expect(result.current.sortedFilteredSessions).toHaveLength(2);
		});

		it('filters to only sessions with unread tabs when showUnreadAgentsOnly is true', () => {
			const s1 = makeSession({
				name: 'Has Unread',
				aiTabs: [{ id: 't1', hasUnread: true } as any],
			});
			const s2 = makeSession({
				name: 'No Unread',
				aiTabs: [{ id: 't2', hasUnread: false } as any],
			});
			const s3 = makeSession({ name: 'No Tabs' });
			resetStore([s1, s2, s3]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2, s3], true));

			expect(result.current.sortedFilteredSessions).toHaveLength(1);
			expect(result.current.sortedFilteredSessions[0].name).toBe('Has Unread');
		});

		it('includes busy agents even without unread tabs when showUnreadAgentsOnly is true', () => {
			const s1 = makeSession({
				name: 'Has Unread',
				aiTabs: [{ id: 't1', hasUnread: true } as any],
			});
			const s2 = makeSession({
				name: 'Busy Agent',
				state: 'busy',
				aiTabs: [{ id: 't2', hasUnread: false } as any],
			});
			const s3 = makeSession({ name: 'Idle No Unread' });
			resetStore([s1, s2, s3]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2, s3], true));

			expect(result.current.sortedFilteredSessions).toHaveLength(2);
			const names = result.current.sortedFilteredSessions.map((s) => s.name);
			expect(names).toContain('Has Unread');
			expect(names).toContain('Busy Agent');
		});

		it('keeps parent visible when active session is a worktree child without unread', () => {
			const parent = makeSession({ name: 'Parent' });
			const child = makeSession({
				name: 'Worktree Child',
				parentSessionId: parent.id,
				aiTabs: [{ id: 't1', hasUnread: false } as any],
			});
			resetStore([parent, child]);

			const { result } = renderHook(() =>
				useSessionCategories('', [parent, child], true, child.id)
			);

			expect(result.current.sortedFilteredSessions).toHaveLength(1);
			expect(result.current.sortedFilteredSessions[0].name).toBe('Parent');
		});

		it('combines unread filter with text filter', () => {
			const s1 = makeSession({
				name: 'Frontend',
				aiTabs: [{ id: 't1', hasUnread: true } as any],
			});
			const s2 = makeSession({
				name: 'Backend',
				aiTabs: [{ id: 't2', hasUnread: true } as any],
			});
			resetStore([s1, s2]);

			const { result } = renderHook(() => useSessionCategories('front', [s1, s2], true));

			expect(result.current.sortedFilteredSessions).toHaveLength(1);
			expect(result.current.sortedFilteredSessions[0].name).toBe('Frontend');
		});
	});

	// -----------------------------------------------------------------------
	// Categorization: bookmarked
	// -----------------------------------------------------------------------
	describe('bookmarked sessions', () => {
		it('separates bookmarked sessions', () => {
			const s1 = makeSession({ name: 'Alpha', bookmarked: true });
			const s2 = makeSession({ name: 'Beta' });
			const s3 = makeSession({ name: 'Gamma', bookmarked: true });
			resetStore([s1, s2, s3]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2, s3]));

			expect(result.current.bookmarkedSessions).toHaveLength(2);
			expect(result.current.bookmarkedSessions.map((s) => s.name)).toContain('Alpha');
			expect(result.current.bookmarkedSessions.map((s) => s.name)).toContain('Gamma');
		});

		it('sorts bookmarked sessions alphabetically', () => {
			const s1 = makeSession({ name: 'Zulu', bookmarked: true });
			const s2 = makeSession({ name: 'Alpha', bookmarked: true });
			resetStore([s1, s2]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2]));

			expect(result.current.sortedBookmarkedSessions[0].name).toBe('Alpha');
			expect(result.current.sortedBookmarkedSessions[1].name).toBe('Zulu');
		});

		it('sortedBookmarkedParentSessions excludes worktree children', () => {
			const parent = makeSession({ name: 'Parent', bookmarked: true });
			// Worktree child that is also bookmarked — should be excluded from parent list
			// (In practice children can't be bookmarked, but the filter should still work)
			resetStore([parent]);

			const { result } = renderHook(() => useSessionCategories('', [parent]));

			expect(result.current.sortedBookmarkedParentSessions).toHaveLength(1);
			expect(result.current.sortedBookmarkedParentSessions[0].name).toBe('Parent');
		});

		it('bookmarked session also appears in grouped or ungrouped', () => {
			const s1 = makeSession({ name: 'Alpha', bookmarked: true, groupId: 'g1' });
			const group = makeGroup({ id: 'g1', name: 'My Group' });
			resetStore([s1], [group]);

			const { result } = renderHook(() => useSessionCategories('', [s1]));

			expect(result.current.bookmarkedSessions).toHaveLength(1);
			// Also in grouped
			expect(result.current.sortedGroupSessionsById.get('g1')).toHaveLength(1);
			// Not in ungrouped
			expect(result.current.ungroupedSessions).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// Categorization: groups
	// -----------------------------------------------------------------------
	describe('grouped sessions', () => {
		it('assigns sessions to groups by groupId', () => {
			const g1 = makeGroup({ id: 'g1', name: 'Frontend' });
			const g2 = makeGroup({ id: 'g2', name: 'Backend' });
			const s1 = makeSession({ name: 'React', groupId: 'g1' });
			const s2 = makeSession({ name: 'Node', groupId: 'g2' });
			const s3 = makeSession({ name: 'Go', groupId: 'g2' });
			resetStore([s1, s2, s3], [g1, g2]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2, s3]));

			expect(result.current.sortedGroupSessionsById.get('g1')).toHaveLength(1);
			expect(result.current.sortedGroupSessionsById.get('g2')).toHaveLength(2);
		});

		it('sorts sessions within each group alphabetically', () => {
			const g1 = makeGroup({ id: 'g1' });
			const s1 = makeSession({ name: 'Zeta', groupId: 'g1' });
			const s2 = makeSession({ name: 'Alpha', groupId: 'g1' });
			resetStore([s1, s2], [g1]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2]));

			const groupSessions = result.current.sortedGroupSessionsById.get('g1')!;
			expect(groupSessions[0].name).toBe('Alpha');
			expect(groupSessions[1].name).toBe('Zeta');
		});
	});

	// -----------------------------------------------------------------------
	// Categorization: ungrouped
	// -----------------------------------------------------------------------
	describe('ungrouped sessions', () => {
		it('sessions without groupId go to ungrouped', () => {
			const s1 = makeSession({ name: 'Alpha' });
			const s2 = makeSession({ name: 'Beta', groupId: 'g1' });
			const s3 = makeSession({ name: 'Gamma' });
			const g1 = makeGroup({ id: 'g1' });
			resetStore([s1, s2, s3], [g1]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2, s3]));

			expect(result.current.ungroupedSessions).toHaveLength(2);
			expect(result.current.ungroupedSessions.map((s) => s.name)).toContain('Alpha');
			expect(result.current.ungroupedSessions.map((s) => s.name)).toContain('Gamma');
		});

		it('sorts ungrouped sessions alphabetically', () => {
			const s1 = makeSession({ name: 'Zulu' });
			const s2 = makeSession({ name: 'Alpha' });
			resetStore([s1, s2]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2]));

			expect(result.current.sortedUngroupedSessions[0].name).toBe('Alpha');
			expect(result.current.sortedUngroupedSessions[1].name).toBe('Zulu');
		});

		it('sortedUngroupedParentSessions excludes worktree children', () => {
			const s1 = makeSession({ name: 'Parent' });
			// Worktree child without groupId — excluded from parent list by parentSessionId filter
			resetStore([s1]);

			const { result } = renderHook(() => useSessionCategories('', [s1]));

			expect(result.current.sortedUngroupedParentSessions).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// Sorting: groups
	// -----------------------------------------------------------------------
	describe('sortedGroups', () => {
		it('sorts groups alphabetically ignoring emojis', () => {
			const g1 = makeGroup({ name: '🔥 Zulu' });
			const g2 = makeGroup({ name: '🌟 Alpha' });
			const g3 = makeGroup({ name: 'Beta' });
			resetStore([], [g1, g2, g3]);

			const { result } = renderHook(() => useSessionCategories('', []));

			expect(result.current.sortedGroups[0].name).toBe('🌟 Alpha');
			expect(result.current.sortedGroups[1].name).toBe('Beta');
			expect(result.current.sortedGroups[2].name).toBe('🔥 Zulu');
		});
	});

	// -----------------------------------------------------------------------
	// Sorting: filtered sessions
	// -----------------------------------------------------------------------
	describe('sortedFilteredSessions', () => {
		it('sorts all filtered sessions alphabetically', () => {
			const s1 = makeSession({ name: 'Zulu' });
			const s2 = makeSession({ name: 'Alpha' });
			const s3 = makeSession({ name: 'Mike' });
			resetStore([s1, s2, s3]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2, s3]));

			expect(result.current.sortedFilteredSessions.map((s) => s.name)).toEqual([
				'Alpha',
				'Mike',
				'Zulu',
			]);
		});

		it('only includes matching sessions when filter is active', () => {
			const s1 = makeSession({ name: 'Alpha API' });
			const s2 = makeSession({ name: 'Beta UI' });
			const s3 = makeSession({ name: 'Gamma API' });
			resetStore([s1, s2, s3]);

			const { result } = renderHook(() => useSessionCategories('api', [s1, s2, s3]));

			expect(result.current.sortedFilteredSessions).toHaveLength(2);
			expect(result.current.sortedFilteredSessions[0].name).toBe('Alpha API');
			expect(result.current.sortedFilteredSessions[1].name).toBe('Gamma API');
		});
	});

	// -----------------------------------------------------------------------
	// Combined scenarios
	// -----------------------------------------------------------------------
	describe('combined scenarios', () => {
		it('handles sessions that are both bookmarked and grouped', () => {
			const g1 = makeGroup({ id: 'g1', name: 'My Group' });
			const s1 = makeSession({ name: 'Both', bookmarked: true, groupId: 'g1' });
			const s2 = makeSession({ name: 'Just Ungrouped' });
			resetStore([s1, s2], [g1]);

			const { result } = renderHook(() => useSessionCategories('', [s1, s2]));

			// In bookmarked
			expect(result.current.bookmarkedSessions).toHaveLength(1);
			// In grouped
			expect(result.current.sortedGroupSessionsById.get('g1')).toHaveLength(1);
			// Not in ungrouped
			expect(result.current.ungroupedSessions).toHaveLength(1);
			expect(result.current.ungroupedSessions[0].name).toBe('Just Ungrouped');
		});

		it('filtering interacts with categorization correctly', () => {
			const g1 = makeGroup({ id: 'g1', name: 'API' });
			const s1 = makeSession({ name: 'API Work', groupId: 'g1', bookmarked: true });
			const s2 = makeSession({ name: 'UI Work' });
			const s3 = makeSession({ name: 'API Tests', groupId: 'g1' });
			resetStore([s1, s2, s3], [g1]);

			const { result } = renderHook(() => useSessionCategories('api', [s1, s2, s3]));

			// Only API-matching sessions
			expect(result.current.sortedFilteredSessions).toHaveLength(2);
			expect(result.current.bookmarkedSessions).toHaveLength(1);
			expect(result.current.sortedGroupSessionsById.get('g1')).toHaveLength(2);
			expect(result.current.ungroupedSessions).toHaveLength(0);
		});

		it('worktree parents with matching children are included in filter', () => {
			const parent1 = makeSession({ id: 'p1', name: 'Main Agent' });
			const child1 = makeSession({
				id: 'c1',
				name: 'Feature Branch',
				parentSessionId: 'p1',
				worktreeBranch: 'feat/authentication',
			});
			const parent2 = makeSession({ id: 'p2', name: 'Other Agent' });
			resetStore([parent1, child1, parent2]);

			const { result } = renderHook(() => useSessionCategories('auth', [parent1, parent2]));

			// parent1 matches via child's branch, parent2 doesn't match
			expect(result.current.sortedFilteredSessions).toHaveLength(1);
			expect(result.current.sortedFilteredSessions[0].id).toBe('p1');
		});

		it('handles large number of sessions efficiently', () => {
			const sessions: Session[] = [];
			for (let i = 0; i < 100; i++) {
				sessions.push(
					makeSession({
						name: `Session ${String(i).padStart(3, '0')}`,
						bookmarked: i % 10 === 0,
						groupId: i % 3 === 0 ? 'g1' : undefined,
					})
				);
			}
			const g1 = makeGroup({ id: 'g1', name: 'Group 1' });
			resetStore(sessions, [g1]);

			const { result } = renderHook(() => useSessionCategories('', sessions));

			// 10 bookmarked (every 10th)
			expect(result.current.bookmarkedSessions).toHaveLength(10);
			// 34 grouped (every 3rd: 0,3,6,...,99 = 34)
			expect(result.current.sortedGroupSessionsById.get('g1')!.length).toBe(34);
			// 66 ungrouped
			expect(result.current.ungroupedSessions).toHaveLength(66);
			// All 100 in filtered
			expect(result.current.sortedFilteredSessions).toHaveLength(100);
		});
	});

	// -----------------------------------------------------------------------
	// Deep-equal lock-in for memo-cascade refactor
	//
	// PR-A commit 5 will collapse the four chained `useMemo`s
	// (worktreeChildrenByParentId → sortedWorktreeChildrenByParentId →
	// sortedSessionIndexById → getWorktreeChildren) into a single pass.
	// These tests pin down the exact output shape for a representative
	// fixture so the refactor is verified to produce identical results.
	// -----------------------------------------------------------------------
	describe('memo-cascade lock-in (PR-A 1.3)', () => {
		function buildFixture() {
			// 2 worktree parents, each with 2 children
			const parentA = makeSession({ id: 'pa', name: '🌟 Alpha Parent' });
			const childA1 = makeSession({
				id: 'pa-c1',
				name: '🌟 Branch Zeta',
				parentSessionId: 'pa',
			});
			const childA2 = makeSession({
				id: 'pa-c2',
				name: '🔥 Branch Aurora',
				parentSessionId: 'pa',
			});
			const parentB = makeSession({ id: 'pb', name: 'Bravo Parent', groupId: 'g1' });
			const childB1 = makeSession({
				id: 'pb-c1',
				name: 'Branch X',
				parentSessionId: 'pb',
			});
			const childB2 = makeSession({
				id: 'pb-c2',
				name: 'Branch Y',
				parentSessionId: 'pb',
			});
			// Standalone sessions: bookmarked, grouped, ungrouped
			const bookmark1 = makeSession({ id: 'b1', name: 'Bookmark 1', bookmarked: true });
			const grouped1 = makeSession({ id: 'gr1', name: 'Grouped 1', groupId: 'g1' });
			const ungrouped1 = makeSession({ id: 'u1', name: 'Ungrouped 1' });
			const ungrouped2 = makeSession({ id: 'u2', name: 'Ungrouped 2' });

			const allSessions = [
				parentA,
				childA1,
				childA2,
				parentB,
				childB1,
				childB2,
				bookmark1,
				grouped1,
				ungrouped1,
				ungrouped2,
			];
			// Top-level sessions only (sortedSessions excludes worktree children)
			const sortedSessions = [parentA, parentB, bookmark1, grouped1, ungrouped1, ungrouped2];
			const groups = [makeGroup({ id: 'g1', name: 'Group One' })];
			return { allSessions, sortedSessions, groups };
		}

		it('produces stable worktreeChildrenByParentId for the fixture', () => {
			const fx = buildFixture();
			resetStore(fx.allSessions, fx.groups);
			const { result } = renderHook(() => useSessionCategories('', fx.sortedSessions));

			const map = result.current.worktreeChildrenByParentId;
			expect(map.size).toBe(2);
			expect(
				map
					.get('pa')!
					.map((c) => c.id)
					.sort()
			).toEqual(['pa-c1', 'pa-c2']);
			expect(
				map
					.get('pb')!
					.map((c) => c.id)
					.sort()
			).toEqual(['pb-c1', 'pb-c2']);
		});

		it('produces stable sortedWorktreeChildrenByParentId for the fixture', () => {
			const fx = buildFixture();
			resetStore(fx.allSessions, fx.groups);
			const { result } = renderHook(() => useSessionCategories('', fx.sortedSessions));

			const map = result.current.sortedWorktreeChildrenByParentId;
			// Aurora < Zeta (sort ignores emojis)
			expect(map.get('pa')!.map((c) => c.id)).toEqual(['pa-c2', 'pa-c1']);
			// X < Y (alphabetical)
			expect(map.get('pb')!.map((c) => c.id)).toEqual(['pb-c1', 'pb-c2']);
		});

		it('produces stable sortedSessionIndexById for the fixture', () => {
			const fx = buildFixture();
			resetStore(fx.allSessions, fx.groups);
			const { result } = renderHook(() => useSessionCategories('', fx.sortedSessions));

			const map = result.current.sortedSessionIndexById;
			expect(map.size).toBe(fx.sortedSessions.length);
			fx.sortedSessions.forEach((s, i) => {
				expect(map.get(s.id)).toBe(i);
			});
			// Ids not in sortedSessions should not be in the index map
			expect(map.has('pa-c1')).toBe(false);
			expect(map.has('pa-c2')).toBe(false);
		});

		it('getWorktreeChildren returns the SAME array reference as map lookup', () => {
			const fx = buildFixture();
			resetStore(fx.allSessions, fx.groups);
			const { result } = renderHook(() => useSessionCategories('', fx.sortedSessions));

			// Identity (toBe), not deep-equal (toEqual): consumers may
			// memoize on this reference. If a future change accidentally
			// returns a clone instead of the original, dependent useMemo /
			// React.memo bail-outs would silently break.
			expect(result.current.getWorktreeChildren('pa')).toBe(
				result.current.worktreeChildrenByParentId.get('pa')
			);
			expect(result.current.getWorktreeChildren('pb')).toBe(
				result.current.worktreeChildrenByParentId.get('pb')
			);
			// Unknown parent: caller-side fallback to a fresh [] each call,
			// so identity does not hold here — content equality is the
			// right contract.
			expect(result.current.getWorktreeChildren('nonexistent')).toEqual([]);
		});

		it('reference identity holds across renders when sessions array does not change', () => {
			const fx = buildFixture();
			resetStore(fx.allSessions, fx.groups);
			const { result, rerender } = renderHook(() => useSessionCategories('', fx.sortedSessions));

			const firstRun = {
				worktreeChildrenByParentId: result.current.worktreeChildrenByParentId,
				sortedWorktreeChildrenByParentId: result.current.sortedWorktreeChildrenByParentId,
				sortedSessionIndexById: result.current.sortedSessionIndexById,
				getWorktreeChildren: result.current.getWorktreeChildren,
			};

			rerender();

			// Sessions reference unchanged → memo outputs must be reference-stable.
			expect(result.current.worktreeChildrenByParentId).toBe(firstRun.worktreeChildrenByParentId);
			expect(result.current.sortedWorktreeChildrenByParentId).toBe(
				firstRun.sortedWorktreeChildrenByParentId
			);
			expect(result.current.sortedSessionIndexById).toBe(firstRun.sortedSessionIndexById);
			expect(result.current.getWorktreeChildren).toBe(firstRun.getWorktreeChildren);
		});
	});
});
