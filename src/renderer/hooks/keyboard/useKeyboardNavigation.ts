import { useCallback, useEffect, useRef } from 'react';
import type { Session, Group, FocusArea } from '../../types';
import type { SidebarExtraSelection } from '../../stores/uiStore';
import type { StarredItem } from '../session/useStarredItems';
import { orderGroupChatsForDisplay } from '../../utils/groupChatOrdering';
import { useSidebarNavStore } from '../../stores/sidebarNavStore';

/**
 * Minimal group-chat shape the sidebar navigation needs. Mirrors the fields
 * GroupChatList sorts/filters on so arrow-key order matches the rendered order.
 */
export interface NavGroupChat {
	id: string;
	name: string;
	archived?: boolean;
	updatedAt?: number;
	createdAt?: number;
}

/**
 * Dependencies for useKeyboardNavigation hook
 *
 * Note: editingSessionId/editingGroupId are checked in useMainKeyboardHandler.ts
 * before any navigation handlers are called, so they are not needed here.
 *
 * Left Bar sort/nav/starred fields are optional: when omitted, handlers read
 * {@link useSidebarNavStore} via refs (no App subscription to those slices).
 */
export interface UseKeyboardNavigationDeps {
	/** @deprecated Prefer sidebarNavStore; optional for App. */
	sortedSessions?: Session[];
	/** @deprecated Prefer sidebarNavStore; optional for App. */
	navSessions?: Session[];
	/** @deprecated Prefer sidebarNavStore; optional for App. */
	bookmarkNavSize?: number;
	selectedSidebarIndex: number;
	setSelectedSidebarIndex: React.Dispatch<React.SetStateAction<number>>;
	sidebarExtraSelection: SidebarExtraSelection | null;
	setSidebarExtraSelection: (selection: SidebarExtraSelection | null) => void;
	activeSessionId: string | null;
	setActiveSessionId: (id: string) => void;
	activeFocus: FocusArea;
	setActiveFocus: React.Dispatch<React.SetStateAction<FocusArea>>;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	bookmarksCollapsed: boolean;
	setBookmarksCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	terminalOutputRef: React.RefObject<HTMLDivElement | null>;
	/** @deprecated Prefer sidebarNavStore; optional for App. */
	starredItems?: StarredItem[];
	/** @deprecated Prefer sidebarNavStore; optional for App. */
	activateStarredItem?: (item: StarredItem) => void | Promise<void>;
	starredSectionCollapsed: boolean;
	setStarredSectionCollapsed: (collapsed: boolean) => void;
	groupChats: NavGroupChat[];
	handleOpenGroupChat: (id: string) => void;
	groupChatsExpanded: boolean;
	setGroupChatsExpanded: (expanded: boolean) => void;
	groupChatSortAlphabetical: boolean;
	showUnreadAgentsOnly: boolean;
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

// ============================================================================
// Virtual sidebar order
// ============================================================================

/**
 * One entry in the full top-to-bottom Left Bar order that arrow navigation
 * walks. Starred rows sit above the agent list, group chats below it. Agent
 * entries carry their navSessions index so the existing selectedSidebarIndex /
 * navIndexMap render highlight keeps working unchanged.
 */
type VirtualEntry =
	| { type: 'starred'; section: string; item: StarredItem }
	| { type: 'session'; section: string; navIndex: number; session: Session }
	| { type: 'groupChat'; section: string; id: string };

/**
 * Sort group chats the same way GroupChatList renders them so the keyboard
 * cursor lines up with the visible rows: archived dropped, then alphabetical or
 * most-recent per the toggle.
 */
function sortNavGroupChats(groupChats: NavGroupChat[], alphabetical: boolean): NavGroupChat[] {
	return orderGroupChatsForDisplay(groupChats, alphabetical);
}

/**
 * Keyboard navigation utilities for sidebar and panel focus management.
 *
 * Provides handlers for:
 * - Arrow key navigation through starred rows, agents (with group
 *   collapse/expand), and group chats
 * - Tab navigation between panels (sidebar, main, right)
 * - Enter to activate selected session
 * - Escape to blur input and focus terminal output
 *
 * Arrow Up/Down expand the next collapsed section as they cross into it (so the
 * cursor never gets stuck above a collapsed group). Arrow Left/Right
 * collapse/expand the current section.
 *
 * @param deps - Hook dependencies containing state and setters
 * @returns Navigation handlers for the main keyboard event handler
 */
export function useKeyboardNavigation(
	deps: UseKeyboardNavigationDeps
): UseKeyboardNavigationReturn {
	const {
		sortedSessions: sortedSessionsProp,
		navSessions: navSessionsProp,
		bookmarkNavSize: bookmarkNavSizeProp,
		selectedSidebarIndex,
		setSelectedSidebarIndex,
		sidebarExtraSelection,
		setSidebarExtraSelection,
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
		starredItems: starredItemsProp,
		activateStarredItem: activateStarredItemProp,
		starredSectionCollapsed,
		setStarredSectionCollapsed,
		groupChats,
		handleOpenGroupChat,
		groupChatsExpanded,
		setGroupChatsExpanded,
		groupChatSortAlphabetical,
		showUnreadAgentsOnly,
	} = deps;

	const navSnap = useSidebarNavStore.getState();
	const sortedSessions = sortedSessionsProp ?? navSnap.sortedSessions;
	const navSessions = navSessionsProp ?? navSnap.navSessions;
	const bookmarkNavSize = bookmarkNavSizeProp ?? navSnap.bookmarkNavSize;
	const starredItems = starredItemsProp ?? navSnap.starredItems;
	const activateStarredItem = activateStarredItemProp ?? navSnap.activateStarredItem;

	// Use refs for values that change frequently to avoid stale closures
	const sortedSessionsRef = useRef(sortedSessions);
	sortedSessionsRef.current = sortedSessions;

	const navSessionsRef = useRef(navSessions);
	navSessionsRef.current = navSessions;

	const bookmarkNavSizeRef = useRef(bookmarkNavSize);
	bookmarkNavSizeRef.current = bookmarkNavSize;

	const selectedSidebarIndexRef = useRef(selectedSidebarIndex);
	selectedSidebarIndexRef.current = selectedSidebarIndex;

	const sidebarExtraSelectionRef = useRef(sidebarExtraSelection);
	sidebarExtraSelectionRef.current = sidebarExtraSelection;

	const groupsRef = useRef(groups);
	groupsRef.current = groups;

	const bookmarksCollapsedRef = useRef(bookmarksCollapsed);
	bookmarksCollapsedRef.current = bookmarksCollapsed;

	const activeFocusRef = useRef(activeFocus);
	activeFocusRef.current = activeFocus;

	const starredItemsRef = useRef(starredItems);
	starredItemsRef.current = starredItems;

	const activateStarredItemRef = useRef(activateStarredItem);
	activateStarredItemRef.current = activateStarredItem;

	const starredSectionCollapsedRef = useRef(starredSectionCollapsed);
	starredSectionCollapsedRef.current = starredSectionCollapsed;

	const groupChatsRef = useRef(groupChats);
	groupChatsRef.current = groupChats;

	const groupChatsExpandedRef = useRef(groupChatsExpanded);
	groupChatsExpandedRef.current = groupChatsExpanded;

	const groupChatSortAlphabeticalRef = useRef(groupChatSortAlphabetical);
	groupChatSortAlphabeticalRef.current = groupChatSortAlphabetical;

	const showUnreadAgentsOnlyRef = useRef(showUnreadAgentsOnly);
	showUnreadAgentsOnlyRef.current = showUnreadAgentsOnly;

	// When App omits nav/starred props, keep refs fresh without re-rendering App.
	useEffect(() => {
		if (
			sortedSessionsProp !== undefined &&
			navSessionsProp !== undefined &&
			bookmarkNavSizeProp !== undefined &&
			starredItemsProp !== undefined &&
			activateStarredItemProp !== undefined
		) {
			return;
		}
		return useSidebarNavStore.subscribe((state) => {
			if (sortedSessionsProp === undefined) {
				sortedSessionsRef.current = state.sortedSessions;
			}
			if (navSessionsProp === undefined) {
				navSessionsRef.current = state.navSessions;
			}
			if (bookmarkNavSizeProp === undefined) {
				bookmarkNavSizeRef.current = state.bookmarkNavSize;
			}
			if (starredItemsProp === undefined) {
				starredItemsRef.current = state.starredItems;
			}
			if (activateStarredItemProp === undefined) {
				activateStarredItemRef.current = state.activateStarredItem;
			}
		});
	}, [
		sortedSessionsProp,
		navSessionsProp,
		bookmarkNavSizeProp,
		starredItemsProp,
		activateStarredItemProp,
	]);

	/**
	 * Build the full top-to-bottom Left Bar order. Starred rows and group chats
	 * are included only when the unread-agents filter is off (it hides both
	 * sections in the render, so arrow nav must skip them to stay aligned). All
	 * agents are always included regardless of collapse state - the navigation
	 * loop decides visibility and auto-expands sections as it crosses into them.
	 */
	const buildVirtualOrder = useCallback((): VirtualEntry[] => {
		const order: VirtualEntry[] = [];
		const sessions = navSessionsRef.current;
		const bmNavSize = bookmarkNavSizeRef.current;
		const includeExtras = !showUnreadAgentsOnlyRef.current;

		if (includeExtras) {
			for (const item of starredItemsRef.current) {
				order.push({ type: 'starred', section: 'starred', item });
			}
		}

		sessions.forEach((session, navIndex) => {
			let section: string;
			if (navIndex < bmNavSize) section = 'bookmarks';
			else if (session.groupId) section = `group:${session.groupId}`;
			else section = 'ungrouped';
			order.push({ type: 'session', section, navIndex, session });
		});

		if (includeExtras) {
			const sortedChats = sortNavGroupChats(
				groupChatsRef.current,
				groupChatSortAlphabeticalRef.current
			);
			for (const chat of sortedChats) {
				order.push({ type: 'groupChat', section: 'groupChats', id: chat.id });
			}
		}

		return order;
	}, []);

	/** Is this entry currently visible (its section expanded)? */
	const isEntryVisible = useCallback((entry: VirtualEntry): boolean => {
		switch (entry.type) {
			case 'starred':
				return !starredSectionCollapsedRef.current;
			case 'groupChat':
				return groupChatsExpandedRef.current;
			case 'session': {
				if (entry.section === 'bookmarks') return !bookmarksCollapsedRef.current;
				if (entry.section.startsWith('group:')) {
					const group = groupsRef.current.find((g) => g.id === entry.session.groupId);
					return !group?.collapsed;
				}
				return true; // ungrouped agents are always visible
			}
		}
	}, []);

	/** Expand the (collapsed) section an entry belongs to, so the cursor can land on it. */
	const expandSectionFor = useCallback(
		(entry: VirtualEntry): void => {
			switch (entry.type) {
				case 'starred':
					if (starredSectionCollapsedRef.current) setStarredSectionCollapsed(false);
					break;
				case 'groupChat':
					if (!groupChatsExpandedRef.current) setGroupChatsExpanded(true);
					break;
				case 'session': {
					if (entry.section === 'bookmarks') {
						if (bookmarksCollapsedRef.current) setBookmarksCollapsed(false);
					} else if (entry.section.startsWith('group:')) {
						const groupId = entry.session.groupId;
						setGroups((prev) =>
							prev.map((g) => (g.id === groupId ? { ...g, collapsed: false } : g))
						);
					}
					break;
				}
			}
		},
		[setStarredSectionCollapsed, setGroupChatsExpanded, setBookmarksCollapsed, setGroups]
	);

	/** Move the keyboard cursor onto a virtual entry (highlight only - no activation). */
	const selectEntry = useCallback(
		(entry: VirtualEntry): void => {
			if (entry.type === 'session') {
				setSidebarExtraSelection(null);
				setSelectedSidebarIndex(entry.navIndex);
			} else if (entry.type === 'starred') {
				setSelectedSidebarIndex(-1);
				setSidebarExtraSelection({ kind: 'starred', key: entry.item.key });
			} else {
				setSelectedSidebarIndex(-1);
				setSidebarExtraSelection({ kind: 'groupChat', id: entry.id });
			}
		},
		[setSelectedSidebarIndex, setSidebarExtraSelection]
	);

	/** Locate the cursor's current position in the virtual order. */
	const findCurrentPos = useCallback((order: VirtualEntry[]): number => {
		const extra = sidebarExtraSelectionRef.current;
		if (extra) {
			return order.findIndex((e) =>
				extra.kind === 'starred'
					? e.type === 'starred' && e.item.key === extra.key
					: e.type === 'groupChat' && e.id === extra.id
			);
		}
		const idx = selectedSidebarIndexRef.current;
		return order.findIndex((e) => e.type === 'session' && e.navIndex === idx);
	}, []);

	/**
	 * Handle sidebar navigation with arrow keys.
	 * Supports collapse/expand of groups, bookmarks, starred, and group-chat sections.
	 * Returns true if the event was handled.
	 */
	const handleSidebarNavigation = useCallback(
		(e: KeyboardEvent): boolean => {
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

			// Skip if Cmd/Ctrl+Arrow is pressed (with or without Alt) - could be a user-configured
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

			const order = buildVirtualOrder();
			if (order.length === 0) return true;

			let currentPos = findCurrentPos(order);
			// Cursor not found (e.g. just focused the sidebar) - seed it on the first
			// visible entry so the first keypress has a defined starting point.
			if (currentPos === -1) {
				const firstVisible = order.findIndex(isEntryVisible);
				currentPos = firstVisible === -1 ? 0 : firstVisible;
			}
			const currentEntry = order[currentPos];

			// ArrowLeft: collapse the current entry's section.
			if (e.key === 'ArrowLeft') {
				if (currentEntry.type === 'starred') {
					if (!starredSectionCollapsedRef.current) setStarredSectionCollapsed(true);
				} else if (currentEntry.type === 'groupChat') {
					if (groupChatsExpandedRef.current) setGroupChatsExpanded(false);
				} else if (currentEntry.section === 'bookmarks') {
					if (!bookmarksCollapsedRef.current) setBookmarksCollapsed(true);
				} else if (currentEntry.section.startsWith('group:')) {
					const groupId = currentEntry.session.groupId;
					const group = groupsRef.current.find((g) => g.id === groupId);
					if (group && !group.collapsed) {
						setGroups((prev) =>
							prev.map((g) => (g.id === groupId ? { ...g, collapsed: true } : g))
						);
					}
				}
				return true;
			}

			// ArrowRight: expand the current entry's section if collapsed.
			if (e.key === 'ArrowRight') {
				if (currentEntry.type === 'starred') {
					if (starredSectionCollapsedRef.current) setStarredSectionCollapsed(false);
				} else if (currentEntry.type === 'groupChat') {
					if (!groupChatsExpandedRef.current) setGroupChatsExpanded(true);
				} else if (currentEntry.section === 'bookmarks') {
					if (bookmarksCollapsedRef.current) setBookmarksCollapsed(false);
				} else if (currentEntry.section.startsWith('group:')) {
					const groupId = currentEntry.session.groupId;
					const group = groupsRef.current.find((g) => g.id === groupId);
					if (group && group.collapsed) {
						setGroups((prev) =>
							prev.map((g) => (g.id === groupId ? { ...g, collapsed: false } : g))
						);
					}
				}
				return true;
			}

			// Space: collapse the current group and jump to the nearest visible entry.
			// Only applies inside an (expanded) group, matching the prior behavior.
			if (e.key === ' ') {
				if (currentEntry.type !== 'session' || !currentEntry.section.startsWith('group:')) {
					return true;
				}
				const groupId = currentEntry.session.groupId;
				const group = groupsRef.current.find((g) => g.id === groupId);
				if (!group || group.collapsed) return true;

				setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, collapsed: true } : g)));

				// Treat every entry in the group being collapsed as hidden, then find the
				// nearest still-visible entry below, else above.
				const willBeVisible = (entry: VirtualEntry) =>
					entry.section === currentEntry.section ? false : isEntryVisible(entry);

				let target: number | undefined;
				for (let i = currentPos + 1; i < order.length; i++) {
					if (willBeVisible(order[i])) {
						target = i;
						break;
					}
				}
				if (target === undefined) {
					for (let i = currentPos - 1; i >= 0; i--) {
						if (willBeVisible(order[i])) {
							target = i;
							break;
						}
					}
				}
				if (target !== undefined) {
					const entry = order[target];
					selectEntry(entry);
					if (entry.type === 'session') setActiveSessionId(entry.session.id);
				}
				return true;
			}

			// ArrowUp / ArrowDown: walk to the next entry, expanding collapsed
			// sections as the cursor crosses into them.
			const total = order.length;
			const step = e.key === 'ArrowDown' ? 1 : -1;
			const currentSection = currentEntry.section;

			for (let i = 1; i <= total; i++) {
				const candIdx = (currentPos + step * i + total * i) % total;
				const cand = order[candIdx];

				if (isEntryVisible(cand)) {
					selectEntry(cand);
					return true;
				}

				// Hidden because its section is collapsed. If it's the SAME collapsed
				// section the cursor already sits in, keep scanning past it. Otherwise
				// we're crossing into a new collapsed section: expand it and land on its
				// edge entry (first when going down, last when going up).
				if (cand.section === currentSection) continue;

				expandSectionFor(cand);
				const sectionIndices: number[] = [];
				for (let j = 0; j < total; j++) {
					if (order[j].section === cand.section) sectionIndices.push(j);
				}
				const edge = step === 1 ? sectionIndices[0] : sectionIndices[sectionIndices.length - 1];
				selectEntry(order[edge]);
				return true;
			}

			return true;
		},
		[
			buildVirtualOrder,
			findCurrentPos,
			isEntryVisible,
			expandSectionFor,
			selectEntry,
			setStarredSectionCollapsed,
			setGroupChatsExpanded,
			setBookmarksCollapsed,
			setGroups,
			setActiveSessionId,
		]
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
	 * Handle Enter to load the selected sidebar entry.
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

			// Extra-section cursor: activate the starred row or group chat directly.
			const extra = sidebarExtraSelectionRef.current;
			if (extra) {
				if (extra.kind === 'starred') {
					const item = starredItemsRef.current.find((s) => s.key === extra.key);
					if (item) void activateStarredItemRef.current(item);
				} else {
					handleOpenGroupChat(extra.id);
				}
				return true;
			}

			const sessions = navSessionsRef.current;
			const currentIndex = selectedSidebarIndexRef.current;
			if (sessions[currentIndex]) {
				setActiveSessionId(sessions[currentIndex].id);
			}
			return true;
		},
		[setActiveSessionId, handleOpenGroupChat]
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
	// Uses navSessions so the index matches the visual navigation order (bookmarks first).
	//
	// Bail when the Starred/Group-Chat cursor is live: activating a starred row sets
	// its PARENT agent active, which would otherwise drag the agent cursor onto the
	// parent and clear the starred highlight the cycle just set. The public
	// setActiveSessionId (clicks/external jumps) clears the extra cursor itself, so
	// by the time this runs for a genuine agent activation it is already null.
	//
	// Sticky: if the current index already points to an occurrence of the active
	// session, keep it. A bookmarked agent appears twice in navSessions (bookmark
	// row + group/ungrouped row); the cycle/arrow nav may have intentionally landed
	// on the lower one. findIndex would always snap back to the first (bookmark)
	// occurrence, making the panel jump up - so only re-resolve when the current
	// index is stale.
	useEffect(() => {
		if (sidebarExtraSelectionRef.current) return;
		const cur = selectedSidebarIndexRef.current;
		if (cur >= 0 && navSessions[cur]?.id === activeSessionId) return;
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
