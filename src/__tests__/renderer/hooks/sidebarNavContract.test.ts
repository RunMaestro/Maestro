/**
 * @file sidebarNavContract.test.ts
 * @description The arrow-keys-vs-Cmd+[] divergence, written down.
 *
 * Pedram's ruling, verbatim: "arrow keys (when the agent panel is in focus) will
 * expand hidden elements, different behavior than cmd+[] that's by design!"
 *
 * So the two paths are deliberately NOT the same, and the difference is the
 * thing most likely to be "tidied up" by someone who finds it inconsistent:
 *
 *   ArrowDown / ArrowUp into a collapsed section -> EXPAND it, land on it
 *   Cmd+] / Cmd+[ past a collapsed section       -> LEAVE it collapsed, skip it
 *
 * "Visible" throughout means drawn anywhere in the scrollable list, not
 * currently in the viewport. Scroll position is irrelevant; expand/collapse and
 * archive state decide membership. A collapsed section still paints its agents
 * as pills, but those pills carry no `data-nav-key` and no keyboard highlight,
 * so a cursor parked on one is a cursor the user cannot see - which is why
 * arrows expand rather than merely stopping.
 *
 * Parameterized over every section so a sixth cannot ship with only one of the
 * two behaviors, and asserting THE COLLAPSE FLAG'S VALUE after the action, not
 * just where the cursor landed. A cursor-only assertion passes for the wrong
 * reason wherever the two paths happen to agree.
 *
 * One asymmetry to know when reading failures: `useCycleSession` already
 * honored every collapse flag before this contract existed, so the Cmd+[]
 * rows pass against the unfixed code. Only the arrow rows carry signal for the
 * Ungrouped fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useKeyboardNavigation } from '../../../renderer/hooks';
import type { UseKeyboardNavigationDeps } from '../../../renderer/hooks';
import { useCycleSession } from '../../../renderer/hooks/session/useCycleSession';
import type { UseCycleSessionDeps } from '../../../renderer/hooks/session/useCycleSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useCenterFlashStore } from '../../../renderer/stores/centerFlashStore';
import { createMockSession } from '../../helpers/mockSession';
import type { Session, Group } from '../../../renderer/types';

const session = (id: string, name: string, groupId?: string): Session =>
	createMockSession({ id, name, groupId, cwd: '/tmp', projectRoot: '/tmp' } as never);

const group = (id: string, name: string, collapsed = false): Group =>
	({ id, name, collapsed }) as Group;

const groupChat = (id: string, name: string) => ({ id, name }) as never;

/**
 * One collapsible section, described by everything the two paths need to know
 * about it. `collapse` and `readCollapsed` operate on whichever store actually
 * owns the flag, which differs per section - that scatter is exactly why this
 * has to be a table rather than five hand-written tests.
 */
interface SectionCase {
	name: string;
	/** Put the world in a state where this section exists and is collapsed. */
	collapse: () => void;
	/** Read the flag back after the action. */
	readCollapsed: () => boolean;
	/** Extra deps the arrow-nav hook needs for this section. */
	navDeps: () => Partial<UseKeyboardNavigationDeps>;
}

describe('sidebar navigation contract: arrows expand, Cmd+[] skips', () => {
	const sessions = [
		session('bm-1', 'Bookmarked', undefined),
		session('grp-1', 'In Group', 'g1'),
		session('ung-1', 'Ungrouped One'),
		session('ung-2', 'Ungrouped Two'),
	];
	sessions[0].bookmarked = true;

	const groups = [group('g1', 'Group One')];
	const chats = [groupChat('gc-1', 'Chat One')];

	/** Mutable collapse flags, since several live in different stores. */
	let collapsedFlags: Record<string, boolean>;
	let setGroups: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		collapsedFlags = {
			bookmarks: false,
			starred: false,
			ungrouped: false,
			groupChats: false,
			'group:g1': false,
		};
		setGroups = vi.fn((updater: unknown) => {
			const next =
				typeof updater === 'function'
					? (updater as (g: Group[]) => Group[])(groups.map((g) => ({ ...g })))
					: (updater as Group[]);
			collapsedFlags['group:g1'] = next.find((g) => g.id === 'g1')?.collapsed ?? false;
		});
		useSessionStore.setState({
			sessions,
			activeSessionId: 'bm-1',
			cyclePosition: -1,
		} as never);
		useGroupChatStore.setState({ groupChats: chats, activeGroupChatId: null } as never);
		useUIStore.setState({
			leftSidebarOpen: true,
			bookmarksCollapsed: false,
			sidebarExtraSelection: null,
			selectedSidebarIndex: 0,
		} as never);
		useSettingsStore.setState({
			groupChatsExpanded: true,
			groupChatSortAlphabetical: false,
			ungroupedCollapsed: false,
			starredSessionsCollapsed: false,
		} as never);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	const CASES: SectionCase[] = [
		{
			name: 'bookmarks',
			collapse: () => {
				collapsedFlags.bookmarks = true;
			},
			readCollapsed: () => collapsedFlags.bookmarks,
			navDeps: () => ({
				bookmarksCollapsed: true,
				setBookmarksCollapsed: ((v: boolean) => {
					collapsedFlags.bookmarks = v;
				}) as never,
			}),
		},
		{
			name: 'group:g1',
			collapse: () => {
				collapsedFlags['group:g1'] = true;
			},
			readCollapsed: () => collapsedFlags['group:g1'],
			navDeps: () => ({
				groups: [group('g1', 'Group One', true)],
				setGroups: setGroups as never,
			}),
		},
		{
			name: 'ungrouped',
			collapse: () => {
				collapsedFlags.ungrouped = true;
			},
			readCollapsed: () => collapsedFlags.ungrouped,
			navDeps: () => ({
				ungroupedCollapsed: true,
				setUngroupedCollapsed: ((v: boolean) => {
					collapsedFlags.ungrouped = v;
				}) as never,
			}),
		},
		{
			name: 'groupChats',
			collapse: () => {
				collapsedFlags.groupChats = true;
			},
			readCollapsed: () => collapsedFlags.groupChats,
			navDeps: () => ({
				groupChatsExpanded: false,
				setGroupChatsExpanded: ((v: boolean) => {
					collapsedFlags.groupChats = !v;
				}) as never,
			}),
		},
		{
			name: 'starred',
			collapse: () => {
				collapsedFlags.starred = true;
			},
			readCollapsed: () => collapsedFlags.starred,
			navDeps: () => ({
				starredItems: [
					{
						kind: 'open' as const,
						key: 'open:bm-1:t1',
						displayName: 'A Star',
						agentName: 'Agent',
						parentSessionId: 'bm-1',
						tabId: 't1',
					},
				] as never,
				starredSectionCollapsed: true,
				setStarredSectionCollapsed: ((v: boolean) => {
					collapsedFlags.starred = v;
				}) as never,
			}),
		},
	];

	const navDeps = (extra: Partial<UseKeyboardNavigationDeps>): UseKeyboardNavigationDeps =>
		({
			sortedSessions: sessions,
			navSessions: sessions,
			bookmarkNavSize: 1,
			selectedSidebarIndex: 0,
			setSelectedSidebarIndex: vi.fn(),
			sidebarExtraSelection: null,
			setSidebarExtraSelection: vi.fn(),
			activeSessionId: 'bm-1',
			setActiveSessionId: vi.fn(),
			activeFocus: 'sidebar',
			setActiveFocus: vi.fn(),
			groups,
			setGroups: setGroups as never,
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

	const cycleDeps = (): UseCycleSessionDeps =>
		({
			sortedSessions: sessions,
			handleOpenGroupChat: vi.fn(),
			starredItems: [],
			activateStarredItem: vi.fn(),
			navIndexMap: new Map(sessions.map((s, i) => [`ungrouped:${s.id}`, i])),
		}) as UseCycleSessionDeps;

	/**
	 * Arrow nav with a cursor that actually moves.
	 *
	 * The hook takes the cursor as a prop and reports moves through a setter, so
	 * a harness that passes a fixed index and a `vi.fn()` setter never advances -
	 * every press re-runs from row 0 and nothing ever crosses a section boundary.
	 * That version passed nothing and would have "failed" identically against a
	 * correct implementation.
	 */
	const renderArrowNav = (section: SectionCase) => {
		let index = 0;
		let extra: unknown = null;
		const build = (startIndex?: number): UseKeyboardNavigationDeps => {
			if (startIndex !== undefined) index = startIndex;
			return navDeps({
				...section.navDeps(),
				selectedSidebarIndex: index,
				sidebarExtraSelection: extra as never,
				setSelectedSidebarIndex: ((v: number | ((p: number) => number)) => {
					index = typeof v === 'function' ? v(index) : v;
				}) as never,
				setSidebarExtraSelection: ((v: unknown) => {
					extra = v;
				}) as never,
			});
		};
		const hook = renderHook((props: UseKeyboardNavigationDeps) => useKeyboardNavigation(props), {
			initialProps: build(),
		});
		return {
			press(key: 'ArrowDown' | 'ArrowUp', times: number, from?: number) {
				hook.rerender(build(from));
				for (let i = 0; i < times; i++) {
					act(() => {
						hook.result.current.handleSidebarNavigation(new KeyboardEvent('keydown', { key }));
					});
					// Re-render so the hook's refs see the moved cursor AND any collapse
					// flag the previous press just flipped.
					hook.rerender(build());
				}
			},
		};
	};

	const LAST_INDEX = 3;

	describe.each(CASES)('$name', (section) => {
		// Starred sits above every other section, so there is no row above it to
		// walk DOWN from; that direction is unreachable by construction rather than
		// unimplemented. Group chats sit below everything, so the mirror applies.
		const canEnterGoingDown = section.name !== 'starred';
		const canEnterGoingUp = section.name !== 'groupChats';

		it.runIf(canEnterGoingDown)(
			'ArrowDown expands the collapsed section rather than skipping it',
			() => {
				section.collapse();
				renderArrowNav(section).press('ArrowDown', LAST_INDEX + 4, 0);
				expect(section.readCollapsed()).toBe(false);
			}
		);

		it.runIf(canEnterGoingUp)(
			'ArrowUp expands the collapsed section rather than skipping it',
			() => {
				section.collapse();
				renderArrowNav(section).press('ArrowUp', LAST_INDEX + 4, LAST_INDEX);
				expect(section.readCollapsed()).toBe(false);
			}
		);

		it('Cmd+] leaves the collapsed section collapsed', () => {
			section.collapse();
			applyCollapseToStores(collapsedFlags);
			const { result } = renderHook(() => useCycleSession(cycleDeps()));

			act(() => {
				for (let i = 0; i < sessions.length + 3; i++) result.current.cycleSession('next');
			});

			expect(section.readCollapsed()).toBe(true);
		});

		it('Cmd+[ leaves the collapsed section collapsed', () => {
			section.collapse();
			applyCollapseToStores(collapsedFlags);
			const { result } = renderHook(() => useCycleSession(cycleDeps()));

			act(() => {
				for (let i = 0; i < sessions.length + 3; i++) result.current.cycleSession('prev');
			});

			expect(section.readCollapsed()).toBe(true);
		});
	});
});

/**
 * Membership: the cycle walks exactly the rows the sidebar draws.
 *
 * The text filter and the archived toggle both change which rows exist, and
 * both used to be a `useState` private to the component that owned them - so
 * Cmd+[ / Cmd+] could not see either one and happily activated agents that were
 * not on screen. They now live in `uiStore`, which is what makes this testable
 * at all: before the lift there was no way to set the filter from outside the
 * component.
 */
describe('sidebar navigation contract: the cycle walks what is drawn', () => {
	const sessions = [
		createMockSession({ id: 'alpha', name: 'Alpha', cwd: '/tmp', projectRoot: '/tmp' } as never),
		createMockSession({ id: 'echo', name: 'Echo', cwd: '/tmp', projectRoot: '/tmp' } as never),
		createMockSession({ id: 'gamma', name: 'Gamma', cwd: '/tmp', projectRoot: '/tmp' } as never),
	];

	const deps = (): UseCycleSessionDeps =>
		({
			sortedSessions: sessions,
			handleOpenGroupChat: vi.fn(),
			starredItems: [],
			activateStarredItem: vi.fn(),
			navIndexMap: new Map(sessions.map((s, i) => [`ungrouped:${s.id}`, i])),
		}) as UseCycleSessionDeps;

	const activeId = () => useSessionStore.getState().activeSessionId;

	beforeEach(() => {
		useSessionStore.setState({
			sessions,
			groups: [],
			activeSessionId: 'alpha',
			cyclePosition: -1,
		} as never);
		useGroupChatStore.setState({ groupChats: [], activeGroupChatId: null } as never);
		useUIStore.setState({
			leftSidebarOpen: true,
			bookmarksCollapsed: true,
			sidebarExtraSelection: null,
			selectedSidebarIndex: 0,
			sessionFilter: '',
			showArchivedGroupChats: false,
			showUnreadAgentsOnly: false,
		} as never);
		useSettingsStore.setState({
			groupChatsExpanded: true,
			groupChatSortAlphabetical: false,
			ungroupedCollapsed: false,
			starredSessionsCollapsed: true,
		} as never);
		useCenterFlashStore.setState({ active: null } as never);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('skips agents the filter has hidden', () => {
		useUIStore.setState({ sessionFilter: 'a' } as never); // Alpha + Gamma match; Echo does not
		const { result } = renderHook(() => useCycleSession(deps()));

		act(() => {
			result.current.cycleSession('next');
		});

		// Echo is not drawn, so the cursor may not land on it.
		expect(activeId()).toBe('gamma');
	});

	it('cycles only within the filtered set, wrapping inside it', () => {
		useUIStore.setState({ sessionFilter: 'a' } as never);
		const { result } = renderHook(() => useCycleSession(deps()));

		act(() => {
			result.current.cycleSession('next');
		});
		expect(activeId()).toBe('gamma');
		act(() => {
			result.current.cycleSession('next');
		});
		expect(activeId()).toBe('alpha');
	});

	it('does not move the cursor when the filter matches nothing, and says why', () => {
		useUIStore.setState({ sessionFilter: 'kubern' } as never);
		const { result } = renderHook(() => useCycleSession(deps()));

		act(() => {
			result.current.cycleSession('next');
		});

		expect(activeId()).toBe('alpha');
		// A shortcut that does nothing and explains nothing is indistinguishable
		// from a broken one, so the inert case has to be audible.
		expect(useCenterFlashStore.getState().active?.message).toMatch(/no agents match/i);
	});

	it('stays silent when there is simply nothing to cycle', () => {
		// No filter, no unread filter: nothing to correct, so no flash. A flash on
		// every stray Cmd+] in an empty workspace is noise, not help.
		useSessionStore.setState({ sessions: [], activeSessionId: null } as never);
		const { result } = renderHook(() => useCycleSession({ ...deps(), sortedSessions: [] }));

		act(() => {
			result.current.cycleSession('next');
		});

		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('skips archived group chats until the toggle is on', () => {
		const live = { id: 'gc-live', name: 'Live Chat' } as never;
		const archived = { id: 'gc-old', name: 'Old Chat', archived: true } as never;
		useSessionStore.setState({ sessions: [sessions[0]], activeSessionId: 'alpha' } as never);
		useGroupChatStore.setState({ groupChats: [live, archived], activeGroupChatId: null } as never);

		// The real handler marks the chat active, and the cycle reads that back to
		// know where the cursor is. A mock that only records the call leaves the
		// cursor parked on the agent, so every press re-opens the first chat.
		const handleOpenGroupChat = vi.fn((id: string) => {
			useGroupChatStore.setState({ activeGroupChatId: id } as never);
		});
		// One act() per press: the hook subscribes to activeGroupChatId, so calls
		// batched into a single act all run against the pre-render value.
		const press = (hook: { result: { current: { cycleSession: (d: 'next') => void } } }) =>
			act(() => {
				hook.result.current.cycleSession('next');
			});

		const hidden = renderHook(() =>
			useCycleSession({ ...deps(), sortedSessions: [sessions[0]], handleOpenGroupChat })
		);
		press(hidden);
		press(hidden);
		expect(handleOpenGroupChat).not.toHaveBeenCalledWith('gc-old');
		hidden.unmount();

		// Turning the toggle on draws the archived chat, so the cycle must reach it.
		useUIStore.setState({ showArchivedGroupChats: true } as never);
		useGroupChatStore.setState({ activeGroupChatId: null } as never);
		useSessionStore.setState({ cyclePosition: -1, activeSessionId: 'alpha' } as never);
		const shown = renderHook(() =>
			useCycleSession({ ...deps(), sortedSessions: [sessions[0]], handleOpenGroupChat })
		);
		press(shown);
		press(shown);
		expect(handleOpenGroupChat).toHaveBeenCalledWith('gc-old');
	});

	it('skips read agents while the unread filter is on', () => {
		// Echo is the only one with an unread tab; Alpha stays reachable because it
		// is active, and an active row that vanished would leave the cycle with no
		// position to move from.
		const withUnread = sessions.map((s) =>
			s.id === 'echo' ? { ...s, aiTabs: [{ id: 't', name: 'Main', hasUnread: true }] } : s
		);
		useSessionStore.setState({ sessions: withUnread, activeSessionId: 'alpha' } as never);
		useUIStore.setState({ showUnreadAgentsOnly: true } as never);
		const { result } = renderHook(() =>
			useCycleSession({ ...deps(), sortedSessions: withUnread as never })
		);

		act(() => {
			result.current.cycleSession('next');
		});

		expect(activeId()).toBe('echo');
	});
});

/** Push the table's flags into the stores the cycle hook reads them from. */
function applyCollapseToStores(flags: Record<string, boolean>): void {
	useUIStore.setState({ bookmarksCollapsed: flags.bookmarks } as never);
	useSettingsStore.setState({
		ungroupedCollapsed: flags.ungrouped,
		groupChatsExpanded: !flags.groupChats,
		starredSessionsCollapsed: flags.starred,
	} as never);
}
