import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardNavigation, UseKeyboardNavigationDeps } from '../../../renderer/hooks';
import type { Session, Group, FocusArea } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

// Thin wrapper: pre-populates an AI tab so keyboard nav has a tab to
// cycle through.
const createMockSession = (overrides: Partial<Session> = {}): Session =>
	baseCreateMockSession({
		id: `session-${Date.now()}-${Math.random()}`,
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		port: 3000,
		aiTabs: [
			{
				id: 'default-tab',
				name: 'Main',
				logs: [],
			},
		] as any,
		activeTabId: 'default-tab',
		gitBranches: [],
		gitTags: [],
		...overrides,
	});

// Minimal open StarredItem row
const makeStarred = (key: string, parentSessionId: string, displayName = key) =>
	({
		kind: 'open' as const,
		key,
		displayName,
		agentName: 'Agent',
		parentSessionId,
		tabId: `tab-${key}`,
	}) as any;

const makeGroupChat = (id: string, name = id) => ({ id, name }) as any;

// Create mock dependencies
const createMockDeps = (
	overrides: Partial<UseKeyboardNavigationDeps> = {}
): UseKeyboardNavigationDeps => {
	// Default navSessions mirrors sortedSessions if not explicitly provided
	const sortedSessions = overrides.sortedSessions ?? [];
	const navSessions = overrides.navSessions ?? sortedSessions;
	return {
		sortedSessions,
		navSessions,
		bookmarkNavSize: overrides.bookmarkNavSize ?? 0,
		selectedSidebarIndex: 0,
		setSelectedSidebarIndex: vi.fn(),
		sidebarExtraSelection: null,
		setSidebarExtraSelection: vi.fn(),
		activeSessionId: null,
		setActiveSessionId: vi.fn(),
		activeFocus: 'main',
		setActiveFocus: vi.fn(),
		groups: [],
		setGroups: vi.fn(),
		bookmarksCollapsed: false,
		setBookmarksCollapsed: vi.fn(),
		inputRef: { current: null },
		terminalOutputRef: { current: null },
		// Starred Sessions + Group Chats sections
		starredItems: [],
		activateStarredItem: vi.fn(),
		starredSectionCollapsed: false,
		setStarredSectionCollapsed: vi.fn(),
		groupChats: [],
		handleOpenGroupChat: vi.fn(),
		groupChatsExpanded: true,
		setGroupChatsExpanded: vi.fn(),
		groupChatSortAlphabetical: false,
		showUnreadAgentsOnly: false,
		...overrides,
	};
};

describe('useKeyboardNavigation', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe('handleSidebarNavigation', () => {
		it('should not handle when focus is not on sidebar', () => {
			const deps = createMockDeps({ activeFocus: 'main' });
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(false);
		});

		it('should not handle non-arrow keys', () => {
			const deps = createMockDeps({ activeFocus: 'sidebar' });
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'a' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(false);
		});

		it('should handle ArrowDown to navigate to next session', () => {
			const session1 = createMockSession({ id: 's1', name: 'Session 1' });
			const session2 = createMockSession({ id: 's2', name: 'Session 2' });
			const setSelectedSidebarIndex = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1, session2],
				navSessions: [session1, session2],
				selectedSidebarIndex: 0,
				setSelectedSidebarIndex,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(true);
			expect(setSelectedSidebarIndex).toHaveBeenCalledWith(1);
		});

		it('should collapse bookmarks section with ArrowLeft when session is bookmarked', () => {
			const session1 = createMockSession({ id: 's1', bookmarked: true });
			const setBookmarksCollapsed = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				bookmarkNavSize: 1,
				selectedSidebarIndex: 0,
				bookmarksCollapsed: false,
				setBookmarksCollapsed,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(true);
			expect(setBookmarksCollapsed).toHaveBeenCalledWith(true);
		});

		it('should expand bookmarks section with ArrowRight when collapsed', () => {
			const session1 = createMockSession({ id: 's1', bookmarked: true });
			const setBookmarksCollapsed = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				bookmarkNavSize: 1,
				selectedSidebarIndex: 0,
				bookmarksCollapsed: true,
				setBookmarksCollapsed,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(true);
			expect(setBookmarksCollapsed).toHaveBeenCalledWith(false);
		});

		it('should collapse group with ArrowLeft when session is in expanded group', () => {
			const group1: Group = { id: 'g1', name: 'Group 1', emoji: '📁', collapsed: false };
			const session1 = createMockSession({ id: 's1', groupId: 'g1' });
			const setGroups = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				bookmarkNavSize: 0,
				selectedSidebarIndex: 0,
				groups: [group1],
				setGroups,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
			result.current.handleSidebarNavigation(event);

			expect(setGroups).toHaveBeenCalled();
			// Verify the updater function collapses the group
			const updaterFn = setGroups.mock.calls[0][0];
			const newGroups = updaterFn([group1]);
			expect(newGroups[0].collapsed).toBe(true);
		});

		it('should skip input events from inputs/textareas', () => {
			const deps = createMockDeps({ activeFocus: 'sidebar' });
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const mockInput = document.createElement('input');
			document.body.appendChild(mockInput);
			mockInput.focus();

			const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
			Object.defineProperty(event, 'target', {
				value: mockInput,
				writable: false,
				configurable: true,
			});
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(false);
			document.body.removeChild(mockInput);
		});

		it('should skip Alt+Cmd+Arrow layout toggle shortcuts', () => {
			const deps = createMockDeps({ activeFocus: 'sidebar' });
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', {
				key: 'ArrowLeft',
				altKey: true,
				metaKey: true,
			});
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(false);
		});
	});

	describe('handleTabNavigation', () => {
		it('should not handle non-Tab keys', () => {
			const deps = createMockDeps();
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Enter' });
			const handled = result.current.handleTabNavigation(event);

			expect(handled).toBe(false);
		});

		it('should move focus from sidebar to main on Tab', () => {
			const mockTextarea = document.createElement('textarea');
			const inputRef = { current: mockTextarea };
			const setActiveFocus = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				setActiveFocus,
				inputRef,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Tab' });
			const handled = result.current.handleTabNavigation(event);

			expect(handled).toBe(true);
			expect(setActiveFocus).toHaveBeenCalledWith('main');
		});

		it('should cycle focus areas on Tab', () => {
			const setActiveFocus = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'main',
				setActiveFocus,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Tab' });
			result.current.handleTabNavigation(event);

			expect(setActiveFocus).toHaveBeenCalledWith('right');
		});

		it('should reverse cycle focus areas on Shift+Tab', () => {
			const setActiveFocus = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'main',
				setActiveFocus,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true });
			result.current.handleTabNavigation(event);

			expect(setActiveFocus).toHaveBeenCalledWith('sidebar');
		});

		it('should skip when input is focused', () => {
			const mockTextarea = document.createElement('textarea');
			document.body.appendChild(mockTextarea);
			mockTextarea.focus();
			const inputRef = { current: mockTextarea };
			const deps = createMockDeps({
				activeFocus: 'main',
				inputRef,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Tab' });
			const handled = result.current.handleTabNavigation(event);

			expect(handled).toBe(false);
			document.body.removeChild(mockTextarea);
		});
	});

	describe('handleEnterToActivate', () => {
		it('should not handle when focus is not on sidebar', () => {
			const deps = createMockDeps({ activeFocus: 'main' });
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Enter' });
			const handled = result.current.handleEnterToActivate(event);

			expect(handled).toBe(false);
		});

		it('should not handle Cmd+Enter', () => {
			const deps = createMockDeps({ activeFocus: 'sidebar' });
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true });
			const handled = result.current.handleEnterToActivate(event);

			expect(handled).toBe(false);
		});

		it('should activate selected session on Enter', () => {
			const session1 = createMockSession({ id: 's1' });
			const session2 = createMockSession({ id: 's2' });
			const setActiveSessionId = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1, session2],
				navSessions: [session1, session2],
				selectedSidebarIndex: 1,
				setActiveSessionId,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Enter' });
			const handled = result.current.handleEnterToActivate(event);

			expect(handled).toBe(true);
			expect(setActiveSessionId).toHaveBeenCalledWith('s2');
		});

		it('should skip input events from textareas', () => {
			const session1 = createMockSession({ id: 's1' });
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const mockTextarea = document.createElement('textarea');
			document.body.appendChild(mockTextarea);
			mockTextarea.focus();

			const event = new KeyboardEvent('keydown', { key: 'Enter' });
			Object.defineProperty(event, 'target', {
				value: mockTextarea,
				writable: false,
				configurable: true,
			});
			const handled = result.current.handleEnterToActivate(event);

			expect(handled).toBe(false);
			document.body.removeChild(mockTextarea);
		});
	});

	describe('handleEscapeInMain', () => {
		it('should not handle when focus is not on main', () => {
			const deps = createMockDeps({ activeFocus: 'sidebar' });
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Escape' });
			const handled = result.current.handleEscapeInMain(event);

			expect(handled).toBe(false);
		});

		it('should blur input and focus terminal on Escape in main', () => {
			const mockTextarea = document.createElement('textarea');
			const mockTerminal = document.createElement('div');
			mockTextarea.blur = vi.fn();
			mockTerminal.focus = vi.fn();

			// Focus the textarea to make it document.activeElement
			document.body.appendChild(mockTextarea);
			mockTextarea.focus();

			const inputRef = { current: mockTextarea };
			const terminalOutputRef = { current: mockTerminal };
			const deps = createMockDeps({
				activeFocus: 'main',
				inputRef,
				terminalOutputRef,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Escape' });
			const handled = result.current.handleEscapeInMain(event);

			expect(handled).toBe(true);
			expect(mockTextarea.blur).toHaveBeenCalled();
			expect(mockTerminal.focus).toHaveBeenCalled();
			document.body.removeChild(mockTextarea);
		});

		it('should not handle when input is not focused', () => {
			const mockTextarea = document.createElement('textarea');
			const inputRef = { current: mockTextarea };
			const deps = createMockDeps({
				activeFocus: 'main',
				inputRef,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Escape' });
			const handled = result.current.handleEscapeInMain(event);

			expect(handled).toBe(false);
		});
	});

	describe('sidebar index sync', () => {
		it('should sync selectedSidebarIndex when activeSessionId changes', () => {
			const session1 = createMockSession({ id: 's1' });
			const session2 = createMockSession({ id: 's2' });
			const setSelectedSidebarIndex = vi.fn();
			const deps = createMockDeps({
				sortedSessions: [session1, session2],
				navSessions: [session1, session2],
				activeSessionId: 's1',
				setSelectedSidebarIndex,
			});

			const { rerender } = renderHook(
				({ activeSessionId }) => useKeyboardNavigation({ ...deps, activeSessionId }),
				{ initialProps: { activeSessionId: 's1' } }
			);

			// Change active session
			act(() => {
				rerender({ activeSessionId: 's2' });
			});

			expect(setSelectedSidebarIndex).toHaveBeenCalledWith(1);
		});

		it('stays on the cycled occurrence when the index already points at the active session', () => {
			// A bookmarked agent appears twice in navSessions: the bookmark row (top)
			// and its group/ungrouped row below. Cycling onto the lower occurrence sets
			// selectedSidebarIndex to that row. The sync effect must NOT snap the
			// highlight back up to the first (bookmark) occurrence - that was the
			// panel-jump bug.
			const sessionA = createMockSession({ id: 'a' });
			const sessionB = createMockSession({ id: 'b', bookmarked: true });
			const setSelectedSidebarIndex = vi.fn();
			// navSessions: bookmark B (0), group A (1), group B (2). 'b' occurs at 0 and 2.
			const deps = createMockDeps({
				sortedSessions: [sessionA, sessionB],
				navSessions: [sessionB, sessionA, sessionB],
				activeSessionId: 'a',
				selectedSidebarIndex: 1,
				setSelectedSidebarIndex,
			});

			const { rerender } = renderHook(
				({ activeSessionId, selectedSidebarIndex }) =>
					useKeyboardNavigation({ ...deps, activeSessionId, selectedSidebarIndex }),
				{ initialProps: { activeSessionId: 'a', selectedSidebarIndex: 1 } }
			);
			setSelectedSidebarIndex.mockClear();

			// Cycle lands on the GROUP occurrence of B (index 2): both the active
			// session and the index move together.
			act(() => {
				rerender({ activeSessionId: 'b', selectedSidebarIndex: 2 });
			});

			// Index already points at an occurrence of 'b' (navSessions[2]), so the
			// effect bails - the highlight is NOT dragged to the bookmark row (0).
			expect(setSelectedSidebarIndex).not.toHaveBeenCalled();
		});

		it('re-resolves to the first occurrence when the current index is stale', () => {
			// When the index does NOT already point at the active session, the effect
			// falls back to findIndex (first occurrence). For a bookmarked agent that
			// is its bookmark row at the top.
			const sessionA = createMockSession({ id: 'a' });
			const sessionB = createMockSession({ id: 'b', bookmarked: true });
			const setSelectedSidebarIndex = vi.fn();
			// navSessions: bookmark B (0), group A (1), group B (2).
			const deps = createMockDeps({
				sortedSessions: [sessionA, sessionB],
				navSessions: [sessionB, sessionA, sessionB],
				activeSessionId: 'a',
				selectedSidebarIndex: 1,
				setSelectedSidebarIndex,
			});

			const { rerender } = renderHook(
				({ activeSessionId, selectedSidebarIndex }) =>
					useKeyboardNavigation({ ...deps, activeSessionId, selectedSidebarIndex }),
				{ initialProps: { activeSessionId: 'a', selectedSidebarIndex: 1 } }
			);
			setSelectedSidebarIndex.mockClear();

			// Active jumps to 'b' but the index stays at 1 (still pointing at A) - e.g.
			// an external jump that did not pre-set the index.
			act(() => {
				rerender({ activeSessionId: 'b', selectedSidebarIndex: 1 });
			});

			// Stale index → re-resolve to the first 'b' occurrence (bookmark row, 0).
			expect(setSelectedSidebarIndex).toHaveBeenCalledWith(0);
		});
	});

	describe('starred + group chat sidebar navigation', () => {
		it('ArrowUp from the first agent lands on the last starred row', () => {
			const session1 = createMockSession({ id: 's1', name: 'Session 1' });
			const setSelectedSidebarIndex = vi.fn();
			const setSidebarExtraSelection = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				selectedSidebarIndex: 0, // on the agent
				setSelectedSidebarIndex,
				setSidebarExtraSelection,
				starredItems: [makeStarred('star-a', 'p1', 'Star A')],
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(true);
			// Cursor moves into the starred section: clears the agent index, sets the token.
			expect(setSelectedSidebarIndex).toHaveBeenCalledWith(-1);
			expect(setSidebarExtraSelection).toHaveBeenCalledWith({ kind: 'starred', key: 'star-a' });
		});

		it('ArrowDown from the last agent lands on the first group chat', () => {
			const session1 = createMockSession({ id: 's1', name: 'Session 1' });
			const setSelectedSidebarIndex = vi.fn();
			const setSidebarExtraSelection = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				selectedSidebarIndex: 0,
				setSelectedSidebarIndex,
				setSidebarExtraSelection,
				groupChats: [makeGroupChat('gc1', 'Chat One')],
				groupChatsExpanded: true,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(true);
			expect(setSelectedSidebarIndex).toHaveBeenCalledWith(-1);
			expect(setSidebarExtraSelection).toHaveBeenCalledWith({ kind: 'groupChat', id: 'gc1' });
		});

		it('wraps from the last group chat down to the first starred row', () => {
			const session1 = createMockSession({ id: 's1', name: 'Session 1' });
			const setSidebarExtraSelection = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				selectedSidebarIndex: -1,
				sidebarExtraSelection: { kind: 'groupChat', id: 'gc1' }, // on the only group chat
				setSidebarExtraSelection,
				starredItems: [makeStarred('star-a', 'p1', 'Star A')],
				groupChats: [makeGroupChat('gc1', 'Chat One')],
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
			result.current.handleSidebarNavigation(event);

			// Order: [starred, agent, groupChat]; down from groupChat wraps to starred.
			expect(setSidebarExtraSelection).toHaveBeenCalledWith({ kind: 'starred', key: 'star-a' });
		});

		it('ArrowUp into a collapsed group expands it and lands on its member', () => {
			const group1: Group = { id: 'g1', name: 'Group 1', emoji: '📁', collapsed: true };
			const grouped = createMockSession({ id: 's1', groupId: 'g1' });
			const ungrouped = createMockSession({ id: 's2' });
			const setGroups = vi.fn();
			const setSelectedSidebarIndex = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [grouped, ungrouped],
				navSessions: [grouped, ungrouped], // navIndex 0 = grouped (collapsed g1), 1 = ungrouped
				bookmarkNavSize: 0,
				selectedSidebarIndex: 1, // on the ungrouped agent
				groups: [group1],
				setGroups,
				setSelectedSidebarIndex,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(true);
			// Group is expanded...
			expect(setGroups).toHaveBeenCalled();
			const updater = setGroups.mock.calls[0][0];
			expect(updater([group1])[0].collapsed).toBe(false);
			// ...and the cursor lands on the group's member (navIndex 0).
			expect(setSelectedSidebarIndex).toHaveBeenCalledWith(0);
		});

		it('ArrowUp into a collapsed starred section expands it', () => {
			const session1 = createMockSession({ id: 's1', name: 'Session 1' });
			const setStarredSectionCollapsed = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				selectedSidebarIndex: 0,
				starredItems: [makeStarred('star-a', 'p1', 'Star A')],
				starredSectionCollapsed: true,
				setStarredSectionCollapsed,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
			result.current.handleSidebarNavigation(event);

			expect(setStarredSectionCollapsed).toHaveBeenCalledWith(false);
		});

		it('excludes starred + group chats when the unread-agents filter is on', () => {
			const session1 = createMockSession({ id: 's1', name: 'Session 1' });
			const setSidebarExtraSelection = vi.fn();
			const setSelectedSidebarIndex = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				selectedSidebarIndex: 0,
				setSidebarExtraSelection,
				setSelectedSidebarIndex,
				starredItems: [makeStarred('star-a', 'p1', 'Star A')],
				groupChats: [makeGroupChat('gc1', 'Chat One')],
				showUnreadAgentsOnly: true,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			// Only one agent in the virtual order → ArrowUp wraps back onto it, never
			// touching the starred/group-chat sections.
			const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
			result.current.handleSidebarNavigation(event);

			expect(setSidebarExtraSelection).not.toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'starred' })
			);
			expect(setSidebarExtraSelection).not.toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'groupChat' })
			);
		});

		it('Enter on a starred row activates it', () => {
			const session1 = createMockSession({ id: 's1', name: 'Session 1' });
			const activateStarredItem = vi.fn();
			const starred = makeStarred('star-a', 'p1', 'Star A');
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				selectedSidebarIndex: -1,
				sidebarExtraSelection: { kind: 'starred', key: 'star-a' },
				starredItems: [starred],
				activateStarredItem,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Enter' });
			const handled = result.current.handleEnterToActivate(event);

			expect(handled).toBe(true);
			expect(activateStarredItem).toHaveBeenCalledWith(starred);
		});

		it('Enter on a group chat opens it', () => {
			const session1 = createMockSession({ id: 's1', name: 'Session 1' });
			const handleOpenGroupChat = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
				navSessions: [session1],
				selectedSidebarIndex: -1,
				sidebarExtraSelection: { kind: 'groupChat', id: 'gc1' },
				groupChats: [makeGroupChat('gc1', 'Chat One')],
				handleOpenGroupChat,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: 'Enter' });
			const handled = result.current.handleEnterToActivate(event);

			expect(handled).toBe(true);
			expect(handleOpenGroupChat).toHaveBeenCalledWith('gc1');
		});
	});

	describe('group navigation with space', () => {
		it('should collapse group and jump to next visible session on Space', () => {
			const group1: Group = { id: 'g1', name: 'Group 1', emoji: '📁', collapsed: false };
			const session1 = createMockSession({ id: 's1', groupId: 'g1' });
			const session2 = createMockSession({ id: 's2' }); // ungrouped
			const setGroups = vi.fn();
			const setSelectedSidebarIndex = vi.fn();
			const setActiveSessionId = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1, session2],
				navSessions: [session1, session2],
				bookmarkNavSize: 0,
				selectedSidebarIndex: 0,
				groups: [group1],
				setGroups,
				setSelectedSidebarIndex,
				setActiveSessionId,
			});
			const { result } = renderHook(() => useKeyboardNavigation(deps));

			const event = new KeyboardEvent('keydown', { key: ' ' });
			const handled = result.current.handleSidebarNavigation(event);

			expect(handled).toBe(true);
			expect(setGroups).toHaveBeenCalled();
			expect(setSelectedSidebarIndex).toHaveBeenCalledWith(1);
			expect(setActiveSessionId).toHaveBeenCalledWith('s2');
		});
	});
});
