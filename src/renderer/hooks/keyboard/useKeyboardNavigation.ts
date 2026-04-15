import { useCallback, useEffect, useRef } from 'react';
import type { Session, Group, FocusArea } from '../../types';

/**
 * Dependencies for useKeyboardNavigation hook
 *
 * Note: editingSessionId/editingGroupId are checked in useMainKeyboardHandler.ts
 * before any navigation handlers are called, so they are not needed here.
 */
export interface UseKeyboardNavigationDeps {
	/** All sessions sorted in visual display order */
	sortedSessions: Session[];
	/** Sessions in visual navigation order (bookmarks first, then groups, then ungrouped) */
	navSessions: Session[];
	/** Number of items in the bookmarks section of navSessions */
	bookmarkNavSize: number;
	/** Current selected sidebar index */
	selectedSidebarIndex: number;
	/** Setter for selected sidebar index */
	setSelectedSidebarIndex: React.Dispatch<React.SetStateAction<number>>;
	/** Active session ID */
	activeSessionId: string | null;
	/** Setter for active session ID */
	setActiveSessionId: (id: string) => void;
	/** Current focus area */
	activeFocus: FocusArea;
	/** Setter for focus area */
	setActiveFocus: React.Dispatch<React.SetStateAction<FocusArea>>;
	/** Session groups */
	groups: Group[];
	/** Setter for groups (for collapse/expand) */
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	/** Whether bookmarks section is collapsed */
	bookmarksCollapsed: boolean;
	/** Setter for bookmarks collapsed state */
	setBookmarksCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
	/** Input ref for focus management */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Terminal output ref for escape handling */
	terminalOutputRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Return type for useKeyboardNavigation hook
 */
export interface UseKeyboardNavigationReturn {
	/** Handle sidebar navigation keyboard events. Returns true if event was handled. */
	handleSidebarNavigation: (e: KeyboardEvent) => boolean;
	/** Handle Tab navigation between panels. Returns true if event was handled. */
	handleTabNavigation: (e: KeyboardEvent) => boolean;
	/** Handle Enter to activate selected session. Returns true if event was handled. */
	handleEnterToActivate: (e: KeyboardEvent) => boolean;
	/** Handle Escape in main area. Returns true if event was handled. */
	handleEscapeInMain: (e: KeyboardEvent) => boolean;
}

/**
 * Keyboard navigation utilities for sidebar and panel focus management.
 *
 * Provides handlers for:
 * - Arrow key navigation through sessions (with group collapse/expand)
 * - Tab navigation between panels (sidebar, main, right)
 * - Enter to activate selected session
 * - Escape to blur input and focus terminal output
 *
 * @param deps - Hook dependencies containing state and setters
 * @returns Navigation handlers for the main keyboard event handler
 */
export function useKeyboardNavigation(
	deps: UseKeyboardNavigationDeps
): UseKeyboardNavigationReturn {
	const {
		sortedSessions,
		navSessions,
		bookmarkNavSize,
		selectedSidebarIndex,
		setSelectedSidebarIndex,
		activeSessionId,
		setActiveSessionId,
		activeFocus,
		setActiveFocus,
		groups,
		setGroups,
		bookmarksCollapsed,
		setBookmarksCollapsed,
		inputRef,
		terminalOutputRef,
	} = deps;

	// Use refs for values that change frequently to avoid stale closures
	const sortedSessionsRef = useRef(sortedSessions);
	sortedSessionsRef.current = sortedSessions;

	const navSessionsRef = useRef(navSessions);
	navSessionsRef.current = navSessions;

	const bookmarkNavSizeRef = useRef(bookmarkNavSize);
	bookmarkNavSizeRef.current = bookmarkNavSize;

	const selectedSidebarIndexRef = useRef(selectedSidebarIndex);
	selectedSidebarIndexRef.current = selectedSidebarIndex;

	const groupsRef = useRef(groups);
	groupsRef.current = groups;

	const bookmarksCollapsedRef = useRef(bookmarksCollapsed);
	bookmarksCollapsedRef.current = bookmarksCollapsed;

	const activeFocusRef = useRef(activeFocus);
	activeFocusRef.current = activeFocus;

	/**
	 * Handle sidebar navigation with arrow keys.
	 * Supports collapse/expand of groups and bookmarks sections.
	 * Returns true if the event was handled.
	 */
	const handleSidebarNavigation = useCallback(
		(e: KeyboardEvent): boolean => {
			// Use navSessions for navigation — matches visual order (bookmarks first, then groups, then ungrouped)
			const sessions = navSessionsRef.current;
			const currentGroups = groupsRef.current;
			const currentIndex = selectedSidebarIndexRef.current;
			const isBookmarksCollapsed = bookmarksCollapsedRef.current;
			const bmNavSize = bookmarkNavSizeRef.current;
			const focus = activeFocusRef.current;

			// Only handle when sidebar has focus
			if (focus !== 'sidebar') return false;

			// Skip if event originated from an input element (text areas, inputs)
			const target = e.target as HTMLElement | null;
			if (
				target?.tagName === 'INPUT' ||
				target?.tagName === 'TEXTAREA' ||
				target?.isContentEditable
			) {
				return false;
			}

			// Skip if Cmd/Ctrl+Arrow is pressed (with or without Alt) — could be a user-configured
			// tab navigation shortcut (e.g. Cmd+Left/Right) or layout toggle (Alt+Cmd+Arrow).
			// Plain ArrowLeft/Right (no modifiers) is reserved for group collapse/expand.
			const isModifiedArrow =
				(e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
			if (isModifiedArrow) return false;

			// Only handle arrow keys and space
			if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
				return false;
			}

			e.preventDefault();
			if (sessions.length === 0) return true;

			const currentSession = sessions[currentIndex];
			// Whether current position is in the bookmarks section of navSessions
			const inBookmarksSection = currentIndex < bmNavSize;

			// ArrowLeft: Collapse the current group or bookmarks section
			if (e.key === 'ArrowLeft' && currentSession) {
				// Only collapse bookmarks if we're actually in the bookmarks section
				if (inBookmarksSection && currentSession.bookmarked && !isBookmarksCollapsed) {
					setBookmarksCollapsed(true);
					return true;
				}

				// Check if session is in a group (only when in group section, not bookmarks)
				if (!inBookmarksSection && currentSession.groupId) {
					const currentGroup = currentGroups.find((g) => g.id === currentSession.groupId);
					if (currentGroup && !currentGroup.collapsed) {
						setGroups((prev) =>
							prev.map((g) => (g.id === currentGroup.id ? { ...g, collapsed: true } : g))
						);
						return true;
					}
				}
				return true;
			}

			// ArrowRight: Expand the current group or bookmarks section (if collapsed)
			if (e.key === 'ArrowRight' && currentSession) {
				// Only expand bookmarks if we're in the bookmarks section
				if (inBookmarksSection && currentSession.bookmarked && isBookmarksCollapsed) {
					setBookmarksCollapsed(false);
					return true;
				}

				// Check if session is in a collapsed group (only when in group section)
				if (!inBookmarksSection && currentSession.groupId) {
					const currentGroup = currentGroups.find((g) => g.id === currentSession.groupId);
					if (currentGroup && currentGroup.collapsed) {
						setGroups((prev) =>
							prev.map((g) => (g.id === currentGroup.id ? { ...g, collapsed: false } : g))
						);
						return true;
					}
				}
				return true;
			}

			// Space: Close the current group and jump to nearest visible session
			// Only applies when in the group section (not bookmarks)
			if (e.key === ' ' && !inBookmarksSection && currentSession?.groupId) {
				const currentGroup = currentGroups.find((g) => g.id === currentSession.groupId);
				if (currentGroup && !currentGroup.collapsed) {
					// Collapse the group
					setGroups((prev) =>
						prev.map((g) => (g.id === currentGroup.id ? { ...g, collapsed: true } : g))
					);

					// Helper to check if a session will be visible after collapse
					const willBeVisible = (idx: number, s: Session) => {
						// Items in bookmarks section: visible if bookmarks expanded
						if (idx < bmNavSize) return !isBookmarksCollapsed;
						if (s.groupId === currentGroup.id) return false; // In the group being collapsed
						if (!s.groupId) return true; // Ungrouped sessions are always visible
						const g = currentGroups.find((grp) => grp.id === s.groupId);
						return g && !g.collapsed; // In an expanded group
					};

					// First, look BELOW (after) the current position
					let nextVisible: { session: Session; index: number } | undefined;
					for (let i = currentIndex + 1; i < sessions.length; i++) {
						if (willBeVisible(i, sessions[i])) {
							nextVisible = { session: sessions[i], index: i };
							break;
						}
					}

					// If nothing below, look ABOVE (before) the current position
					if (!nextVisible) {
						for (let i = currentIndex - 1; i >= 0; i--) {
							if (willBeVisible(i, sessions[i])) {
								nextVisible = { session: sessions[i], index: i };
								break;
							}
						}
					}

					if (nextVisible) {
						setSelectedSidebarIndex(nextVisible.index);
						setActiveSessionId(nextVisible.session.id);
					}
					return true;
				}
			}

			// ArrowUp/ArrowDown: Navigate through sessions, expanding collapsed groups as needed
			if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				const totalSessions = sessions.length;

				// Helper to get all sessions in a group (within navSessions, after bookmarks section)
				const getGroupSessions = (groupId: string) => {
					return sessions
						.map((s, i) => ({ session: s, index: i }))
						.filter((item) => item.index >= bmNavSize && item.session.groupId === groupId);
				};

				// Find the next session, skipping collapsed sections
				let nextIndex = currentIndex;
				let foundCollapsedGroup: string | null = null;
				let foundCollapsedBookmarks = false;

				if (e.key === 'ArrowDown') {
					for (let i = 1; i <= totalSessions; i++) {
						const candidateIndex = (currentIndex + i) % totalSessions;
						const candidate = sessions[candidateIndex];

						// Check if candidate is in bookmarks section
						if (candidateIndex < bmNavSize) {
							if (!isBookmarksCollapsed) {
								// Bookmarks expanded — can navigate to it
								nextIndex = candidateIndex;
								break;
							}
							// Bookmarks collapsed — auto-expand if coming from outside bookmarks
							if (currentIndex >= bmNavSize) {
								foundCollapsedBookmarks = true;
								nextIndex = candidateIndex;
								break;
							}
							// Inside collapsed bookmarks — skip
							continue;
						}

						if (!candidate.groupId) {
							nextIndex = candidateIndex;
							break;
						}

						const candidateGroup = currentGroups.find((g) => g.id === candidate.groupId);
						if (!candidateGroup?.collapsed) {
							nextIndex = candidateIndex;
							break;
						}

						// Session is in a collapsed group — different group than current?
						if (candidate.groupId !== currentSession?.groupId || inBookmarksSection) {
							foundCollapsedGroup = candidate.groupId;
							const groupSessions = getGroupSessions(candidate.groupId);
							if (groupSessions.length > 0) {
								nextIndex = groupSessions[0].index;
							}
							break;
						}
						// Same collapsed group, keep looking
					}
				} else {
					// Moving up
					for (let i = 1; i <= totalSessions; i++) {
						const candidateIndex = (currentIndex - i + totalSessions) % totalSessions;
						const candidate = sessions[candidateIndex];

						// Check if candidate is in bookmarks section
						if (candidateIndex < bmNavSize) {
							if (!isBookmarksCollapsed) {
								nextIndex = candidateIndex;
								break;
							}
							if (currentIndex >= bmNavSize) {
								foundCollapsedBookmarks = true;
								// Go to last bookmark when moving up
								nextIndex = bmNavSize - 1;
								break;
							}
							continue;
						}

						if (!candidate.groupId) {
							nextIndex = candidateIndex;
							break;
						}

						const candidateGroup = currentGroups.find((g) => g.id === candidate.groupId);
						if (!candidateGroup?.collapsed) {
							nextIndex = candidateIndex;
							break;
						}

						if (candidate.groupId !== currentSession?.groupId || inBookmarksSection) {
							foundCollapsedGroup = candidate.groupId;
							const groupSessions = getGroupSessions(candidate.groupId);
							if (groupSessions.length > 0) {
								nextIndex = groupSessions[groupSessions.length - 1].index;
							}
							break;
						}
						// Same collapsed group, keep looking
					}
				}

				// Expand collapsed sections we navigated into
				if (foundCollapsedBookmarks) {
					setBookmarksCollapsed(false);
				}
				if (foundCollapsedGroup) {
					setGroups((prev) =>
						prev.map((g) => (g.id === foundCollapsedGroup ? { ...g, collapsed: false } : g))
					);
				}

				setSelectedSidebarIndex(nextIndex);
				return true;
			}

			return false;
		},
		[setSelectedSidebarIndex, setActiveSessionId, setGroups, setBookmarksCollapsed]
	);

	/**
	 * Handle Tab navigation between panels.
	 * Returns true if the event was handled.
	 */
	const handleTabNavigation = useCallback(
		(e: KeyboardEvent): boolean => {
			if (e.key !== 'Tab') return false;

			// Skip global Tab handling when input is focused - let input handler handle it
			if (document.activeElement === inputRef.current) {
				return false;
			}

			e.preventDefault();
			const focus = activeFocusRef.current;

			if (focus === 'sidebar' && !e.shiftKey) {
				// Tab from sidebar goes to main input
				setActiveFocus('main');
				setTimeout(() => inputRef.current?.focus(), 0);
				return true;
			}

			const order: FocusArea[] = ['sidebar', 'main', 'right'];
			const currentIdx = order.indexOf(focus);
			if (e.shiftKey) {
				const next = currentIdx === 0 ? order.length - 1 : currentIdx - 1;
				setActiveFocus(order[next]);
			} else {
				const next = currentIdx === order.length - 1 ? 0 : currentIdx + 1;
				setActiveFocus(order[next]);
			}
			return true;
		},
		[setActiveFocus, inputRef]
	);

	/**
	 * Handle Enter to load selected session from sidebar.
	 * Returns true if the event was handled.
	 * Only triggers on plain Enter (no modifiers) to avoid interfering with Cmd+Enter.
	 */
	const handleEnterToActivate = useCallback(
		(e: KeyboardEvent): boolean => {
			const focus = activeFocusRef.current;
			// Only handle plain Enter, not Cmd+Enter or other modifier combinations
			if (focus !== 'sidebar' || e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey)
				return false;

			// Skip if event originated from an input element (text areas, inputs)
			const target = e.target as HTMLElement | null;
			if (
				target?.tagName === 'INPUT' ||
				target?.tagName === 'TEXTAREA' ||
				target?.isContentEditable
			) {
				return false;
			}

			e.preventDefault();
			const sessions = navSessionsRef.current;
			const currentIndex = selectedSidebarIndexRef.current;

			if (sessions[currentIndex]) {
				setActiveSessionId(sessions[currentIndex].id);
			}
			return true;
		},
		[setActiveSessionId]
	);

	/**
	 * Handle Escape in main area to blur input and focus terminal.
	 * Returns true if the event was handled.
	 */
	const handleEscapeInMain = useCallback(
		(e: KeyboardEvent): boolean => {
			const focus = activeFocusRef.current;
			if (focus !== 'main' || e.key !== 'Escape') return false;
			if (document.activeElement !== inputRef.current) return false;

			e.preventDefault();
			inputRef.current?.blur();
			terminalOutputRef.current?.focus();
			return true;
		},
		[inputRef, terminalOutputRef]
	);

	// Sync selectedSidebarIndex with activeSessionId
	// IMPORTANT: Only sync when activeSessionId changes, NOT when navSessions changes
	// This allows keyboard navigation to move the selector independently of the active session
	// The sync happens when user clicks a session or presses Enter to activate
	// Uses navSessions so the index matches the visual navigation order (bookmarks first)
	useEffect(() => {
		const currentIndex = navSessions.findIndex((s) => s.id === activeSessionId);
		if (currentIndex !== -1) {
			setSelectedSidebarIndex(currentIndex);
		}
	}, [activeSessionId]); // Intentionally excluding navSessions - see comment above

	return {
		handleSidebarNavigation,
		handleTabNavigation,
		handleEnterToActivate,
		handleEscapeInMain,
	};
}
