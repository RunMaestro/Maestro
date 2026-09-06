/**
 * @file sidebarRevealContract.test.ts
 * @description Keyboard navigation must bring its destination on screen.
 *
 * The Left Bar's scroll position belongs to the user, so it moves only when
 * something DECLARES the intent by calling `requestSidebarReveal()` - a click
 * deliberately calls nothing (see utils/sidebarReveal.ts). That design has one
 * failure mode, and it is silent: drop the call and the cursor still moves, the
 * transcript still switches, and the list simply never scrolls. The user sees a
 * shortcut that "does nothing" while it is in fact working perfectly on a row
 * they cannot see.
 *
 * It has already been dropped once, by a refactor of `cycleSession` that kept
 * every behavior it could see in the file it was editing. So the producers are
 * pinned here, on the token rather than on a scroll: the counter is the whole
 * contract between the two halves, and asserting it needs no DOM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useKeyboardNavigation } from '../../../renderer/hooks';
import type { UseKeyboardNavigationDeps } from '../../../renderer/hooks';
import { cycleSession } from '../../../renderer/hooks/session/useCycleSession';
import type { CycleSessionDeps } from '../../../renderer/hooks/session/useCycleSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { getSidebarRevealToken } from '../../../renderer/utils/sidebarReveal';
import { createMockSession } from '../../helpers/mockSession';
import { resetStores } from '../../helpers';
import type { Session, Group } from '../../../renderer/types';

const session = (id: string, name: string, groupId?: string): Session =>
	createMockSession({ id, name, groupId, cwd: '/tmp', projectRoot: '/tmp' } as never);

const sessions = [session('s1', 'Alpha'), session('s2', 'Bravo'), session('s3', 'Charlie')];
const groups: Group[] = [];
const chats = [{ id: 'gc1', name: 'Squad' }] as never[];

const starredRow = {
	kind: 'open' as const,
	key: 'open:s1:t1',
	displayName: 'A Star',
	agentName: 'Agent',
	parentSessionId: 's1',
	tabId: 't1',
};

const cycleDeps = (extra: Partial<CycleSessionDeps> = {}): CycleSessionDeps =>
	({
		sortedSessions: sessions,
		handleOpenGroupChat: vi.fn(),
		starredItems: [],
		activateStarredItem: vi.fn(),
		navIndexMap: new Map(sessions.map((s, i) => [`ungrouped:${s.id}`, i])),
		...extra,
	}) as CycleSessionDeps;

const navDeps = (extra: Partial<UseKeyboardNavigationDeps>): UseKeyboardNavigationDeps =>
	({
		sortedSessions: sessions,
		navSessions: sessions,
		bookmarkNavSize: 0,
		selectedSidebarIndex: 0,
		setSelectedSidebarIndex: vi.fn(),
		sidebarExtraSelection: null,
		setSidebarExtraSelection: vi.fn(),
		activeSessionId: 's1',
		setActiveSessionId: vi.fn(),
		activeFocus: 'sidebar',
		setActiveFocus: vi.fn(),
		groups,
		setGroups: vi.fn(),
		bookmarksCollapsed: false,
		setBookmarksCollapsed: vi.fn(),
		inputRef: { current: null },
		terminalOutputRef: { current: null },
		starredItems: [],
		activateStarredItem: vi.fn(),
		starredSectionCollapsed: false,
		setStarredSectionCollapsed: vi.fn(),
		groupChats: chats,
		handleOpenGroupChat: vi.fn(),
		groupChatsExpanded: true,
		setGroupChatsExpanded: vi.fn(),
		groupChatSortAlphabetical: false,
		showUnreadAgentsOnly: false,
		ungroupedCollapsed: false,
		setUngroupedCollapsed: vi.fn(),
		...extra,
	}) as UseKeyboardNavigationDeps;

beforeEach(() => {
	vi.clearAllMocks();
	resetStores(useSessionStore, useGroupChatStore, useUIStore, useSettingsStore);
	useSessionStore.setState({ sessions, groups, activeSessionId: 's1' } as never);
	useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: false } as never);
	useSettingsStore.setState({
		groupChatsExpanded: true,
		ungroupedCollapsed: false,
		starredSectionCollapsed: false,
	} as never);
	useGroupChatStore.setState({ groupChats: chats, activeGroupChatId: null } as never);
});

afterEach(() => cleanup());

describe('Left Bar reveal contract', () => {
	describe('Cmd+[ / Cmd+] (cycleSession)', () => {
		it('asks for a reveal when it lands on an agent', () => {
			const before = getSidebarRevealToken();

			cycleSession('next', cycleDeps());

			expect(useSessionStore.getState().activeSessionId).toBe('s2');
			expect(getSidebarRevealToken()).toBeGreaterThan(before);
		});

		it('asks for a reveal when it lands on a group chat', () => {
			const deps = cycleDeps();
			// Last agent -> the group chats section is the next thing in visual order.
			useSessionStore.setState({ activeSessionId: 's3' } as never);
			const before = getSidebarRevealToken();

			cycleSession('next', deps);

			expect(deps.handleOpenGroupChat).toHaveBeenCalledWith('gc1');
			expect(getSidebarRevealToken()).toBeGreaterThan(before);
		});

		it('asks for a reveal when it lands on a starred row', () => {
			const deps = cycleDeps({ starredItems: [starredRow] as never });
			// Starred rows sit at the very top, so walking back from the first agent
			// lands on one.
			const before = getSidebarRevealToken();

			cycleSession('prev', deps);

			expect(deps.activateStarredItem).toHaveBeenCalled();
			expect(getSidebarRevealToken()).toBeGreaterThan(before);
		});
	});

	describe('arrow keys', () => {
		it('asks for a reveal when the cursor moves', () => {
			const { result } = renderHook(() => useKeyboardNavigation(navDeps({})));
			const before = getSidebarRevealToken();

			act(() => {
				result.current.handleSidebarNavigation(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
			});

			expect(getSidebarRevealToken()).toBeGreaterThan(before);
		});
	});

	describe('clicks', () => {
		it('does not ask for a reveal when an agent simply becomes active', () => {
			const before = getSidebarRevealToken();

			// What a click does: set the active agent. The user is already looking at
			// the row they clicked, and re-aiming a list they scrolled by hand reads
			// as the panel fighting them.
			useSessionStore.getState().setActiveSessionId('s3');

			expect(getSidebarRevealToken()).toBe(before);
		});
	});
});
