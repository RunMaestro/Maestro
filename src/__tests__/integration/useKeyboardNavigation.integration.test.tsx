import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	useKeyboardNavigation,
	type UseKeyboardNavigationDeps,
} from '../../renderer/hooks/keyboard/useKeyboardNavigation';
import type { Group, Session } from '../../renderer/types';

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session 1',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		projectRoot: '/repo',
		fullPath: '/repo',
		port: 3000,
		aiPid: 0,
		inputMode: 'ai',
		aiTabs: [{ id: 'tab-1', name: 'Main', logs: [] }],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		shellLogs: [],
		executionQueue: [],
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
	};
}

function deps(overrides: Partial<UseKeyboardNavigationDeps> = {}): UseKeyboardNavigationDeps {
	const sortedSessions = overrides.sortedSessions ?? [];
	const navSessions = overrides.navSessions ?? sortedSessions;
	return {
		sortedSessions,
		navSessions,
		bookmarkNavSize: 0,
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
		sortedSessions,
		navSessions,
	};
}

function keyboardEvent(
	key: string,
	init: KeyboardEventInit = {},
	target?: HTMLElement
): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
	if (target) {
		Object.defineProperty(event, 'target', {
			value: target,
			configurable: true,
		});
	}
	return event;
}

function renderNavigation(overrides: Partial<UseKeyboardNavigationDeps> = {}) {
	return renderHook((props: UseKeyboardNavigationDeps) => useKeyboardNavigation(props), {
		initialProps: deps(overrides),
	});
}

describe('useKeyboardNavigation integration', () => {
	afterEach(() => {
		document.body.innerHTML = '';
		vi.restoreAllMocks();
	});

	it('guards sidebar navigation for wrong focus, editable targets, layout shortcuts, and empty lists', () => {
		expect(
			renderNavigation({ activeFocus: 'main' }).result.current.handleSidebarNavigation(
				keyboardEvent('ArrowDown')
			)
		).toBe(false);

		expect(
			renderNavigation({ activeFocus: 'sidebar' }).result.current.handleSidebarNavigation(
				keyboardEvent('a')
			)
		).toBe(false);

		const input = document.createElement('input');
		const textarea = document.createElement('textarea');
		const editable = document.createElement('div');
		Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true });

		const editableNavigation = renderNavigation({ activeFocus: 'sidebar' });
		expect(
			editableNavigation.result.current.handleSidebarNavigation(
				keyboardEvent('ArrowDown', {}, input)
			)
		).toBe(false);
		expect(
			editableNavigation.result.current.handleSidebarNavigation(
				keyboardEvent('ArrowDown', {}, textarea)
			)
		).toBe(false);
		expect(
			editableNavigation.result.current.handleSidebarNavigation(
				keyboardEvent('ArrowDown', {}, editable)
			)
		).toBe(false);
		expect(
			editableNavigation.result.current.handleSidebarNavigation(
				keyboardEvent('ArrowLeft', { altKey: true, metaKey: true })
			)
		).toBe(false);
		expect(
			editableNavigation.result.current.handleSidebarNavigation(
				keyboardEvent('ArrowRight', { altKey: true, ctrlKey: true })
			)
		).toBe(false);

		const emptyEvent = keyboardEvent('ArrowDown');
		const preventDefault = vi.spyOn(emptyEvent, 'preventDefault');
		expect(editableNavigation.result.current.handleSidebarNavigation(emptyEvent)).toBe(true);
		expect(preventDefault).toHaveBeenCalled();
	});

	it('collapses and expands bookmarks and groups from the selected sidebar row', () => {
		const expandedGroup: Group = { id: 'group-1', name: 'Group 1', collapsed: false };
		const collapsedGroup: Group = { id: 'group-2', name: 'Group 2', collapsed: true };
		const setBookmarksCollapsed = vi.fn();
		const setGroups = vi.fn();
		const navigation = renderNavigation({
			activeFocus: 'sidebar',
			sortedSessions: [
				session({ id: 'bookmarked', bookmarked: true }),
				session({ id: 'expanded-member', groupId: 'group-1' }),
				session({ id: 'collapsed-member', groupId: 'group-2' }),
				session({ id: 'plain' }),
			],
			bookmarkNavSize: 1,
			selectedSidebarIndex: 0,
			groups: [expandedGroup, collapsedGroup],
			setBookmarksCollapsed,
			setGroups,
		});

		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowLeft'))).toBe(
			true
		);
		expect(setBookmarksCollapsed).toHaveBeenCalledWith(true);

		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [
					session({ id: 'bookmarked', bookmarked: true }),
					session({ id: 'expanded-member', groupId: 'group-1' }),
					session({ id: 'collapsed-member', groupId: 'group-2' }),
					session({ id: 'plain' }),
				],
				bookmarkNavSize: 1,
				selectedSidebarIndex: 0,
				bookmarksCollapsed: true,
				groups: [expandedGroup, collapsedGroup],
				setBookmarksCollapsed,
				setGroups,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowRight'))).toBe(
			true
		);
		expect(setBookmarksCollapsed).toHaveBeenCalledWith(false);

		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [
					session({ id: 'bookmarked', bookmarked: true }),
					session({ id: 'expanded-member', groupId: 'group-1' }),
					session({ id: 'collapsed-member', groupId: 'group-2' }),
					session({ id: 'plain' }),
				],
				selectedSidebarIndex: 1,
				groups: [expandedGroup, collapsedGroup],
				setGroups,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowLeft'))).toBe(
			true
		);
		expect(setGroups).toHaveBeenLastCalledWith(expect.any(Function));
		expect(setGroups.mock.lastCall?.[0]([expandedGroup, collapsedGroup])[0].collapsed).toBe(true);

		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [
					session({ id: 'bookmarked', bookmarked: true }),
					session({ id: 'expanded-member', groupId: 'group-1' }),
					session({ id: 'collapsed-member', groupId: 'group-2' }),
					session({ id: 'plain' }),
				],
				selectedSidebarIndex: 2,
				groups: [expandedGroup, collapsedGroup],
				setGroups,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowRight'))).toBe(
			true
		);
		expect(setGroups.mock.lastCall?.[0]([expandedGroup, collapsedGroup])[1].collapsed).toBe(false);

		const groupCalls = setGroups.mock.calls.length;
		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [session({ id: 'missing-member', groupId: 'missing' })],
				selectedSidebarIndex: 0,
				groups: [],
				setGroups,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowLeft'))).toBe(
			true
		);
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowRight'))).toBe(
			true
		);
		expect(setGroups).toHaveBeenCalledTimes(groupCalls);
	});

	it('navigates through visible sessions and expands collapsed groups in travel direction', () => {
		const collapsedGroup: Group = { id: 'group-1', name: 'Group 1', collapsed: true };
		const expandedGroup: Group = { id: 'group-2', name: 'Group 2', collapsed: false };
		const sessions = [
			session({ id: 'top' }),
			session({ id: 'hidden-1', groupId: 'group-1' }),
			session({ id: 'hidden-2', groupId: 'group-1' }),
			session({ id: 'open-1', groupId: 'group-2' }),
			session({ id: 'bottom' }),
		];
		const setGroups = vi.fn();
		const setSelectedSidebarIndex = vi.fn();
		const navigation = renderNavigation({
			activeFocus: 'sidebar',
			sortedSessions: sessions,
			selectedSidebarIndex: 0,
			groups: [collapsedGroup, expandedGroup],
			setGroups,
			setSelectedSidebarIndex,
		});

		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowDown'))).toBe(
			true
		);
		expect(setSelectedSidebarIndex).toHaveBeenLastCalledWith(1);
		expect(setGroups.mock.lastCall?.[0]([collapsedGroup, expandedGroup])[0].collapsed).toBe(false);

		setGroups.mockClear();
		setSelectedSidebarIndex.mockClear();
		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [session({ id: 'ungrouped-1' }), session({ id: 'ungrouped-2' })],
				selectedSidebarIndex: 0,
				groups: [],
				setGroups,
				setSelectedSidebarIndex,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowDown'))).toBe(
			true
		);
		expect(setSelectedSidebarIndex).toHaveBeenCalledWith(1);
		expect(setGroups).not.toHaveBeenCalled();

		setSelectedSidebarIndex.mockClear();
		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [session({ id: 'ungrouped-1' }), session({ id: 'ungrouped-2' })],
				selectedSidebarIndex: 1,
				groups: [],
				setGroups,
				setSelectedSidebarIndex,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowUp'))).toBe(true);
		expect(setSelectedSidebarIndex).toHaveBeenCalledWith(0);

		setGroups.mockClear();
		setSelectedSidebarIndex.mockClear();
		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: sessions,
				selectedSidebarIndex: 2,
				groups: [collapsedGroup, expandedGroup],
				setGroups,
				setSelectedSidebarIndex,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowDown'))).toBe(
			true
		);
		expect(setSelectedSidebarIndex).toHaveBeenCalledWith(3);
		expect(setGroups).not.toHaveBeenCalled();

		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: sessions,
				selectedSidebarIndex: 4,
				groups: [collapsedGroup, expandedGroup],
				setGroups,
				setSelectedSidebarIndex,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowUp'))).toBe(true);
		expect(setSelectedSidebarIndex).toHaveBeenLastCalledWith(3);

		setGroups.mockClear();
		setSelectedSidebarIndex.mockClear();
		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: sessions,
				selectedSidebarIndex: 3,
				groups: [collapsedGroup, expandedGroup],
				setGroups,
				setSelectedSidebarIndex,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent('ArrowUp'))).toBe(true);
		expect(setSelectedSidebarIndex).toHaveBeenCalledWith(2);
		expect(setGroups.mock.lastCall?.[0]([collapsedGroup, expandedGroup])[0].collapsed).toBe(false);
	});

	it('collapses grouped rows with Space and jumps to the nearest visible session', () => {
		const group1: Group = { id: 'group-1', name: 'Group 1', collapsed: false };
		const group2: Group = { id: 'group-2', name: 'Group 2', collapsed: false };
		const setGroups = vi.fn();
		const setSelectedSidebarIndex = vi.fn();
		const setActiveSessionId = vi.fn();
		const navigation = renderNavigation({
			activeFocus: 'sidebar',
			sortedSessions: [
				session({ id: 'group-row-1', groupId: 'group-1' }),
				session({ id: 'group-row-2', groupId: 'group-1' }),
				session({ id: 'next-visible', groupId: 'group-2' }),
			],
			selectedSidebarIndex: 0,
			groups: [group1, group2],
			setGroups,
			setSelectedSidebarIndex,
			setActiveSessionId,
		});

		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent(' '))).toBe(true);
		expect(setGroups.mock.lastCall?.[0]([group1, group2])[0].collapsed).toBe(true);
		expect(setSelectedSidebarIndex).toHaveBeenCalledWith(2);
		expect(setActiveSessionId).toHaveBeenCalledWith('next-visible');

		setSelectedSidebarIndex.mockClear();
		setActiveSessionId.mockClear();
		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [
					session({ id: 'previous-visible' }),
					session({ id: 'group-row-1', groupId: 'group-1' }),
					session({ id: 'group-row-2', groupId: 'group-1' }),
				],
				selectedSidebarIndex: 2,
				groups: [group1],
				setGroups,
				setSelectedSidebarIndex,
				setActiveSessionId,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent(' '))).toBe(true);
		expect(setSelectedSidebarIndex).toHaveBeenCalledWith(0);
		expect(setActiveSessionId).toHaveBeenCalledWith('previous-visible');

		setSelectedSidebarIndex.mockClear();
		setActiveSessionId.mockClear();
		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [session({ id: 'only-row', groupId: 'group-1' })],
				selectedSidebarIndex: 0,
				groups: [group1],
				setGroups,
				setSelectedSidebarIndex,
				setActiveSessionId,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent(' '))).toBe(true);
		expect(setSelectedSidebarIndex).not.toHaveBeenCalled();
		expect(setActiveSessionId).not.toHaveBeenCalled();

		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: [session({ id: 'ungrouped' })],
				selectedSidebarIndex: 0,
			}),
		});
		expect(navigation.result.current.handleSidebarNavigation(keyboardEvent(' '))).toBe(false);
	});

	it('cycles panel focus with Tab while preserving input-owned tab handling', async () => {
		const input = document.createElement('textarea');
		document.body.appendChild(input);
		const setActiveFocus = vi.fn();
		const navigation = renderNavigation({
			activeFocus: 'sidebar',
			setActiveFocus,
			inputRef: { current: input },
		});

		expect(navigation.result.current.handleTabNavigation(keyboardEvent('Enter'))).toBe(false);
		expect(navigation.result.current.handleTabNavigation(keyboardEvent('Tab'))).toBe(true);
		expect(setActiveFocus).toHaveBeenCalledWith('main');
		await waitFor(() => expect(document.activeElement).toBe(input));

		input.focus();
		expect(navigation.result.current.handleTabNavigation(keyboardEvent('Tab'))).toBe(false);

		input.blur();
		setActiveFocus.mockClear();
		navigation.rerender({
			...deps({ activeFocus: 'main', setActiveFocus, inputRef: { current: input } }),
		});
		expect(navigation.result.current.handleTabNavigation(keyboardEvent('Tab'))).toBe(true);
		expect(setActiveFocus).toHaveBeenCalledWith('right');
		expect(
			navigation.result.current.handleTabNavigation(keyboardEvent('Tab', { shiftKey: true }))
		).toBe(true);
		expect(setActiveFocus).toHaveBeenLastCalledWith('sidebar');

		navigation.rerender({
			...deps({ activeFocus: 'right', setActiveFocus, inputRef: { current: input } }),
		});
		expect(navigation.result.current.handleTabNavigation(keyboardEvent('Tab'))).toBe(true);
		expect(setActiveFocus).toHaveBeenLastCalledWith('sidebar');

		navigation.rerender({
			...deps({ activeFocus: 'sidebar', setActiveFocus, inputRef: { current: input } }),
		});
		expect(
			navigation.result.current.handleTabNavigation(keyboardEvent('Tab', { shiftKey: true }))
		).toBe(true);
		expect(setActiveFocus).toHaveBeenLastCalledWith('right');
	});

	it('activates selected sessions with Enter and ignores modifier or editable Enter events', () => {
		const setActiveSessionId = vi.fn();
		const sessions = [session({ id: 'first' }), session({ id: 'second' })];
		const navigation = renderNavigation({
			activeFocus: 'sidebar',
			sortedSessions: sessions,
			selectedSidebarIndex: 1,
			setActiveSessionId,
		});

		expect(
			navigation.result.current.handleEnterToActivate(keyboardEvent('Enter', { metaKey: true }))
		).toBe(false);
		expect(navigation.result.current.handleEnterToActivate(keyboardEvent('Escape'))).toBe(false);

		const textarea = document.createElement('textarea');
		expect(
			navigation.result.current.handleEnterToActivate(keyboardEvent('Enter', {}, textarea))
		).toBe(false);

		expect(navigation.result.current.handleEnterToActivate(keyboardEvent('Enter'))).toBe(true);
		expect(setActiveSessionId).toHaveBeenCalledWith('second');

		setActiveSessionId.mockClear();
		navigation.rerender({
			...deps({
				activeFocus: 'sidebar',
				sortedSessions: sessions,
				selectedSidebarIndex: 9,
				setActiveSessionId,
			}),
		});
		expect(navigation.result.current.handleEnterToActivate(keyboardEvent('Enter'))).toBe(true);
		expect(setActiveSessionId).not.toHaveBeenCalled();
	});

	it('handles Escape from the main input and syncs selected sidebar index from active session changes', () => {
		const input = document.createElement('textarea');
		const terminal = document.createElement('div');
		document.body.append(input, terminal);
		input.focus();
		const inputBlur = vi.spyOn(input, 'blur');
		const terminalFocus = vi.spyOn(terminal, 'focus');
		const navigation = renderNavigation({
			activeFocus: 'main',
			inputRef: { current: input },
			terminalOutputRef: { current: terminal },
		});

		expect(navigation.result.current.handleEscapeInMain(keyboardEvent('Enter'))).toBe(false);
		expect(navigation.result.current.handleEscapeInMain(keyboardEvent('Escape'))).toBe(true);
		expect(inputBlur).toHaveBeenCalled();
		expect(terminalFocus).toHaveBeenCalled();

		input.blur();
		expect(navigation.result.current.handleEscapeInMain(keyboardEvent('Escape'))).toBe(false);

		const setSelectedSidebarIndex = vi.fn();
		const sessions = [session({ id: 'first' }), session({ id: 'second' })];
		const synced = renderHook(
			({ activeSessionId }: { activeSessionId: string | null }) =>
				useKeyboardNavigation(
					deps({
						sortedSessions: sessions,
						activeSessionId,
						setSelectedSidebarIndex,
					})
				),
			{ initialProps: { activeSessionId: 'first' } }
		);

		act(() => {
			synced.rerender({ activeSessionId: 'second' });
		});
		expect(setSelectedSidebarIndex).toHaveBeenCalledWith(1);
	});
});
