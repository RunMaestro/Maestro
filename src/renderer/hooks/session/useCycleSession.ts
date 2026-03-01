/**
 * useCycleSession — extracted from App.tsx
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
import type { Session } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { compareNamesIgnoringEmojis } from '../session/useSortedSessions';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseCycleSessionDeps {
	/** Sorted sessions array (used when sidebar is collapsed) */
	sortedSessions: Session[];
	/** Open a group chat (loads messages etc.) */
	handleOpenGroupChat: (groupChatId: string) => void;
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
	const { sortedSessions, handleOpenGroupChat } = deps;

	// --- Reactive subscriptions ---
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	// cyclePosition tracks where we are in the visual order for cycling
	const groupChats = useGroupChatStore((s) => s.groupChats);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
	const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen);
	const bookmarksCollapsed = useUIStore((s) => s.bookmarksCollapsed);
	const groupChatsExpanded = useUIStore((s) => s.groupChatsExpanded);

	// --- Store actions (stable via getState) ---
	const { setActiveSessionIdInternal, setCyclePosition } = useSessionStore.getState();
	const { setActiveGroupChatId } = useGroupChatStore.getState();

	// --- Settings ---
	const ungroupedCollapsed = useSettingsStore((s) => s.ungroupedCollapsed);

	const cycleSession = useCallback(
		(dir: 'next' | 'prev') => {
			// Build the visual order of items as they appear in the sidebar.
			// This matches the actual rendering order in SessionList.tsx:
			// 1. Bookmarks section (if open) - sorted alphabetically
			// 2. Groups (sorted alphabetically) - each with sessions sorted alphabetically
			// 3. Ungrouped sessions - sorted alphabetically
			// 4. Group Chats section (if expanded) - sorted alphabetically
			//
			// A bookmarked session visually appears in BOTH the bookmarks section AND its
			// regular location (group or ungrouped). The same session can appear twice in
			// the visual order. We track the current position with cyclePosition to
			// allow cycling through duplicate occurrences correctly.

			// Visual order item can be either a session or a group chat
			type VisualOrderItem =
				| { type: 'session'; id: string; name: string }
				| { type: 'groupChat'; id: string; name: string };

			const visualOrder: VisualOrderItem[] = [];

			// Helper to get worktree children for a session
			const getWorktreeChildren = (parentId: string) =>
				sessions
					.filter((s) => s.parentSessionId === parentId)
					.sort((a, b) =>
						compareNamesIgnoringEmojis(a.worktreeBranch || a.name, b.worktreeBranch || b.name)
					);

			// Helper to add session with its worktree children to visual order
			const addSessionWithWorktrees = (session: Session) => {
				// Skip worktree children - they're added with their parent
				if (session.parentSessionId) return;

				visualOrder.push({
					type: 'session' as const,
					id: session.id,
					name: session.name,
				});

				// Add worktree children if expanded
				if (session.worktreesExpanded !== false) {
					const children = getWorktreeChildren(session.id);
					visualOrder.push(
						...children.map((s) => ({
							type: 'session' as const,
							id: s.id,
							name: s.worktreeBranch || s.name,
						}))
					);
				}
			};

			if (leftSidebarOpen) {
				// Bookmarks section (if expanded and has bookmarked sessions)
				if (!bookmarksCollapsed) {
					const bookmarkedSessions = sessions
						.filter((s) => s.bookmarked && !s.parentSessionId)
						.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
					bookmarkedSessions.forEach(addSessionWithWorktrees);
				}

				// Groups (sorted alphabetically), with each group's sessions
				const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
				for (const group of sortedGroups) {
					if (!group.collapsed) {
						const groupSessions = sessions
							.filter((s) => s.groupId === group.id && !s.parentSessionId)
							.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
						groupSessions.forEach(addSessionWithWorktrees);
					}
				}

				// Ungrouped sessions (sorted alphabetically) - only if not collapsed
				if (!ungroupedCollapsed) {
					const ungroupedSessions = sessions
						.filter((s) => !s.groupId && !s.parentSessionId)
						.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
					ungroupedSessions.forEach(addSessionWithWorktrees);
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
				// Sidebar collapsed: cycle through all sessions in their sorted order
				visualOrder.push(
					...sortedSessions.map((s) => ({
						type: 'session' as const,
						id: s.id,
						name: s.name,
					}))
				);
			}

			if (visualOrder.length === 0) return;

			// Determine what is currently active (session or group chat)
			const currentActiveId = activeGroupChatId || activeSessionId;
			const currentIsGroupChat = activeGroupChatId !== null;

			// Determine current position in visual order
			// If cyclePosition is valid and points to our current item, use it
			// Otherwise, find the first occurrence of our current item
			let currentIndex = useSessionStore.getState().cyclePosition;
			if (
				currentIndex < 0 ||
				currentIndex >= visualOrder.length ||
				visualOrder[currentIndex].id !== currentActiveId
			) {
				// Position is invalid or doesn't match current item - find first occurrence
				currentIndex = visualOrder.findIndex(
					(item) =>
						item.id === currentActiveId &&
						(currentIsGroupChat ? item.type === 'groupChat' : item.type === 'session')
				);
			}

			if (currentIndex === -1) {
				// Current item not visible, select first visible item
				setCyclePosition(0);
				const firstItem = visualOrder[0];
				if (firstItem.type === 'session') {
					setActiveGroupChatId(null);
					setActiveSessionIdInternal(firstItem.id);
				} else {
					// When switching to a group chat via cycling, use handleOpenGroupChat to load messages
					handleOpenGroupChat(firstItem.id);
				}
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
			const nextItem = visualOrder[nextIndex];
			if (nextItem.type === 'session') {
				setActiveGroupChatId(null);
				setActiveSessionIdInternal(nextItem.id);
			} else {
				// When switching to a group chat via cycling, use handleOpenGroupChat to load messages
				handleOpenGroupChat(nextItem.id);
			}
		},
		[
			sessions,
			groups,
			activeSessionId,
			activeGroupChatId,
			leftSidebarOpen,
			bookmarksCollapsed,
			groupChatsExpanded,
			ungroupedCollapsed,
			groupChats,
			sortedSessions,
			handleOpenGroupChat,
		]
	);

	return { cycleSession };
}
