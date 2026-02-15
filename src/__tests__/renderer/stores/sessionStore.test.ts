import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useSessionStore,
	selectActiveSession,
	selectSessionById,
	selectBookmarkedSessions,
	selectSessionsByGroup,
	selectUngroupedSessions,
	selectGroupById,
	selectSessionCount,
	selectIsReady,
	selectIsAnySessionBusy,
	getSessionState,
	getSessionActions,
} from '../../../renderer/stores/sessionStore';
import type { Session, Group, FilePreviewTab } from '../../../renderer/types';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a minimal mock session for testing.
 * Only includes required fields — extend as needed per test.
 */
function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: overrides.id ?? `session-${Math.random().toString(36).slice(2, 8)}`,
		name: overrides.name ?? 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
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
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

/**
 * Create a minimal mock FilePreviewTab for testing.
 */
function createMockFilePreviewTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: overrides.id ?? `file-tab-${Math.random().toString(36).slice(2, 8)}`,
		path: overrides.path ?? '/test/file.ts',
		name: overrides.name ?? 'file',
		extension: overrides.extension ?? '.ts',
		content: overrides.content ?? 'console.log("test");',
		scrollTop: overrides.scrollTop ?? 0,
		searchQuery: overrides.searchQuery ?? '',
		editMode: overrides.editMode ?? false,
		editContent: overrides.editContent ?? undefined,
		createdAt: overrides.createdAt ?? Date.now(),
		lastModified: overrides.lastModified ?? Date.now(),
		sshRemoteId: overrides.sshRemoteId,
		isLoading: overrides.isLoading,
	};
}

function createMockGroup(overrides: Partial<Group> = {}): Group {
	return {
		id: overrides.id ?? `group-${Math.random().toString(36).slice(2, 8)}`,
		name: overrides.name ?? 'Test Group',
		emoji: overrides.emoji ?? '📁',
		collapsed: overrides.collapsed ?? false,
	};
}

/**
 * Reset the Zustand store to initial state between tests.
 * Zustand stores are singletons, so state persists across tests unless explicitly reset.
 */
function resetStore() {
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
		cyclePosition: -1,
	});
}

// ============================================================================
// Tests
// ============================================================================

describe('sessionStore', () => {
	beforeEach(() => {
		resetStore();
	});

	// ========================================================================
	// Initial State
	// ========================================================================

	describe('initial state', () => {
		it('has correct default values', () => {
			const state = useSessionStore.getState();

			expect(state.sessions).toEqual([]);
			expect(state.groups).toEqual([]);
			expect(state.activeSessionId).toBe('');
			expect(state.sessionsLoaded).toBe(false);
			expect(state.initialLoadComplete).toBe(false);
			expect(state.removedWorktreePaths).toEqual(new Set());
			expect(state.cyclePosition).toBe(-1);
		});
	});

	// ========================================================================
	// Session CRUD
	// ========================================================================

	describe('session CRUD', () => {
		it('sets sessions with a direct value', () => {
			const sessions = [createMockSession({ id: 'a' }), createMockSession({ id: 'b' })];
			useSessionStore.getState().setSessions(sessions);
			expect(useSessionStore.getState().sessions).toEqual(sessions);
		});

		it('sets sessions with an updater function', () => {
			const session1 = createMockSession({ id: 'a' });
			useSessionStore.getState().setSessions([session1]);

			const session2 = createMockSession({ id: 'b' });
			useSessionStore.getState().setSessions((prev) => [...prev, session2]);

			expect(useSessionStore.getState().sessions).toHaveLength(2);
			expect(useSessionStore.getState().sessions[0].id).toBe('a');
			expect(useSessionStore.getState().sessions[1].id).toBe('b');
		});

		it('skips no-op setSessions when same reference returned', () => {
			const sessions = [createMockSession({ id: 'a' })];
			useSessionStore.getState().setSessions(sessions);

			const stateBefore = useSessionStore.getState();
			useSessionStore.getState().setSessions((prev) => prev); // no-op
			const stateAfter = useSessionStore.getState();

			// Same reference means state object didn't change
			expect(stateAfter.sessions).toBe(stateBefore.sessions);
		});

		it('adds a session', () => {
			const session = createMockSession({ id: 'new' });
			useSessionStore.getState().addSession(session);

			expect(useSessionStore.getState().sessions).toHaveLength(1);
			expect(useSessionStore.getState().sessions[0].id).toBe('new');
		});

		it('adds multiple sessions', () => {
			useSessionStore.getState().addSession(createMockSession({ id: 'a' }));
			useSessionStore.getState().addSession(createMockSession({ id: 'b' }));
			useSessionStore.getState().addSession(createMockSession({ id: 'c' }));

			expect(useSessionStore.getState().sessions).toHaveLength(3);
		});

		it('removes a session by ID', () => {
			useSessionStore
				.getState()
				.setSessions([
					createMockSession({ id: 'a' }),
					createMockSession({ id: 'b' }),
					createMockSession({ id: 'c' }),
				]);

			useSessionStore.getState().removeSession('b');

			const ids = useSessionStore.getState().sessions.map((s) => s.id);
			expect(ids).toEqual(['a', 'c']);
		});

		it('skips removeSession if ID not found', () => {
			const sessions = [createMockSession({ id: 'a' })];
			useSessionStore.getState().setSessions(sessions);

			const stateBefore = useSessionStore.getState();
			useSessionStore.getState().removeSession('nonexistent');
			const stateAfter = useSessionStore.getState();

			expect(stateAfter.sessions).toBe(stateBefore.sessions);
		});

		it('updates a session by ID', () => {
			useSessionStore.getState().setSessions([createMockSession({ id: 'a', name: 'Original' })]);

			useSessionStore.getState().updateSession('a', { name: 'Updated' });

			expect(useSessionStore.getState().sessions[0].name).toBe('Updated');
		});

		it('updates only the targeted session', () => {
			useSessionStore
				.getState()
				.setSessions([
					createMockSession({ id: 'a', name: 'A' }),
					createMockSession({ id: 'b', name: 'B' }),
				]);

			useSessionStore.getState().updateSession('a', { name: 'A-updated' });

			expect(useSessionStore.getState().sessions[0].name).toBe('A-updated');
			expect(useSessionStore.getState().sessions[1].name).toBe('B');
		});

		it('skips updateSession if ID not found', () => {
			const sessions = [createMockSession({ id: 'a' })];
			useSessionStore.getState().setSessions(sessions);

			const stateBefore = useSessionStore.getState();
			useSessionStore.getState().updateSession('nonexistent', { name: 'x' });
			const stateAfter = useSessionStore.getState();

			expect(stateAfter.sessions).toBe(stateBefore.sessions);
		});
	});

	// ========================================================================
	// Active Session
	// ========================================================================

	describe('active session', () => {
		it('sets active session ID and resets cycle position', () => {
			useSessionStore.getState().setCyclePosition(5);
			useSessionStore.getState().setActiveSessionId('session-1');

			expect(useSessionStore.getState().activeSessionId).toBe('session-1');
			expect(useSessionStore.getState().cyclePosition).toBe(-1);
		});

		it('sets active session ID without resetting cycle (internal)', () => {
			useSessionStore.getState().setCyclePosition(5);
			useSessionStore.getState().setActiveSessionIdInternal('session-2');

			expect(useSessionStore.getState().activeSessionId).toBe('session-2');
			expect(useSessionStore.getState().cyclePosition).toBe(5); // preserved
		});

		it('sets active session ID with updater function (internal)', () => {
			useSessionStore.getState().setActiveSessionIdInternal('a');
			useSessionStore.getState().setActiveSessionIdInternal((prev) => prev + '-next');

			expect(useSessionStore.getState().activeSessionId).toBe('a-next');
		});
	});

	// ========================================================================
	// Groups
	// ========================================================================

	describe('groups', () => {
		it('sets groups with a direct value', () => {
			const groups = [createMockGroup({ id: 'g1' }), createMockGroup({ id: 'g2' })];
			useSessionStore.getState().setGroups(groups);

			expect(useSessionStore.getState().groups).toEqual(groups);
		});

		it('sets groups with an updater function', () => {
			useSessionStore.getState().setGroups([createMockGroup({ id: 'g1' })]);
			useSessionStore.getState().setGroups((prev) => [...prev, createMockGroup({ id: 'g2' })]);

			expect(useSessionStore.getState().groups).toHaveLength(2);
		});

		it('skips no-op setGroups when same reference returned', () => {
			const groups = [createMockGroup({ id: 'g1' })];
			useSessionStore.getState().setGroups(groups);

			const stateBefore = useSessionStore.getState();
			useSessionStore.getState().setGroups((prev) => prev);
			const stateAfter = useSessionStore.getState();

			expect(stateAfter.groups).toBe(stateBefore.groups);
		});

		it('adds a group', () => {
			useSessionStore.getState().addGroup(createMockGroup({ id: 'g1', name: 'My Group' }));

			expect(useSessionStore.getState().groups).toHaveLength(1);
			expect(useSessionStore.getState().groups[0].name).toBe('My Group');
		});

		it('removes a group by ID', () => {
			useSessionStore
				.getState()
				.setGroups([createMockGroup({ id: 'g1' }), createMockGroup({ id: 'g2' })]);

			useSessionStore.getState().removeGroup('g1');

			expect(useSessionStore.getState().groups).toHaveLength(1);
			expect(useSessionStore.getState().groups[0].id).toBe('g2');
		});

		it('skips removeGroup if ID not found', () => {
			const groups = [createMockGroup({ id: 'g1' })];
			useSessionStore.getState().setGroups(groups);

			const stateBefore = useSessionStore.getState();
			useSessionStore.getState().removeGroup('nonexistent');
			const stateAfter = useSessionStore.getState();

			expect(stateAfter.groups).toBe(stateBefore.groups);
		});

		it('updates a group by ID', () => {
			useSessionStore.getState().setGroups([createMockGroup({ id: 'g1', name: 'Old Name' })]);

			useSessionStore.getState().updateGroup('g1', { name: 'New Name' });

			expect(useSessionStore.getState().groups[0].name).toBe('New Name');
		});

		it('skips updateGroup if ID not found', () => {
			const groups = [createMockGroup({ id: 'g1' })];
			useSessionStore.getState().setGroups(groups);

			const stateBefore = useSessionStore.getState();
			useSessionStore.getState().updateGroup('nonexistent', { name: 'x' });
			const stateAfter = useSessionStore.getState();

			expect(stateAfter.groups).toBe(stateBefore.groups);
		});

		it('toggles group collapsed state', () => {
			useSessionStore.getState().setGroups([createMockGroup({ id: 'g1', collapsed: false })]);

			useSessionStore.getState().toggleGroupCollapsed('g1');
			expect(useSessionStore.getState().groups[0].collapsed).toBe(true);

			useSessionStore.getState().toggleGroupCollapsed('g1');
			expect(useSessionStore.getState().groups[0].collapsed).toBe(false);
		});
	});

	// ========================================================================
	// Initialization
	// ========================================================================

	describe('initialization', () => {
		it('sets sessions loaded', () => {
			useSessionStore.getState().setSessionsLoaded(true);
			expect(useSessionStore.getState().sessionsLoaded).toBe(true);
		});

		it('sets initial load complete', () => {
			useSessionStore.getState().setInitialLoadComplete(true);
			expect(useSessionStore.getState().initialLoadComplete).toBe(true);
		});
	});

	// ========================================================================
	// Bookmarks
	// ========================================================================

	describe('bookmarks', () => {
		it('toggles bookmark on a session', () => {
			useSessionStore.getState().setSessions([createMockSession({ id: 'a', bookmarked: false })]);

			useSessionStore.getState().toggleBookmark('a');
			expect(useSessionStore.getState().sessions[0].bookmarked).toBe(true);

			useSessionStore.getState().toggleBookmark('a');
			expect(useSessionStore.getState().sessions[0].bookmarked).toBe(false);
		});

		it('toggles bookmark only for the targeted session', () => {
			useSessionStore
				.getState()
				.setSessions([
					createMockSession({ id: 'a', bookmarked: false }),
					createMockSession({ id: 'b', bookmarked: true }),
				]);

			useSessionStore.getState().toggleBookmark('a');

			expect(useSessionStore.getState().sessions[0].bookmarked).toBe(true);
			expect(useSessionStore.getState().sessions[1].bookmarked).toBe(true); // unchanged
		});
	});

	// ========================================================================
	// Worktree Tracking
	// ========================================================================

	describe('worktree tracking', () => {
		it('adds a removed worktree path', () => {
			useSessionStore.getState().addRemovedWorktreePath('/path/to/worktree');

			expect(useSessionStore.getState().removedWorktreePaths.has('/path/to/worktree')).toBe(true);
		});

		it('accumulates multiple removed paths', () => {
			useSessionStore.getState().addRemovedWorktreePath('/path/a');
			useSessionStore.getState().addRemovedWorktreePath('/path/b');

			expect(useSessionStore.getState().removedWorktreePaths.size).toBe(2);
		});

		it('sets removed worktree paths with a direct value', () => {
			useSessionStore.getState().setRemovedWorktreePaths(new Set(['/a', '/b']));

			expect(useSessionStore.getState().removedWorktreePaths.size).toBe(2);
			expect(useSessionStore.getState().removedWorktreePaths.has('/a')).toBe(true);
		});

		it('sets removed worktree paths with an updater function', () => {
			useSessionStore.getState().addRemovedWorktreePath('/a');
			useSessionStore.getState().setRemovedWorktreePaths((prev) => {
				const next = new Set(prev);
				next.add('/b');
				return next;
			});

			expect(useSessionStore.getState().removedWorktreePaths.size).toBe(2);
		});
	});

	// ========================================================================
	// Navigation
	// ========================================================================

	describe('navigation', () => {
		it('sets cycle position', () => {
			useSessionStore.getState().setCyclePosition(3);
			expect(useSessionStore.getState().cyclePosition).toBe(3);
		});

		it('resets cycle position', () => {
			useSessionStore.getState().setCyclePosition(5);
			useSessionStore.getState().resetCyclePosition();
			expect(useSessionStore.getState().cyclePosition).toBe(-1);
		});
	});

	// ========================================================================
	// Selectors
	// ========================================================================

	describe('selectors', () => {
		describe('selectActiveSession', () => {
			it('returns the session matching activeSessionId', () => {
				const sessions = [
					createMockSession({ id: 'a', name: 'A' }),
					createMockSession({ id: 'b', name: 'B' }),
				];
				useSessionStore.getState().setSessions(sessions);
				useSessionStore.getState().setActiveSessionId('b');

				const active = selectActiveSession(useSessionStore.getState());
				expect(active?.id).toBe('b');
				expect(active?.name).toBe('B');
			});

			it('falls back to first session if activeSessionId not found', () => {
				const sessions = [createMockSession({ id: 'a', name: 'First' })];
				useSessionStore.getState().setSessions(sessions);
				useSessionStore.getState().setActiveSessionId('nonexistent');

				const active = selectActiveSession(useSessionStore.getState());
				expect(active?.id).toBe('a');
			});

			it('returns null when no sessions exist', () => {
				const active = selectActiveSession(useSessionStore.getState());
				expect(active).toBeNull();
			});
		});

		describe('selectSessionById', () => {
			it('returns the session with the given ID', () => {
				useSessionStore.getState().setSessions([createMockSession({ id: 'x', name: 'X' })]);

				const session = selectSessionById('x')(useSessionStore.getState());
				expect(session?.name).toBe('X');
			});

			it('returns undefined if not found', () => {
				const session = selectSessionById('nope')(useSessionStore.getState());
				expect(session).toBeUndefined();
			});
		});

		describe('selectBookmarkedSessions', () => {
			it('returns only bookmarked sessions', () => {
				useSessionStore
					.getState()
					.setSessions([
						createMockSession({ id: 'a', bookmarked: true }),
						createMockSession({ id: 'b', bookmarked: false }),
						createMockSession({ id: 'c', bookmarked: true }),
					]);

				const bookmarked = selectBookmarkedSessions(useSessionStore.getState());
				expect(bookmarked).toHaveLength(2);
				expect(bookmarked.map((s) => s.id)).toEqual(['a', 'c']);
			});

			it('returns empty array when none bookmarked', () => {
				useSessionStore.getState().setSessions([createMockSession({ id: 'a', bookmarked: false })]);

				expect(selectBookmarkedSessions(useSessionStore.getState())).toHaveLength(0);
			});
		});

		describe('selectSessionsByGroup', () => {
			it('returns sessions belonging to a group', () => {
				useSessionStore
					.getState()
					.setSessions([
						createMockSession({ id: 'a', groupId: 'g1' }),
						createMockSession({ id: 'b', groupId: 'g2' }),
						createMockSession({ id: 'c', groupId: 'g1' }),
					]);

				const group1 = selectSessionsByGroup('g1')(useSessionStore.getState());
				expect(group1).toHaveLength(2);
				expect(group1.map((s) => s.id)).toEqual(['a', 'c']);
			});
		});

		describe('selectUngroupedSessions', () => {
			it('returns sessions without a group and not worktree children', () => {
				useSessionStore.getState().setSessions([
					createMockSession({ id: 'a' }), // ungrouped
					createMockSession({ id: 'b', groupId: 'g1' }), // grouped
					createMockSession({ id: 'c', parentSessionId: 'a' }), // worktree child
					createMockSession({ id: 'd' }), // ungrouped
				]);

				const ungrouped = selectUngroupedSessions(useSessionStore.getState());
				expect(ungrouped).toHaveLength(2);
				expect(ungrouped.map((s) => s.id)).toEqual(['a', 'd']);
			});
		});

		describe('selectGroupById', () => {
			it('returns the group with the given ID', () => {
				useSessionStore.getState().setGroups([createMockGroup({ id: 'g1', name: 'Group One' })]);

				const group = selectGroupById('g1')(useSessionStore.getState());
				expect(group?.name).toBe('Group One');
			});

			it('returns undefined if not found', () => {
				const group = selectGroupById('nope')(useSessionStore.getState());
				expect(group).toBeUndefined();
			});
		});

		describe('selectSessionCount', () => {
			it('returns the number of sessions', () => {
				expect(selectSessionCount(useSessionStore.getState())).toBe(0);

				useSessionStore
					.getState()
					.setSessions([createMockSession({ id: 'a' }), createMockSession({ id: 'b' })]);

				expect(selectSessionCount(useSessionStore.getState())).toBe(2);
			});
		});

		describe('selectIsReady', () => {
			it('returns false when neither flag is set', () => {
				expect(selectIsReady(useSessionStore.getState())).toBe(false);
			});

			it('returns false when only sessionsLoaded is true', () => {
				useSessionStore.getState().setSessionsLoaded(true);
				expect(selectIsReady(useSessionStore.getState())).toBe(false);
			});

			it('returns false when only initialLoadComplete is true', () => {
				useSessionStore.getState().setInitialLoadComplete(true);
				expect(selectIsReady(useSessionStore.getState())).toBe(false);
			});

			it('returns true when both flags are set', () => {
				useSessionStore.getState().setSessionsLoaded(true);
				useSessionStore.getState().setInitialLoadComplete(true);
				expect(selectIsReady(useSessionStore.getState())).toBe(true);
			});
		});

		describe('selectIsAnySessionBusy', () => {
			it('returns false when no sessions exist', () => {
				expect(selectIsAnySessionBusy(useSessionStore.getState())).toBe(false);
			});

			it('returns false when all sessions are idle', () => {
				useSessionStore.getState().setSessions([
					createMockSession({ id: 'a', state: 'idle' }),
					createMockSession({ id: 'b', state: 'idle' }),
				]);
				expect(selectIsAnySessionBusy(useSessionStore.getState())).toBe(false);
			});

			it('returns true when at least one session is busy', () => {
				useSessionStore.getState().setSessions([
					createMockSession({ id: 'a', state: 'idle' }),
					createMockSession({ id: 'b', state: 'busy' }),
				]);
				expect(selectIsAnySessionBusy(useSessionStore.getState())).toBe(true);
			});

			it('returns false for non-busy active states', () => {
				useSessionStore.getState().setSessions([
					createMockSession({ id: 'a', state: 'waiting_input' }),
					createMockSession({ id: 'b', state: 'connecting' }),
					createMockSession({ id: 'c', state: 'error' }),
				]);
				expect(selectIsAnySessionBusy(useSessionStore.getState())).toBe(false);
			});
		});
	});

	// ========================================================================
	// React Hook Integration
	// ========================================================================

	describe('React hook integration', () => {
		it('provides state to React components via selectors', () => {
			useSessionStore.getState().setSessions([createMockSession({ id: 'a' })]);

			const { result } = renderHook(() => useSessionStore((s) => s.sessions.length));
			expect(result.current).toBe(1);
		});

		it('re-renders when selected state changes', () => {
			const { result } = renderHook(() => useSessionStore((s) => s.activeSessionId));
			expect(result.current).toBe('');

			act(() => {
				useSessionStore.getState().setActiveSessionId('session-1');
			});

			expect(result.current).toBe('session-1');
		});

		it('does not re-render when unrelated state changes', () => {
			let renderCount = 0;
			const { result } = renderHook(() => {
				renderCount++;
				return useSessionStore((s) => s.activeSessionId);
			});

			const initialRenderCount = renderCount;

			// Change unrelated state (groups)
			act(() => {
				useSessionStore.getState().setGroups([createMockGroup({ id: 'g1' })]);
			});

			// Should not have re-rendered (selector isolation)
			expect(renderCount).toBe(initialRenderCount);
			expect(result.current).toBe('');
		});

		it('supports selectActiveSession as a hook selector', () => {
			useSessionStore.getState().setSessions([createMockSession({ id: 'a', name: 'Session A' })]);
			useSessionStore.getState().setActiveSessionId('a');

			const { result } = renderHook(() => useSessionStore(selectActiveSession));

			expect(result.current?.name).toBe('Session A');
		});

		it('works with multiple selectors in the same component', () => {
			useSessionStore.getState().setSessions([createMockSession({ id: 'a' })]);
			useSessionStore.getState().setGroups([createMockGroup({ id: 'g1' })]);

			const { result } = renderHook(() => ({
				sessionCount: useSessionStore((s) => s.sessions.length),
				groupCount: useSessionStore((s) => s.groups.length),
			}));

			expect(result.current.sessionCount).toBe(1);
			expect(result.current.groupCount).toBe(1);
		});
	});

	// ========================================================================
	// Action Stability
	// ========================================================================

	describe('action stability (getState extraction pattern)', () => {
		it('returns stable action references across state changes', () => {
			const actionsBefore = useSessionStore.getState();

			useSessionStore.getState().setSessions([createMockSession({ id: 'a' })]);
			useSessionStore.getState().setGroups([createMockGroup({ id: 'g1' })]);
			useSessionStore.getState().setActiveSessionId('a');

			const actionsAfter = useSessionStore.getState();

			expect(actionsAfter.setSessions).toBe(actionsBefore.setSessions);
			expect(actionsAfter.addSession).toBe(actionsBefore.addSession);
			expect(actionsAfter.removeSession).toBe(actionsBefore.removeSession);
			expect(actionsAfter.updateSession).toBe(actionsBefore.updateSession);
			expect(actionsAfter.setActiveSessionId).toBe(actionsBefore.setActiveSessionId);
			expect(actionsAfter.setGroups).toBe(actionsBefore.setGroups);
			expect(actionsAfter.toggleBookmark).toBe(actionsBefore.toggleBookmark);
		});

		it('extracted actions still mutate state correctly', () => {
			const { setSessions, setActiveSessionId, setGroups } = useSessionStore.getState();

			setSessions([createMockSession({ id: 'a' })]);
			expect(useSessionStore.getState().sessions).toHaveLength(1);

			setActiveSessionId('a');
			expect(useSessionStore.getState().activeSessionId).toBe('a');

			setGroups([createMockGroup({ id: 'g1' })]);
			expect(useSessionStore.getState().groups).toHaveLength(1);
		});

		it('extracted actions work with updater functions', () => {
			const { setSessions } = useSessionStore.getState();

			setSessions([createMockSession({ id: 'a' })]);
			setSessions((prev) => [...prev, createMockSession({ id: 'b' })]);

			expect(useSessionStore.getState().sessions).toHaveLength(2);
		});
	});

	// ========================================================================
	// Non-React Access
	// ========================================================================

	describe('non-React access', () => {
		it('getSessionState returns current state', () => {
			useSessionStore.getState().setSessions([createMockSession({ id: 'a' })]);
			useSessionStore.getState().setActiveSessionId('a');

			const state = getSessionState();
			expect(state.sessions).toHaveLength(1);
			expect(state.activeSessionId).toBe('a');
		});

		it('getSessionActions returns working action references', () => {
			const actions = getSessionActions();

			actions.setSessions([createMockSession({ id: 'a' })]);
			expect(useSessionStore.getState().sessions).toHaveLength(1);

			actions.setActiveSessionId('a');
			expect(useSessionStore.getState().activeSessionId).toBe('a');

			actions.toggleBookmark('a');
			expect(useSessionStore.getState().sessions[0].bookmarked).toBe(true);
		});

		it('replaces ref pattern: getState().sessions instead of sessionsRef.current', () => {
			// This demonstrates the key Zustand advantage over SessionContext:
			// No more refs needed for accessing current state in callbacks
			useSessionStore.getState().setSessions([createMockSession({ id: 'a', name: 'First' })]);

			// In a callback (like an IPC handler), always access current state:
			const current = useSessionStore.getState().sessions;
			expect(current[0].name).toBe('First');

			// Mutate
			useSessionStore.getState().updateSession('a', { name: 'Updated' });

			// Re-read — always gets the latest (no stale closure)
			const updated = useSessionStore.getState().sessions;
			expect(updated[0].name).toBe('Updated');
		});
	});

	// ========================================================================
	// Complex Scenarios
	// ========================================================================

	describe('complex scenarios', () => {
		it('handles session lifecycle: create → update → bookmark → remove', () => {
			// Create
			const session = createMockSession({ id: 'lifecycle', name: 'New Session' });
			useSessionStore.getState().addSession(session);
			useSessionStore.getState().setActiveSessionId('lifecycle');
			expect(selectActiveSession(useSessionStore.getState())?.name).toBe('New Session');

			// Update
			useSessionStore.getState().updateSession('lifecycle', {
				name: 'Renamed Session',
				state: 'busy',
			});
			expect(selectActiveSession(useSessionStore.getState())?.name).toBe('Renamed Session');

			// Bookmark
			useSessionStore.getState().toggleBookmark('lifecycle');
			expect(selectBookmarkedSessions(useSessionStore.getState())).toHaveLength(1);

			// Remove
			useSessionStore.getState().removeSession('lifecycle');
			expect(useSessionStore.getState().sessions).toHaveLength(0);
			expect(selectBookmarkedSessions(useSessionStore.getState())).toHaveLength(0);
		});

		it('handles group lifecycle: create → add sessions → collapse → remove', () => {
			// Create group
			useSessionStore.getState().addGroup(createMockGroup({ id: 'g1', name: 'Backend' }));

			// Add sessions to group
			useSessionStore
				.getState()
				.addSession(createMockSession({ id: 'a', groupId: 'g1', name: 'API' }));
			useSessionStore
				.getState()
				.addSession(createMockSession({ id: 'b', groupId: 'g1', name: 'DB' }));

			expect(selectSessionsByGroup('g1')(useSessionStore.getState())).toHaveLength(2);

			// Collapse
			useSessionStore.getState().toggleGroupCollapsed('g1');
			expect(useSessionStore.getState().groups[0].collapsed).toBe(true);

			// Remove group (sessions keep their groupId — that's handled by business logic)
			useSessionStore.getState().removeGroup('g1');
			expect(useSessionStore.getState().groups).toHaveLength(0);
		});

		it('handles concurrent updates from setSessions updater (batching pattern)', () => {
			// Simulate the batched updater pattern:
			// Multiple rapid updates via functional setSessions
			useSessionStore.getState().setSessions([createMockSession({ id: 'a', contextUsage: 0 })]);

			// Simulate rapid context usage updates (like during AI streaming)
			for (let i = 1; i <= 10; i++) {
				useSessionStore
					.getState()
					.setSessions((prev) =>
						prev.map((s) => (s.id === 'a' ? { ...s, contextUsage: i * 10 } : s))
					);
			}

			expect(useSessionStore.getState().sessions[0].contextUsage).toBe(100);
		});

		it('handles initialization flow: load → set loaded → set complete', () => {
			// Simulate the startup flow
			expect(selectIsReady(useSessionStore.getState())).toBe(false);

			// Step 1: Load sessions from disk
			useSessionStore
				.getState()
				.setSessions([
					createMockSession({ id: 'restored-1' }),
					createMockSession({ id: 'restored-2' }),
				]);
			useSessionStore.getState().setGroups([createMockGroup({ id: 'g1' })]);

			// Step 2: Mark as loaded
			useSessionStore.getState().setSessionsLoaded(true);

			// Step 3: Set active session
			useSessionStore.getState().setActiveSessionId('restored-1');

			// Step 4: Mark initial load complete
			useSessionStore.getState().setInitialLoadComplete(true);

			expect(selectIsReady(useSessionStore.getState())).toBe(true);
			expect(selectActiveSession(useSessionStore.getState())?.id).toBe('restored-1');
		});
	});

	// ========================================================================
	// Session Switching with File Tabs
	// ========================================================================

	describe('session switching with file tabs', () => {
		describe('independent file tabs per session', () => {
			it('each session maintains its own file tabs', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [
						createMockFilePreviewTab({ id: 's1-file', path: '/session1/app.ts', scrollTop: 100 }),
					],
					activeFileTabId: 's1-file',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [
						createMockFilePreviewTab({ id: 's2-file', path: '/session2/index.ts', scrollTop: 500 }),
					],
					activeFileTabId: 's2-file',
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				const active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs).toHaveLength(1);
				expect(active?.filePreviewTabs[0].path).toBe('/session1/app.ts');
				expect(active?.filePreviewTabs[0].scrollTop).toBe(100);
				expect(active?.activeFileTabId).toBe('s1-file');
			});

			it('session with no file tabs has empty array and null activeFileTabId', () => {
				const session = createMockSession({
					id: 'no-files',
					filePreviewTabs: [],
					activeFileTabId: null,
				});

				useSessionStore.getState().setSessions([session]);
				useSessionStore.getState().setActiveSessionId('no-files');

				const active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs).toHaveLength(0);
				expect(active?.activeFileTabId).toBeNull();
			});

			it('session with multiple file tabs stores all tabs and tracks active', () => {
				const tabs = [
					createMockFilePreviewTab({ id: 'f1', path: '/src/a.ts' }),
					createMockFilePreviewTab({ id: 'f2', path: '/src/b.ts' }),
					createMockFilePreviewTab({ id: 'f3', path: '/src/c.ts' }),
				];

				const session = createMockSession({
					id: 'multi-tab',
					filePreviewTabs: tabs,
					activeFileTabId: 'f2',
				});

				useSessionStore.getState().setSessions([session]);
				useSessionStore.getState().setActiveSessionId('multi-tab');

				const active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs).toHaveLength(3);
				expect(active?.filePreviewTabs.map((t) => t.path)).toEqual([
					'/src/a.ts',
					'/src/b.ts',
					'/src/c.ts',
				]);
				expect(active?.activeFileTabId).toBe('f2');
			});
		});

		describe('switching active session updates file tabs', () => {
			it('selectActiveSession returns the correct file tabs after switching', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's1-file', path: '/s1/file.ts' })],
					activeFileTabId: 's1-file',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's2-file', path: '/s2/file.ts' })],
					activeFileTabId: 's2-file',
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				// Verify session 1 is active
				let active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs[0].path).toBe('/s1/file.ts');

				// Switch to session 2
				useSessionStore.getState().setActiveSessionId('session-2');

				active = selectActiveSession(useSessionStore.getState());
				expect(active?.id).toBe('session-2');
				expect(active?.filePreviewTabs[0].path).toBe('/s2/file.ts');
				expect(active?.activeFileTabId).toBe('s2-file');
			});

			it('switching from session with files to session without files', () => {
				const session1 = createMockSession({
					id: 'with-files',
					filePreviewTabs: [createMockFilePreviewTab({ id: 'f1', path: '/file.ts' })],
					activeFileTabId: 'f1',
				});
				const session2 = createMockSession({
					id: 'no-files',
					filePreviewTabs: [],
					activeFileTabId: null,
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('with-files');

				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs).toHaveLength(1);

				// Switch to session without files
				useSessionStore.getState().setActiveSessionId('no-files');

				const active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs).toHaveLength(0);
				expect(active?.activeFileTabId).toBeNull();
			});

			it('switching from session without files to session with files', () => {
				const session1 = createMockSession({
					id: 'no-files',
					filePreviewTabs: [],
					activeFileTabId: null,
				});
				const session2 = createMockSession({
					id: 'with-files',
					filePreviewTabs: [
						createMockFilePreviewTab({ id: 'f1', path: '/a.ts' }),
						createMockFilePreviewTab({ id: 'f2', path: '/b.ts' }),
					],
					activeFileTabId: 'f1',
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('no-files');

				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs).toHaveLength(0);

				// Switch to session with files
				useSessionStore.getState().setActiveSessionId('with-files');

				const active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs).toHaveLength(2);
				expect(active?.filePreviewTabs.map((t) => t.path)).toEqual(['/a.ts', '/b.ts']);
			});
		});

		describe('switching back restores file tabs', () => {
			it('round-trip switching restores file tabs correctly', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's1-file', path: '/s1/original.ts' })],
					activeFileTabId: 's1-file',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's2-file', path: '/s2/original.ts' })],
					activeFileTabId: 's2-file',
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].path).toBe(
					'/s1/original.ts'
				);

				// Switch to session 2
				useSessionStore.getState().setActiveSessionId('session-2');
				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].path).toBe(
					'/s2/original.ts'
				);

				// Switch back to session 1
				useSessionStore.getState().setActiveSessionId('session-1');
				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].path).toBe(
					'/s1/original.ts'
				);
			});

			it('preserves scroll position per session when switching', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's1-file', scrollTop: 1500 })],
					activeFileTabId: 's1-file',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's2-file', scrollTop: 3000 })],
					activeFileTabId: 's2-file',
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].scrollTop).toBe(
					1500
				);

				// Switch to session 2
				useSessionStore.getState().setActiveSessionId('session-2');
				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].scrollTop).toBe(
					3000
				);

				// Switch back to session 1
				useSessionStore.getState().setActiveSessionId('session-1');
				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].scrollTop).toBe(
					1500
				);
			});

			it('preserves search query per session when switching', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [
						createMockFilePreviewTab({ id: 's1-file', searchQuery: 'handleClick' }),
					],
					activeFileTabId: 's1-file',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's2-file', searchQuery: 'useState' })],
					activeFileTabId: 's2-file',
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				expect(
					selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].searchQuery
				).toBe('handleClick');

				// Switch to session 2
				useSessionStore.getState().setActiveSessionId('session-2');
				expect(
					selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].searchQuery
				).toBe('useState');

				// Switch back to session 1
				useSessionStore.getState().setActiveSessionId('session-1');
				expect(
					selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].searchQuery
				).toBe('handleClick');
			});

			it('preserves edit mode per session when switching', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's1-file', editMode: true })],
					activeFileTabId: 's1-file',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [createMockFilePreviewTab({ id: 's2-file', editMode: false })],
					activeFileTabId: 's2-file',
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].editMode).toBe(
					true
				);

				// Switch to session 2
				useSessionStore.getState().setActiveSessionId('session-2');
				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].editMode).toBe(
					false
				);

				// Switch back to session 1
				useSessionStore.getState().setActiveSessionId('session-1');
				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs[0].editMode).toBe(
					true
				);
			});
		});

		describe('active file tab ID per session', () => {
			it('each session tracks its own active file tab independently', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [
						createMockFilePreviewTab({ id: 's1-f1' }),
						createMockFilePreviewTab({ id: 's1-f2' }),
					],
					activeFileTabId: 's1-f2', // Second tab active
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [
						createMockFilePreviewTab({ id: 's2-f1' }),
						createMockFilePreviewTab({ id: 's2-f2' }),
						createMockFilePreviewTab({ id: 's2-f3' }),
					],
					activeFileTabId: 's2-f1', // First tab active
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				expect(selectActiveSession(useSessionStore.getState())?.activeFileTabId).toBe('s1-f2');

				// Switch to session 2
				useSessionStore.getState().setActiveSessionId('session-2');
				expect(selectActiveSession(useSessionStore.getState())?.activeFileTabId).toBe('s2-f1');

				// Switch back to session 1
				useSessionStore.getState().setActiveSessionId('session-1');
				expect(selectActiveSession(useSessionStore.getState())?.activeFileTabId).toBe('s1-f2');
			});

			it('session with AI tab active has null activeFileTabId', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [createMockFilePreviewTab({ id: 'f1' })],
					activeFileTabId: null, // AI tab is active
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [createMockFilePreviewTab({ id: 'f2' })],
					activeFileTabId: 'f2', // File tab is active
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				expect(selectActiveSession(useSessionStore.getState())?.activeFileTabId).toBeNull();

				useSessionStore.getState().setActiveSessionId('session-2');
				expect(selectActiveSession(useSessionStore.getState())?.activeFileTabId).toBe('f2');
			});
		});

		describe('same file in multiple sessions', () => {
			it('same file path can be open in different sessions with independent state', () => {
				const sharedPath = '/shared/utils.ts';

				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [
						createMockFilePreviewTab({
							id: 's1-utils',
							path: sharedPath,
							scrollTop: 0,
							searchQuery: 'function',
							editMode: false,
						}),
					],
					activeFileTabId: 's1-utils',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [
						createMockFilePreviewTab({
							id: 's2-utils',
							path: sharedPath,
							scrollTop: 2000,
							searchQuery: 'const',
							editMode: true,
						}),
					],
					activeFileTabId: 's2-utils',
				});

				useSessionStore.getState().setSessions([session1, session2]);

				// Session 1: scroll=0, search='function', not editing
				useSessionStore.getState().setActiveSessionId('session-1');
				let active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs[0].path).toBe(sharedPath);
				expect(active?.filePreviewTabs[0].scrollTop).toBe(0);
				expect(active?.filePreviewTabs[0].searchQuery).toBe('function');
				expect(active?.filePreviewTabs[0].editMode).toBe(false);

				// Session 2: scroll=2000, search='const', editing
				useSessionStore.getState().setActiveSessionId('session-2');
				active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs[0].path).toBe(sharedPath);
				expect(active?.filePreviewTabs[0].scrollTop).toBe(2000);
				expect(active?.filePreviewTabs[0].searchQuery).toBe('const');
				expect(active?.filePreviewTabs[0].editMode).toBe(true);

				// Switch back to session 1 — state preserved
				useSessionStore.getState().setActiveSessionId('session-1');
				active = selectActiveSession(useSessionStore.getState());
				expect(active?.filePreviewTabs[0].scrollTop).toBe(0);
				expect(active?.filePreviewTabs[0].searchQuery).toBe('function');
				expect(active?.filePreviewTabs[0].editMode).toBe(false);
			});

			it('sessions can have different number of tabs for the same files', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [
						createMockFilePreviewTab({ id: 's1-a', path: '/shared/a.ts' }),
						createMockFilePreviewTab({ id: 's1-b', path: '/shared/b.ts' }),
						createMockFilePreviewTab({ id: 's1-c', path: '/shared/c.ts' }),
					],
					activeFileTabId: 's1-a',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [
						createMockFilePreviewTab({ id: 's2-a', path: '/shared/a.ts' }),
						createMockFilePreviewTab({ id: 's2-c', path: '/shared/c.ts' }),
					],
					activeFileTabId: 's2-c',
				});

				useSessionStore.getState().setSessions([session1, session2]);

				useSessionStore.getState().setActiveSessionId('session-1');
				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs).toHaveLength(3);

				useSessionStore.getState().setActiveSessionId('session-2');
				expect(selectActiveSession(useSessionStore.getState())?.filePreviewTabs).toHaveLength(2);
			});
		});

		describe('rapid session switching', () => {
			it('handles rapid switching across 5 sessions without losing state', () => {
				const sessions = Array.from({ length: 5 }, (_, i) =>
					createMockSession({
						id: `session-${i}`,
						name: `Session ${i}`,
						filePreviewTabs: [
							createMockFilePreviewTab({
								id: `f${i}`,
								path: `/path/${i}.ts`,
								scrollTop: i * 100,
							}),
						],
						activeFileTabId: `f${i}`,
					})
				);

				useSessionStore.getState().setSessions(sessions);
				useSessionStore.getState().setActiveSessionId('session-0');

				// Rapid switching through all sessions
				for (let i = 1; i < 5; i++) {
					useSessionStore.getState().setActiveSessionId(`session-${i}`);
					const active = selectActiveSession(useSessionStore.getState());
					expect(active?.id).toBe(`session-${i}`);
					expect(active?.filePreviewTabs[0].scrollTop).toBe(i * 100);
				}

				// Switch back to first session — state preserved
				useSessionStore.getState().setActiveSessionId('session-0');
				const first = selectActiveSession(useSessionStore.getState());
				expect(first?.id).toBe('session-0');
				expect(first?.filePreviewTabs[0].scrollTop).toBe(0);
				expect(first?.filePreviewTabs[0].path).toBe('/path/0.ts');
			});
		});

		describe('React hook reacts to session switching with file tabs', () => {
			it('useSessionStore selector re-renders with new file tabs on session switch', () => {
				const session1 = createMockSession({
					id: 'session-1',
					filePreviewTabs: [createMockFilePreviewTab({ id: 'f1', path: '/a.ts' })],
					activeFileTabId: 'f1',
				});
				const session2 = createMockSession({
					id: 'session-2',
					filePreviewTabs: [createMockFilePreviewTab({ id: 'f2', path: '/b.ts' })],
					activeFileTabId: 'f2',
				});

				useSessionStore.getState().setSessions([session1, session2]);
				useSessionStore.getState().setActiveSessionId('session-1');

				const { result } = renderHook(() => useSessionStore(selectActiveSession));

				expect(result.current?.filePreviewTabs[0].path).toBe('/a.ts');

				// Switch session
				act(() => {
					useSessionStore.getState().setActiveSessionId('session-2');
				});

				expect(result.current?.filePreviewTabs[0].path).toBe('/b.ts');
				expect(result.current?.activeFileTabId).toBe('f2');
			});
		});
	});

	describe('addLogToTab', () => {
		it('adds log entry to active tab when no tabId provided', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			useSessionStore.getState().addLogToTab('session-1', {
				source: 'user',
				text: 'Hello, world!',
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].logs).toHaveLength(1);
			expect(updated.aiTabs[0].logs[0].source).toBe('user');
			expect(updated.aiTabs[0].logs[0].text).toBe('Hello, world!');
		});

		it('adds log entry to specific tab by tabId', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
					{
						id: 'tab-2',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			// Add to tab-2 explicitly (not the active tab)
			useSessionStore
				.getState()
				.addLogToTab('session-1', { source: 'system', text: 'Command executed' }, 'tab-2');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].logs).toHaveLength(0); // tab-1 untouched
			expect(updated.aiTabs[1].logs).toHaveLength(1);
			expect(updated.aiTabs[1].logs[0].text).toBe('Command executed');
		});

		it('generates id and timestamp when not provided', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			useSessionStore.getState().addLogToTab('session-1', {
				source: 'stdout',
				text: 'Output text',
			});

			const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
			expect(log.id).toBeTruthy();
			expect(typeof log.id).toBe('string');
			expect(log.timestamp).toBeGreaterThan(0);
		});

		it('uses provided id and timestamp when given', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			useSessionStore.getState().addLogToTab('session-1', {
				id: 'custom-id-123',
				timestamp: 1234567890,
				source: 'user',
				text: 'Custom entry',
			});

			const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
			expect(log.id).toBe('custom-id-123');
			expect(log.timestamp).toBe(1234567890);
		});

		it('includes optional fields (images, delivered, aiCommand)', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});

			useSessionStore.getState().setSessions([session]);

			useSessionStore.getState().addLogToTab('session-1', {
				source: 'user',
				text: 'With extras',
				images: ['base64data'],
				delivered: true,
				aiCommand: { command: '/commit', description: 'Commit changes' },
			});

			const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
			expect(log.images).toEqual(['base64data']);
			expect(log.delivered).toBe(true);
			expect(log.aiCommand).toEqual({ command: '/commit', description: 'Commit changes' });
		});

		it('does not affect other sessions', () => {
			const session1 = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			});
			const session2 = createMockSession({
				id: 'session-2',
				aiTabs: [
					{
						id: 'tab-2',
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				activeTabId: 'tab-2',
			});

			useSessionStore.getState().setSessions([session1, session2]);

			useSessionStore.getState().addLogToTab('session-1', {
				source: 'user',
				text: 'Only for session 1',
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].aiTabs[0].logs).toHaveLength(1);
			expect(sessions[1].aiTabs[0].logs).toHaveLength(0); // Untouched
		});

		it('logs error when no target tab found', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [], // No tabs!
				activeTabId: '',
			});

			useSessionStore.getState().setSessions([session]);

			useSessionStore.getState().addLogToTab('session-1', {
				source: 'user',
				text: 'Should not appear',
			});

			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[addLogToTab]'));
			consoleSpy.mockRestore();
		});

		it('is available via getSessionActions()', () => {
			const actions = getSessionActions();
			expect(typeof actions.addLogToTab).toBe('function');
		});
	});
});
