import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardNavigation, UseKeyboardNavigationDeps } from '../../../renderer/hooks';
import type { Session, Group, FocusArea } from '../../../renderer/types';

// Create a mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: `session-${Date.now()}-${Math.random()}`,
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	cwd: '/test',
	projectRoot: '/test',
	fullPath: '/test',
	port: 3000,
	aiPid: 0,
	inputMode: 'ai',
	aiTabs: [
		{
			id: 'default-tab',
			name: 'Main',
			logs: [],
		},
	],
	activeTabId: 'default-tab',
	closedTabHistory: [],
	shellLogs: [],
	executionQueue: [],
	usageStats: undefined,
	contextUsage: 0,
	workLog: [],
	isGitRepo: false,
	changedFiles: [],
	gitBranches: [],
	gitTags: [],
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	isLive: false,
	...overrides,
});

// Create mock dependencies
const createMockDeps = (
	overrides: Partial<UseKeyboardNavigationDeps> = {}
): UseKeyboardNavigationDeps => ({
	sortedSessions: [],
	selectedSidebarIndex: 0,
	setSelectedSidebarIndex: vi.fn(),
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
	...overrides,
});

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
			const group1: Group = { id: 'g1', name: 'Group 1', collapsed: false };
			const session1 = createMockSession({ id: 's1', groupId: 'g1' });
			const setGroups = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1],
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
	});

	describe('group navigation with space', () => {
		it('should collapse group and jump to next visible session on Space', () => {
			const group1: Group = { id: 'g1', name: 'Group 1', collapsed: false };
			const session1 = createMockSession({ id: 's1', groupId: 'g1' });
			const session2 = createMockSession({ id: 's2' }); // ungrouped
			const setGroups = vi.fn();
			const setSelectedSidebarIndex = vi.fn();
			const setActiveSessionId = vi.fn();
			const deps = createMockDeps({
				activeFocus: 'sidebar',
				sortedSessions: [session1, session2],
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
