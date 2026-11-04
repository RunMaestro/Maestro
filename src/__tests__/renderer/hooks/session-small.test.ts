// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/useSessionFilterMode.test.ts
// Source: src/__tests__/renderer/hooks/useSessionNavigation.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook as s1_renderHook, act as s1_act } from '@testing-library/react';
import { useSessionFilterMode } from '../../../renderer/hooks/session/useSessionFilterMode';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSessionStore as s1_useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session as S1_Session, Group } from '../../../renderer/types';
import { resetStores } from '../../helpers';
import { renderHook as s2_renderHook, act as s2_act } from '@testing-library/react';
import { useSessionNavigation } from '../../../renderer/hooks/session/useSessionNavigation';
import type { NavHistoryEntry } from '../../../renderer/hooks/session/useNavigationHistory';
import type { Session as S2_Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';
import { useSessionStore as s2_useSessionStore } from '../../../renderer/stores/sessionStore';
import { resetStore } from '../../helpers/resetStores';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
// Source: src/__tests__/renderer/hooks/useSessionFilterMode.test.ts
describe('', () => {
	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------
	let idCounter = 0;
	function makeSession(overrides: Partial<S1_Session> = {}): S1_Session {
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
		} as S1_Session;
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
	function seedStores(sessions: S1_Session[] = [], groups: Group[] = []) {
		resetStores(s1_useSessionStore, useUIStore);
		s1_useSessionStore.setState({ sessions, groups });
	}
	// ---------------------------------------------------------------------------
	// Tests
	// ---------------------------------------------------------------------------
	describe('useSessionFilterMode', () => {
		beforeEach(() => {
			idCounter = 0;
			seedStores();
		});
		// -----------------------------------------------------------------------
		// Basic state
		// -----------------------------------------------------------------------
		describe('basic state', () => {
			it('returns sessionFilter and setSessionFilter', () => {
				const { result } = s1_renderHook(() => useSessionFilterMode());
				expect(result.current.sessionFilter).toBe('');
				expect(typeof result.current.setSessionFilter).toBe('function');
			});
			it('setSessionFilter updates the filter value', () => {
				const { result } = s1_renderHook(() => useSessionFilterMode());
				s1_act(() => {
					result.current.setSessionFilter('test');
				});
				expect(result.current.sessionFilter).toBe('test');
			});
		});
		// -----------------------------------------------------------------------
		// Filter open behavior
		// -----------------------------------------------------------------------
		describe('when filter opens', () => {
			it('collapses all groups on first open (default behavior)', () => {
				const g1 = makeGroup({ id: 'g1', collapsed: false });
				const g2 = makeGroup({ id: 'g2', collapsed: false });
				seedStores([], [g1, g2]);
				s1_renderHook(() => useSessionFilterMode());
				// Open filter
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				const groups = s1_useSessionStore.getState().groups;
				expect(groups.every((g) => g.collapsed)).toBe(true);
			});
			it('expands bookmarks on first open', () => {
				useUIStore.setState({ bookmarksCollapsed: true } as any);
				s1_renderHook(() => useSessionFilterMode());
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				expect(useUIStore.getState().bookmarksCollapsed).toBe(false);
			});
		});
		// -----------------------------------------------------------------------
		// Filter close behavior
		// -----------------------------------------------------------------------
		describe('when filter closes', () => {
			it('restores original group collapse states', () => {
				const g1 = makeGroup({ id: 'g1', collapsed: false });
				const g2 = makeGroup({ id: 'g2', collapsed: true });
				seedStores([], [g1, g2]);
				s1_renderHook(() => useSessionFilterMode());
				// Open filter (saves state, collapses all)
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				// Verify groups are collapsed during filter
				expect(s1_useSessionStore.getState().groups.every((g) => g.collapsed)).toBe(true);
				// Close filter
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: false });
				});
				// Original states restored
				const groups = s1_useSessionStore.getState().groups;
				const g1State = groups.find((g) => g.id === 'g1');
				const g2State = groups.find((g) => g.id === 'g2');
				expect(g1State?.collapsed).toBe(false);
				expect(g2State?.collapsed).toBe(true);
			});
			it('restores original bookmarks collapsed state', () => {
				useUIStore.setState({ bookmarksCollapsed: true } as any);
				s1_renderHook(() => useSessionFilterMode());
				// Open filter (expands bookmarks)
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				expect(useUIStore.getState().bookmarksCollapsed).toBe(false);
				// Close filter
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: false });
				});
				// Original state restored
				expect(useUIStore.getState().bookmarksCollapsed).toBe(true);
			});
		});
		// -----------------------------------------------------------------------
		// Filter mode preferences (persist across open/close)
		// -----------------------------------------------------------------------
		describe('filter mode preferences', () => {
			it('remembers user changes to group states across filter open/close cycles', () => {
				const g1 = makeGroup({ id: 'g1', collapsed: false });
				const g2 = makeGroup({ id: 'g2', collapsed: false });
				seedStores([], [g1, g2]);
				s1_renderHook(() => useSessionFilterMode());
				// First open: defaults apply (all collapsed)
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				expect(s1_useSessionStore.getState().groups.every((g) => g.collapsed)).toBe(true);
				// User manually expands g1 during filter mode
				s1_act(() => {
					s1_useSessionStore.setState({
						groups: s1_useSessionStore
							.getState()
							.groups.map((g) => (g.id === 'g1' ? { ...g, collapsed: false } : g)),
					} as any);
				});
				// Close filter (saves filter mode preferences)
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: false });
				});
				// Second open: should restore filter mode preferences (g1 expanded, g2 collapsed)
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				const groups = s1_useSessionStore.getState().groups;
				expect(groups.find((g) => g.id === 'g1')?.collapsed).toBe(false);
				expect(groups.find((g) => g.id === 'g2')?.collapsed).toBe(true);
			});
		});
		// -----------------------------------------------------------------------
		// Auto-expand groups when filtering
		// -----------------------------------------------------------------------
		describe('auto-expand groups during filtering', () => {
			it('expands groups containing matching sessions', () => {
				const g1 = makeGroup({ id: 'g1', collapsed: true });
				const g2 = makeGroup({ id: 'g2', collapsed: true });
				const s1 = makeSession({ name: 'API Work', groupId: 'g1' });
				const s2 = makeSession({ name: 'UI Work', groupId: 'g2' });
				seedStores([s1, s2], [g1, g2]);
				// Open filter first
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				const { result } = s1_renderHook(() => useSessionFilterMode());
				// Type filter
				s1_act(() => {
					result.current.setSessionFilter('api');
				});
				const groups = s1_useSessionStore.getState().groups;
				expect(groups.find((g) => g.id === 'g1')?.collapsed).toBe(false); // has match
				expect(groups.find((g) => g.id === 'g2')?.collapsed).toBe(true); // no match
			});
			it('expands bookmarks when matching bookmarked sessions exist', () => {
				const s1 = makeSession({ name: 'API Work', bookmarked: true });
				seedStores([s1]);
				useUIStore.setState({ bookmarksCollapsed: true } as any);
				// Open filter
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				const { result } = s1_renderHook(() => useSessionFilterMode());
				s1_act(() => {
					result.current.setSessionFilter('api');
				});
				expect(useUIStore.getState().bookmarksCollapsed).toBe(false);
			});
			it('collapses all groups when filter is cleared but input is still open', () => {
				const g1 = makeGroup({ id: 'g1', collapsed: false });
				seedStores([makeSession({ name: 'Test', groupId: 'g1' })], [g1]);
				// Open filter
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				const { result } = s1_renderHook(() => useSessionFilterMode());
				// Type then clear
				s1_act(() => {
					result.current.setSessionFilter('test');
				});
				s1_act(() => {
					result.current.setSessionFilter('');
				});
				expect(s1_useSessionStore.getState().groups[0].collapsed).toBe(true);
			});
			it('matches AI tab names for group expansion', () => {
				const g1 = makeGroup({ id: 'g1', collapsed: true });
				const s1 = makeSession({
					name: 'Agent 1',
					groupId: 'g1',
					aiTabs: [{ name: 'refactoring-session' } as any],
				});
				seedStores([s1], [g1]);
				// Open filter
				s1_act(() => {
					useUIStore.setState({ sessionFilterOpen: true });
				});
				const { result } = s1_renderHook(() => useSessionFilterMode());
				s1_act(() => {
					result.current.setSessionFilter('refactoring');
				});
				expect(s1_useSessionStore.getState().groups[0].collapsed).toBe(false);
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/useSessionNavigation.test.ts
describe('', () => {
	/**
	 * Codifies the breadcrumb restore behavior: navigateBack/navigateForward must
	 * reactivate the previously-visited tab of ANY kind (ai, file, browser,
	 * terminal), not just AI tabs. Guards against regressing to AI-only restore.
	 */
	describe('useSessionNavigation', () => {
		beforeEach(() => {
			resetStore(s2_useSessionStore);
		});
		function setup(
			sessions: S2_Session[],
			backEntry: NavHistoryEntry | null,
			forwardEntry: NavHistoryEntry | null = null
		) {
			s2_useSessionStore.setState({ sessions });
			const navigateBack = vi.fn((_canUse?: (e: NavHistoryEntry) => boolean) => backEntry);
			const navigateForward = vi.fn((_canUse?: (e: NavHistoryEntry) => boolean) => forwardEntry);
			const setActiveSessionId = vi.fn();
			const onNavigateToGroupChat = vi.fn(async () => {});
			// Capture the updater and apply it to `sessions` so we can assert the
			// session shape the hook produces.
			let updatedSessions: S2_Session[] = sessions;
			const setSessions = vi.fn((updater: unknown) => {
				updatedSessions =
					typeof updater === 'function'
						? (updater as (prev: S2_Session[]) => S2_Session[])(sessions)
						: (updater as S2_Session[]);
			});
			const cyclePositionRef = { current: 0 };
			const { result } = s2_renderHook(() =>
				useSessionNavigation({
					navigateBack,
					navigateForward,
					setActiveSessionId,
					setSessions: setSessions as React.Dispatch<React.SetStateAction<S2_Session[]>>,
					cyclePositionRef,
					onNavigateToGroupChat,
				})
			);
			return {
				result,
				navigateBack,
				navigateForward,
				setActiveSessionId,
				setSessions,
				onNavigateToGroupChat,
				cyclePositionRef,
				getUpdated: () => updatedSessions,
			};
		}
		it('restores a browser tab on navigate back', () => {
			const session = createMockSession({
				id: 's1',
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				browserTabs: [{ id: 'b1' }] as any,
				activeBrowserTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'browser', id: 'b1' },
				],
			});
			const { result, setActiveSessionId, getUpdated, cyclePositionRef } = setup([session], {
				sessionId: 's1',
				tabId: 'b1',
				tabKind: 'browser',
			});
			s2_act(() => result.current.handleNavBack());
			expect(setActiveSessionId).toHaveBeenCalledWith('s1');
			expect(cyclePositionRef.current).toBe(-1);
			const updated = getUpdated().find((s) => s.id === 's1')!;
			expect(updated.activeBrowserTabId).toBe('b1');
			expect(updated.activeFileTabId).toBeNull();
			expect(updated.activeTerminalTabId).toBeNull();
			expect(updated.inputMode).toBe('ai');
		});
		it('restores a file tab on navigate back', () => {
			const session = createMockSession({
				id: 's1',
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				filePreviewTabs: [createMockFileTab({ id: 'f1' })],
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'f1' },
				],
			});
			const { result, getUpdated } = setup([session], {
				sessionId: 's1',
				tabId: 'f1',
				tabKind: 'file',
			});
			s2_act(() => result.current.handleNavBack());
			const updated = getUpdated().find((s) => s.id === 's1')!;
			expect(updated.activeFileTabId).toBe('f1');
			expect(updated.activeBrowserTabId).toBeNull();
			expect(updated.inputMode).toBe('ai');
		});
		it('restores a terminal tab (and terminal inputMode) on navigate back', () => {
			const session = createMockSession({
				id: 's1',
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				terminalTabs: [{ id: 't1', name: 'Terminal 1' }] as any,
				activeTerminalTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'terminal', id: 't1' },
				],
			});
			const { result, getUpdated } = setup([session], {
				sessionId: 's1',
				tabId: 't1',
				tabKind: 'terminal',
			});
			s2_act(() => result.current.handleNavBack());
			const updated = getUpdated().find((s) => s.id === 's1')!;
			expect(updated.activeTerminalTabId).toBe('t1');
			expect(updated.inputMode).toBe('terminal');
		});
		it('restores an AI tab for legacy entries without tabKind', () => {
			const session = createMockSession({
				id: 's1',
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
				activeTabId: 'ai-2',
				activeFileTabId: 'f1', // stale selection that must be cleared
				filePreviewTabs: [createMockFileTab({ id: 'f1' })],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'ai', id: 'ai-2' },
					{ type: 'file', id: 'f1' },
				],
			});
			// No tabKind - mimics an entry recorded before the tabKind field existed.
			const { result, getUpdated } = setup([session], { sessionId: 's1', tabId: 'ai-1' });
			s2_act(() => result.current.handleNavBack());
			const updated = getUpdated().find((s) => s.id === 's1')!;
			expect(updated.activeTabId).toBe('ai-1');
			expect(updated.activeFileTabId).toBeNull();
			expect(updated.inputMode).toBe('ai');
		});
		it('navigates to a group chat without touching session state', () => {
			const { result, setActiveSessionId, setSessions, onNavigateToGroupChat } = setup(
				[createMockSession({ id: 's1' })],
				{ groupChatId: 'gc1' }
			);
			s2_act(() => result.current.handleNavBack());
			expect(onNavigateToGroupChat).toHaveBeenCalledWith('gc1');
			expect(setActiveSessionId).not.toHaveBeenCalled();
			expect(setSessions).not.toHaveBeenCalled();
		});
		it('is a no-op when the target session no longer exists', () => {
			const { result, setActiveSessionId, setSessions } = setup([createMockSession({ id: 's1' })], {
				sessionId: 'gone',
				tabId: 'x',
				tabKind: 'ai',
			});
			s2_act(() => result.current.handleNavBack());
			expect(setActiveSessionId).not.toHaveBeenCalled();
			expect(setSessions).not.toHaveBeenCalled();
		});
		it('uses navigateForward for handleNavForward', () => {
			const session = createMockSession({
				id: 's1',
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				browserTabs: [{ id: 'b1' }] as any,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'browser', id: 'b1' },
				],
			});
			const { result, navigateForward, navigateBack, getUpdated } = setup([session], null, {
				sessionId: 's1',
				tabId: 'b1',
				tabKind: 'browser',
			});
			s2_act(() => result.current.handleNavForward());
			expect(navigateForward).toHaveBeenCalledTimes(1);
			expect(navigateBack).not.toHaveBeenCalled();
			expect(getUpdated().find((s) => s.id === 's1')!.activeBrowserTabId).toBe('b1');
		});
		/**
		 * The breadcrumb hands each candidate entry to `canUse` before visiting it.
		 * Entries that can no longer be reached (agent deleted, tab closed) or that
		 * name the tab already on screen must be rejected, or the keypress consumes a
		 * tombstone and moves nothing - which is what made Cmd+Shift+, feel dead
		 * after a couple of Cmd+W's.
		 */
		describe('canUse predicate', () => {
			beforeEach(() => {
				s2_useSessionStore.setState({ sessions: [], activeSessionId: '' });
				useGroupChatStore.setState({ groupChats: [], activeGroupChatId: null });
			});
			function predicateFor(session: S2_Session, activeSessionId = session.id) {
				s2_useSessionStore.setState({ sessions: [session], activeSessionId });
				const { result, navigateBack } = setup([session], null);
				s2_act(() => result.current.handleNavBack());
				return navigateBack.mock.calls[0][0]!;
			}
			const twoTabSession = () =>
				createMockSession({
					id: 's1',
					aiTabs: [createMockAITab({ id: 'ai-1' })],
					activeTabId: 'ai-1',
					filePreviewTabs: [createMockFileTab({ id: 'f1' })],
					activeFileTabId: 'f1',
					unifiedTabOrder: [
						{ type: 'ai', id: 'ai-1' },
						{ type: 'file', id: 'f1' },
					],
				});
			it('rejects an entry whose tab no longer exists', () => {
				const canUse = predicateFor(twoTabSession());
				expect(canUse({ sessionId: 's1', tabId: 'closed-tab', tabKind: 'file' })).toBe(false);
			});
			it('rejects an entry whose agent no longer exists', () => {
				const canUse = predicateFor(twoTabSession());
				expect(canUse({ sessionId: 'deleted', tabId: 'ai-1', tabKind: 'ai' })).toBe(false);
			});
			it('rejects an entry naming the tab already on screen', () => {
				// activeFileTabId wins the same precedence the recorder uses, so f1 IS
				// the visible tab and going "back" to it would move nothing.
				const canUse = predicateFor(twoTabSession());
				expect(canUse({ sessionId: 's1', tabId: 'f1', tabKind: 'file' })).toBe(false);
			});
			it('accepts an entry naming a different tab in the same agent', () => {
				const canUse = predicateFor(twoTabSession());
				expect(canUse({ sessionId: 's1', tabId: 'ai-1', tabKind: 'ai' })).toBe(true);
			});
			it('accepts any live entry for a different agent', () => {
				const canUse = predicateFor(twoTabSession(), 'other-session');
				expect(canUse({ sessionId: 's1', tabId: 'f1', tabKind: 'file' })).toBe(true);
			});
			it('rejects a group chat entry that was deleted or is already open', () => {
				const canUse = predicateFor(twoTabSession());
				expect(canUse({ groupChatId: 'gone' })).toBe(false);
				useGroupChatStore.setState({
					groupChats: [{ id: 'gc1' }] as never,
					activeGroupChatId: 'gc1',
				});
				expect(canUse({ groupChatId: 'gc1' })).toBe(false);
				useGroupChatStore.setState({ activeGroupChatId: 'gc2' });
				expect(canUse({ groupChatId: 'gc1' })).toBe(true);
			});
			it('passes the same predicate to navigateForward', () => {
				const session = twoTabSession();
				s2_useSessionStore.setState({ sessions: [session], activeSessionId: 's1' });
				const { result, navigateForward } = setup([session], null);
				s2_act(() => result.current.handleNavForward());
				expect(navigateForward.mock.calls[0][0]).toBeTypeOf('function');
			});
		});
	});
});
