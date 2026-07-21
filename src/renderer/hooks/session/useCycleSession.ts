/**
 * cycleSession - Cmd+Shift+[/] agent / group-chat cycling.
 *
 * PERF: All store reads happen at event time via `getState()`. No React
 * subscriptions, so MaestroConsoleInner does not re-render when sessions,
 * groups, or UI layout change. A thin `useCycleSession` wrapper keeps a
 * stable callback identity for the keyboard handler.
 *
 * Cycles through sessions and group chats in visual Left Bar order:
 *   - Bookmarks (sessions can appear in both bookmark + regular location)
 *   - Worktree children, collapsed groups, collapsed sidebar
 *   - Group chats and starred rows
 *
 * Reads from: sessionStore, groupChatStore, uiStore, settingsStore
 */

import { useCallback, useRef } from 'react';
import type { Session } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { compareNamesIgnoringEmojis } from './useSortedSessions';
import type { StarredItem } from './useStarredItems';
import { useSidebarNavStore } from '../../stores/sidebarNavStore';

// ============================================================================
// Dependencies
// ============================================================================

export interface CycleSessionDeps {
	/**
	 * Sorted sessions (sidebar collapsed). Prefer omitting and letting event-time
	 * code read {@link useSidebarNavStore}; tests may pass an explicit list.
	 */
	sortedSessions?: Session[];
	/** Open a group chat (loads messages etc.) */
	handleOpenGroupChat: (groupChatId: string) => void;
	/**
	 * Starred Sessions rows. Prefer omitting for production (sidebarNavStore);
	 * tests may pass fixtures.
	 */
	starredItems?: StarredItem[];
	/** Activate a starred row. Prefer omitting for production (sidebarNavStore). */
	activateStarredItem?: (item: StarredItem) => void | Promise<void>;
	/**
	 * Maps a render-context navKey to its index in navSessions. Prefer omitting
	 * for production (sidebarNavStore).
	 */
	navIndexMap?: Map<string, number>;
	/**
	 * Multi-window: optional window-ownership predicate. When provided, cycling
	 * includes only agent rows THIS window owns, so `Cmd+[` / `Cmd+]` never jumps
	 * to an agent surfaced by another window. Group chats are not window-owned
	 * agents (every renderer holds all of them), so they always stay in the cycle.
	 * Null-safe: omitted outside a `WindowProvider` (single-window app / web /
	 * isolation tests), where every agent is included and behaviour is unchanged.
	 * Reuses {@link WindowContextValue.ownsSession} - the single ownership
	 * authority that task 1's IPC gate and task 3's thinking pill also use - rather
	 * than re-deriving ownership.
	 */
	ownsSession?: (sessionId: string) => boolean;
}

export interface UseCycleSessionReturn {
	/** Cycle to next or previous session/group chat in visual order */
	cycleSession: (dir: 'next' | 'prev') => void;
}

type VisualOrderItem =
	| { type: 'session'; id: string; name: string; navKey: string }
	| { type: 'groupChat'; id: string; name: string }
	| { type: 'starred'; id: string; name: string; starredKey: string };

// ============================================================================
// Event-time implementation (no React)
// ============================================================================

/**
 * Cycle to the next or previous agent / group chat / starred row in visual
 * Left Bar order. Reads all store state at call time.
 */
export function cycleSession(dir: 'next' | 'prev', deps: CycleSessionDeps): void {
	const nav = useSidebarNavStore.getState();
	const sortedSessions = deps.sortedSessions ?? nav.sortedSessions;
	const starredItems = deps.starredItems ?? nav.starredItems;
	const activateStarredItem = deps.activateStarredItem ?? nav.activateStarredItem;
	const navIndexMap = deps.navIndexMap ?? nav.navIndexMap;
	const { handleOpenGroupChat, ownsSession } = deps;

	const {
		sessions,
		groups,
		activeSessionId,
		cyclePosition,
		setActiveSessionIdInternal,
		setCyclePosition,
	} = useSessionStore.getState();
	const { groupChats, activeGroupChatId, setActiveGroupChatId } = useGroupChatStore.getState();
	const {
		leftSidebarOpen,
		bookmarksCollapsed,
		showUnreadAgentsOnly,
		sidebarExtraSelection,
		setSidebarExtraSelection,
		setSelectedSidebarIndex,
	} = useUIStore.getState();
	const { ungroupedCollapsed, groupChatsExpanded, starredSessionsCollapsed } =
		useSettingsStore.getState();

	// Build the visual order of items as they appear in the sidebar.
	// This matches the actual rendering order in SessionList.tsx:
	// 1. Starred Sessions section (if shown + expanded) - sorted by display name
	// 2. Bookmarks section (if open) - sorted alphabetically
	// 3. Groups (sorted alphabetically) - each with sessions sorted alphabetically
	// 4. Ungrouped sessions - sorted alphabetically
	// 5. Group Chats section (if expanded) - sorted alphabetically
	//
	// A bookmarked session visually appears in BOTH the bookmarks section AND its
	// regular location (group or ungrouped). The same session can appear twice in
	// the visual order. We track the current position with cyclePosition to
	// allow cycling through duplicate occurrences correctly.
	//
	// Starred rows are similar: a starred row's `id` is its parent agent's session
	// id, so the same agent can appear in the starred section AND its regular
	// location. cyclePosition keeps the two occurrences distinct.

	const visualOrder: VisualOrderItem[] = [];

	// Helper to get worktree children for a session.
	// Sort by `name` to match the agent name shown in the Left Bar (SessionItem
	// renders `session.name` as the primary label; `worktreeBranch` is only a subtitle).
	// Sorting by branch name would make Cmd+Shift+[/] cycling bounce around relative
	// to the visible alphabetical order.
	const getWorktreeChildren = (parentId: string) =>
		sessions
			.filter((s) => s.parentSessionId === parentId)
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));

	// Helper to add session with its worktree children to visual order.
	// keyPrefix selects the navIndexMap namespace for this occurrence
	// ('bookmark' | `group:${groupId}` | 'ungrouped'), matching the keys built
	// in useSortedSessions.
	const addSessionWithWorktrees = (session: Session, keyPrefix: string) => {
		// Skip worktree children - they're added with their parent
		if (session.parentSessionId) return;

		visualOrder.push({
			type: 'session' as const,
			id: session.id,
			name: session.name,
			navKey: `${keyPrefix}:${session.id}`,
		});

		// Add worktree children if expanded
		if (session.worktreesExpanded !== false) {
			const children = getWorktreeChildren(session.id);
			visualOrder.push(
				...children.map((s) => ({
					type: 'session' as const,
					id: s.id,
					name: s.name,
					navKey: `${keyPrefix}:wt:${s.id}`,
				}))
			);
		}
	};

	if (leftSidebarOpen) {
		// Starred Sessions section (if shown, expanded, and non-empty). Hidden
		// while the unread-agents filter is active, mirroring SessionList which
		// drops the section under that filter. starredItems is already sorted by
		// display name to match the rendered order.
		if (!starredSessionsCollapsed && !showUnreadAgentsOnly && starredItems.length > 0) {
			visualOrder.push(
				...starredItems.map((item) => ({
					type: 'starred' as const,
					id: item.parentSessionId,
					name: item.displayName,
					starredKey: item.key,
				}))
			);
		}

		// Bookmarks section (if expanded and has bookmarked sessions)
		if (!bookmarksCollapsed) {
			const bookmarkedSessions = sessions
				.filter((s) => s.bookmarked && !s.parentSessionId)
				.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
			bookmarkedSessions.forEach((s) => addSessionWithWorktrees(s, 'bookmark'));
		}

		// Groups (sorted alphabetically), with each group's sessions
		const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
		for (const group of sortedGroups) {
			if (!group.collapsed) {
				const groupSessions = sessions
					.filter((s) => s.groupId === group.id && !s.parentSessionId)
					.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
				groupSessions.forEach((s) => addSessionWithWorktrees(s, `group:${group.id}`));
			}
		}

		// Ungrouped sessions (sorted alphabetically) - only if not collapsed
		if (!ungroupedCollapsed) {
			const ungroupedSessions = sessions
				.filter((s) => !s.groupId && !s.parentSessionId)
				.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
			ungroupedSessions.forEach((s) => addSessionWithWorktrees(s, 'ungrouped'));
		}

		// Group Chats section (if expanded and has non-archived group chats)
		const activeGroupChats = groupChats.filter((gc) => !gc.archived);
		if (groupChatsExpanded && activeGroupChats.length > 0) {
			const sortedGroupChats = [...activeGroupChats].sort((a, b) =>
				compareNamesIgnoringEmojis(a.name, b.name)
			);
			visualOrder.push(
				...sortedGroupChats.map((gc) => ({
					type: 'groupChat' as const,
					id: gc.id,
					name: gc.name,
				}))
			);
		}
	} else {
		// Sidebar collapsed: cycle through all sessions in their sorted order.
		// No expanded list is rendered, so the navKey is unused here (left empty
		// - it won't resolve in navIndexMap and activation skips the highlight set).
		visualOrder.push(
			...sortedSessions.map((s) => ({
				type: 'session' as const,
				id: s.id,
				name: s.name,
				navKey: '',
			}))
		);
	}

	// When unread filter is active, restrict cycling to unread/busy agents only
	// (plus the currently active agent so you don't get lost)
	if (showUnreadAgentsOnly) {
		const currentActiveId = activeGroupChatId || activeSessionId;
		const filteredOrder = visualOrder.filter((item) => {
			// Always keep the currently active item
			if (item.id === currentActiveId) return true;
			// Group chats pass through (they have their own unread badges)
			if (item.type === 'groupChat') return true;
			// Check if session is unread, busy, or in an error state (all "needs attention")
			const session = sessions.find((s) => s.id === item.id);
			if (!session) return false;
			if (session.aiTabs?.some((tab) => tab.hasUnread)) return true;
			if (session.state === 'busy' || session.state === 'error') return true;
			// Check worktree children for unread/busy/error
			const children = sessions.filter((s) => s.parentSessionId === session.id);
			if (
				children.some(
					(child) =>
						child.aiTabs?.some((tab) => tab.hasUnread) ||
						child.state === 'busy' ||
						child.state === 'error'
				)
			)
				return true;
			return false;
		});
		visualOrder.length = 0;
		visualOrder.push(...filteredOrder);
	}

	// Multi-window: drop agent rows this window does not own so Cmd+[/] cycles
	// only within the window's own tab strip, never jumping to an agent another
	// window surfaces. Group chats are not window-owned agents (each renderer
	// holds all of them), so they stay in the cycle. Null-safe: outside a
	// WindowProvider `ownsSession` is undefined and every row is kept, preserving
	// single-window/web/test behaviour. Pure synchronous array work composed with
	// the unread filter above - cycling stays deterministic (keyboard reliability).
	if (ownsSession) {
		const scopedOrder = visualOrder.filter(
			(item) => item.type === 'groupChat' || ownsSession(item.id)
		);
		visualOrder.length = 0;
		visualOrder.push(...scopedOrder);
	}

	if (visualOrder.length === 0) return;

	// Determine what is currently active (session or group chat)
	const currentActiveId = activeGroupChatId || activeSessionId;
	const currentIsGroupChat = activeGroupChatId !== null;

	// Determine current position in visual order.
	// A starred row's parent agent == its id, so activating one sets that
	// agent active (and clobbers cyclePosition via the public setActiveSessionId).
	// When the cursor is parked on a starred row we therefore track position via
	// sidebarExtraSelection rather than cyclePosition/findIndex - otherwise a
	// session occurrence of the same agent would be matched and cycling would get
	// stuck bouncing onto the same starred row.
	let currentIndex: number;
	if (sidebarExtraSelection?.kind === 'starred') {
		currentIndex = visualOrder.findIndex(
			(item) => item.type === 'starred' && item.starredKey === sidebarExtraSelection.key
		);
	} else {
		// If cyclePosition is valid and points to our current item, use it.
		// Otherwise, find the first occurrence of our current item.
		currentIndex = cyclePosition;
		if (
			currentIndex < 0 ||
			currentIndex >= visualOrder.length ||
			visualOrder[currentIndex].id !== currentActiveId ||
			visualOrder[currentIndex].type === 'starred'
		) {
			currentIndex = visualOrder.findIndex(
				(item) =>
					item.id === currentActiveId &&
					(currentIsGroupChat ? item.type === 'groupChat' : item.type === 'session')
			);
		}
	}

	// Dispatch activation for a slot in the visual order. A session sets the
	// active session directly; a group chat loads its messages; a starred row
	// focuses its tab or resumes its closed session (activateStarredItem sets
	// the active session itself).
	const activateVisualItem = (item: VisualOrderItem) => {
		if (item.type === 'session') {
			setActiveGroupChatId(null);
			// Landing on a plain agent clears the non-agent cursor so the agent's
			// own active highlight is the sole indicator.
			setSidebarExtraSelection(null);
			// Highlight + auto-scroll the EXACT occurrence we landed on (e.g. a
			// bookmarked agent's group row), not the first navSessions occurrence
			// the sync effect would otherwise pick (its bookmark row up top).
			const navIdx = navIndexMap.get(item.navKey);
			if (navIdx !== undefined) setSelectedSidebarIndex(navIdx);
			setActiveSessionIdInternal(item.id);
		} else if (item.type === 'starred') {
			const starred = starredItems.find((s) => s.key === item.starredKey);
			if (starred) {
				setActiveGroupChatId(null);
				// activateStarredItem sets the PARENT agent active (and resets
				// cyclePosition via the public setter); set the starred cursor AFTER
				// so it survives and visibly marks the row regardless of focus.
				void activateStarredItem(starred);
				setSidebarExtraSelection({ kind: 'starred', key: item.starredKey });
			}
		} else {
			// Group chats have their own active highlight (activeGroupChatId), so the
			// non-agent cursor is cleared when one is opened.
			setSidebarExtraSelection(null);
			handleOpenGroupChat(item.id);
		}
	};

	if (currentIndex === -1) {
		// Current item not visible, select first visible item
		setCyclePosition(0);
		activateVisualItem(visualOrder[0]);
		return;
	}

	// Move to next/prev in visual order
	let nextIndex;
	if (dir === 'next') {
		nextIndex = currentIndex === visualOrder.length - 1 ? 0 : currentIndex + 1;
	} else {
		nextIndex = currentIndex === 0 ? visualOrder.length - 1 : currentIndex - 1;
	}

	setCyclePosition(nextIndex);
	activateVisualItem(visualOrder[nextIndex]);
}

// ============================================================================
// Thin React adapter (stable callback, no store subscriptions)
// ============================================================================

/**
 * Stable `cycleSession` for keyboard handlers. Does not subscribe to stores;
 * deps are read from a ref so the callback identity stays fixed across renders.
 */
export function useCycleSession(deps: CycleSessionDeps): UseCycleSessionReturn {
	const depsRef = useRef(deps);
	depsRef.current = deps;

	const cycle = useCallback((dir: 'next' | 'prev') => {
		cycleSession(dir, depsRef.current);
	}, []);

	return { cycleSession: cycle };
}
