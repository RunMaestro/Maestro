/**
 * useCycleSession - extracted from App.tsx
 *
 * Provides session cycling functionality (Cmd+Shift+[/]):
 *   - Cycles through sessions and group chats in visual sidebar order
 *   - Handles bookmarks (sessions appearing in both locations)
 *   - Handles worktree children, collapsed groups, collapsed sidebar
 *   - Handles group chat cycling
 *
 * Reads from: sessionStore, groupChatStore, uiStore, settingsStore
 */

import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { compareNamesIgnoringEmojis } from '../session/useSortedSessions';
import { orderGroupChatsForDisplay } from '../../utils/groupChatOrdering';
import { requestSidebarReveal } from '../../utils/sidebarReveal';
import { passesUnreadFilter, sessionMatchesFilter } from '../../utils/sidebarMembership';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { useBatchStore, selectActiveBatchSessionIds } from '../../stores/batchStore';
import { useActiveOutageSessionSignature } from '../../stores/retryStore';
import { outageIdsFromSignature } from '../../utils/sessionAttention';
import type { StarredItem } from './useStarredItems';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseCycleSessionDeps {
	/** Sorted sessions array (used when sidebar is collapsed) */
	sortedSessions: Session[];
	/** Open a group chat (loads messages etc.) */
	handleOpenGroupChat: (groupChatId: string) => void;
	/**
	 * Starred Sessions rows (open starred tabs + closed starred sessions), in the
	 * same display order as the Left Bar's "Starred Sessions" section. Cycling
	 * traverses these at the top of the visual order when the section is shown.
	 */
	starredItems: StarredItem[];
	/** Activate a starred row (focus its tab, or resume a closed session). */
	activateStarredItem: (item: StarredItem) => void | Promise<void>;
	/**
	 * Maps a render-context navKey (`bookmark:{id}`, `group:{gid}:{id}`,
	 * `ungrouped:{id}`, plus `:wt:` child variants) to its index in navSessions.
	 * Lets cycling highlight the EXACT occurrence it landed on (e.g. a bookmarked
	 * agent's group row) instead of the first navSessions occurrence.
	 */
	navIndexMap: Map<string, number>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseCycleSessionReturn {
	/** Cycle to next or previous session/group chat in visual order */
	cycleSession: (dir: 'next' | 'prev') => void;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useCycleSession(deps: UseCycleSessionDeps): UseCycleSessionReturn {
	const { sortedSessions, handleOpenGroupChat, starredItems, activateStarredItem, navIndexMap } =
		deps;

	// --- Reactive subscriptions ---
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	// cyclePosition tracks where we are in the visual order for cycling
	const groupChats = useGroupChatStore((s) => s.groupChats);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
	const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen);
	const bookmarksCollapsed = useUIStore((s) => s.bookmarksCollapsed);
	const showUnreadAgentsOnly = useUIStore((s) => s.showUnreadAgentsOnly);
	// The sidebar's own membership inputs. The cycle must walk exactly the rows
	// the sidebar draws, and both of these change which rows those are.
	const sessionFilter = useUIStore((s) => s.sessionFilter);
	const showArchivedGroupChats = useUIStore((s) => s.showArchivedGroupChats);
	// `useShallow` is mandatory, not a nicety: the selector builds a fresh array
	// on every call, so a bare subscription never settles on a stable snapshot
	// and React re-renders until it throws "Maximum update depth exceeded".
	// Every other caller of this selector wraps it the same way.
	const activeBatchSessionIds = useBatchStore(useShallow(selectActiveBatchSessionIds));
	// Stuck (outage) agents stay in the Left Bar under the unread filter, so the
	// cycle has to see them too or Cmd+[ / Cmd+] skips a row that is on screen.
	const stuckOutageSignature = useActiveOutageSessionSignature();

	// --- Store actions (stable via getState) ---
	const { setActiveSessionIdInternal, setCyclePosition } = useSessionStore.getState();
	const { setActiveGroupChatId } = useGroupChatStore.getState();
	const { setSidebarExtraSelection, setSelectedSidebarIndex } = useUIStore.getState();

	// --- Settings ---
	const ungroupedCollapsed = useSettingsStore((s) => s.ungroupedCollapsed);
	const groupChatsExpanded = useSettingsStore((s) => s.groupChatsExpanded);
	const starredSectionCollapsed = useSettingsStore((s) => s.starredSessionsCollapsed);
	// Read from settings rather than assumed: the sidebar and the arrow keys both
	// honor this toggle, so the cycle must too or the three disagree.
	const groupChatSortAlphabetical = useSettingsStore((s) => s.groupChatSortAlphabetical);

	const cycleSession = useCallback(
		(dir: 'next' | 'prev') => {
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

			// Visual order item can be a session, a group chat, or a starred row.
			// `navKey` on session entries maps the entry to its exact row in
			// navSessions (via navIndexMap), so activating it can highlight/scroll the
			// SAME occurrence the cycle landed on. Without it the render falls back to
			// navSessions.findIndex (first occurrence), which for a bookmarked agent is
			// its bookmark row at the top - making the panel jump up when you cycle onto
			// the agent's group/ungrouped occurrence below.
			type VisualOrderItem =
				| { type: 'session'; id: string; name: string; navKey: string }
				| { type: 'groupChat'; id: string; name: string }
				| { type: 'starred'; id: string; name: string; starredKey: string };

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
			const batchIds = new Set(activeBatchSessionIds);
			const stuckIds = outageIdsFromSignature(stuckOutageSignature);
			/**
			 * Is this agent drawn in the Left Bar right now? Same predicates the
			 * render path uses, so the two cannot disagree about membership.
			 */
			const isDrawn = (session: Session): boolean => {
				const children = getWorktreeChildren(session.id);
				if (
					!passesUnreadFilter(session, {
						showUnreadAgentsOnly,
						activeSessionId,
						worktreeChildren: children,
						batchSessionIds: batchIds,
						stuckOutageIds: stuckIds,
					})
				) {
					return false;
				}
				return sessionMatchesFilter(session, sessionFilter, children);
			};

			const addSessionWithWorktrees = (session: Session, keyPrefix: string) => {
				// Skip worktree children - they're added with their parent
				if (session.parentSessionId) return;
				// A filtered-out agent is not on screen, so the cursor must not land
				// on it. Cmd+[ / Cmd+] had no view of the filter at all until the text
				// was lifted into uiStore.
				if (!isDrawn(session)) return;

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
				if (!starredSectionCollapsed && !showUnreadAgentsOnly && starredItems.length > 0) {
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

				// Ungrouped sessions (sorted alphabetically).
				//
				// An agent whose groupId points at a group that no longer exists is
				// drawn HERE by the sidebar (`useSessionCategories`: grouped requires
				// `groupIds.has(s.groupId)`, everything else falls through to
				// ungrouped). This used to filter on `!s.groupId`, so such an agent was
				// in no section at all and Cmd+[ / Cmd+] could never reach it - it was
				// on screen and unreachable.
				const groupIds = new Set(groups.map((g) => g.id));
				const isUngrouped = (s: Session) => !s.groupId || !groupIds.has(s.groupId);
				const ungroupedSessions = sessions
					.filter((s) => isUngrouped(s) && !s.parentSessionId)
					.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
				// The collapse flag only counts when the sidebar actually offers the
				// control. It draws the collapsible Ungrouped folder only when groups
				// exist AND there are ungrouped agents (SessionList: `groups.length > 0
				// && ungroupedSessions.length > 0`); otherwise the agents render with no
				// header to collapse. A flag left true from before the last group was
				// deleted would then hide every agent from the cycle while all of them
				// are on screen, making Cmd+] a silent no-op.
				const ungroupedIsCollapsible = groups.length > 0 && ungroupedSessions.length > 0;
				if (!ungroupedCollapsed || !ungroupedIsCollapsible) {
					ungroupedSessions.forEach((s) => addSessionWithWorktrees(s, 'ungrouped'));
				}

				// Group Chats section (if expanded and has non-archived group chats)
				// The SAME ordering the sidebar draws and the arrow keys walk. This used
				// to hardcode alphabetical while the list renders by recency, and
				// recency is the DEFAULT (`groupChatSortAlphabetical: false`), so out of
				// the box Cmd+[ / Cmd+] walked group chats in an order nothing on screen
				// matched. That is the jumping.
				// `showArchivedGroupChats` is the list's own toggle: with it on the
				// sidebar draws archived chats too, so the cycle has to walk them.
				// Passed INTO the ordering helper rather than pre-filtered here -
				// the helper drops archived chats itself, so a caller that filtered
				// first had them removed again on the way through.
				const activeGroupChats = groupChats.filter((gc) => showArchivedGroupChats || !gc.archived);
				if (groupChatsExpanded && activeGroupChats.length > 0) {
					const sortedGroupChats = orderGroupChatsForDisplay(
						activeGroupChats,
						groupChatSortAlphabetical,
						{ includeArchived: showArchivedGroupChats }
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
					// Check if session is unread or busy
					const session = sessions.find((s) => s.id === item.id);
					if (!session) return false;
					if (session.aiTabs?.some((tab) => tab.hasUnread)) return true;
					if (session.state === 'busy') return true;
					// Check worktree children for unread/busy
					const children = sessions.filter((s) => s.parentSessionId === session.id);
					if (
						children.some(
							(child) => child.aiTabs?.some((tab) => tab.hasUnread) || child.state === 'busy'
						)
					)
						return true;
					return false;
				});
				visualOrder.length = 0;
				visualOrder.push(...filteredOrder);
			}

			if (visualOrder.length === 0) {
				// A shortcut that does nothing and explains nothing is indistinguishable
				// from a broken one. When the list is empty BECAUSE OF A FILTER the user
				// can clear, say so; the center flash is the existing affordance for a
				// momentary answer to a keypress, so nothing new is invented here.
				//
				// Stay silent when there is simply nothing to cycle (no agents at all,
				// sidebar closed) - there is no misunderstanding to correct, and a flash
				// on every stray Cmd+] in an empty workspace is noise.
				const query = sessionFilter.trim();
				if (query) {
					notifyCenterFlash({
						message: 'No agents match the filter',
						detail: query,
						color: 'yellow',
					});
				} else if (showUnreadAgentsOnly) {
					notifyCenterFlash({ message: 'No unread agents', color: 'yellow' });
				}
				return;
			}

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
			const extraSelection = useUIStore.getState().sidebarExtraSelection;
			let currentIndex: number;
			if (extraSelection?.kind === 'starred') {
				currentIndex = visualOrder.findIndex(
					(item) => item.type === 'starred' && item.starredKey === extraSelection.key
				);
			} else {
				// If cyclePosition is valid and points to our current item, use it.
				// Otherwise, find the first occurrence of our current item.
				currentIndex = useSessionStore.getState().cyclePosition;
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
				// Cmd+[ / Cmd+] moves the cursor without the user touching the list, so
				// the destination has to be brought into view. Requested before the
				// cursor is set: the consumer defers a frame and re-reads it.
				requestSidebarReveal();
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
		},
		[
			sessions,
			groups,
			activeSessionId,
			activeGroupChatId,
			leftSidebarOpen,
			bookmarksCollapsed,
			groupChatsExpanded,
			groupChatSortAlphabetical,
			ungroupedCollapsed,
			showUnreadAgentsOnly,
			sessionFilter,
			showArchivedGroupChats,
			activeBatchSessionIds,
			stuckOutageSignature,
			groupChats,
			sortedSessions,
			handleOpenGroupChat,
			starredSectionCollapsed,
			starredItems,
			activateStarredItem,
			navIndexMap,
		]
	);

	return { cycleSession };
}
