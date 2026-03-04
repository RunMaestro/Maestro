import { useState, useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useSessionStore } from '../../stores/sessionStore';

export interface SessionFilterModeState {
	sessionFilter: string;
	setSessionFilter: (value: string) => void;
}

/**
 * Manages the filter mode state machine for the session list sidebar.
 *
 * When the filter opens:
 *   - Saves current group collapse states and bookmarks collapsed state
 *   - Applies filter-mode preferences (or defaults on first open: collapse all, expand bookmarks)
 *
 * When the filter closes:
 *   - Saves current states as filter-mode preferences (for next open)
 *   - Restores original (pre-filter) states
 *
 * While filtering:
 *   - Temporarily expands groups containing matching sessions
 *   - Expands bookmarks if any bookmarked sessions match
 *   - Collapses groups when filter text is cleared (but filter input still open)
 */
export function useSessionFilterMode(): SessionFilterModeState {
	const sessionFilterOpen = useUIStore((s) => s.sessionFilterOpen);
	const bookmarksCollapsed = useUIStore((s) => s.bookmarksCollapsed);
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);

	const [sessionFilter, setSessionFilter] = useState('');

	// Pre-filter state (saved on open, restored on close)
	const [preFilterGroupStates, setPreFilterGroupStates] = useState<Map<string, boolean>>(new Map());
	const [preFilterBookmarksCollapsed, setPreFilterBookmarksCollapsed] = useState<boolean | null>(
		null
	);

	// Filter mode preferences (persists across open/close within session)
	const [filterModeGroupStates, setFilterModeGroupStates] = useState<Map<string, boolean> | null>(
		null
	);
	const [filterModeBookmarksCollapsed, setFilterModeBookmarksCollapsed] = useState<boolean | null>(
		null
	);
	const [filterModeInitialized, setFilterModeInitialized] = useState(false);

	// Stable store actions
	const setGroups = useSessionStore.getState().setGroups;
	const setBookmarksCollapsed = useUIStore.getState().setBookmarksCollapsed;

	// When filter opens, apply filter mode preferences (or defaults on first open)
	// When filter closes, save current states as filter mode preferences and restore original states
	useEffect(() => {
		if (sessionFilterOpen) {
			// Save current (non-filter) states when filter opens
			if (preFilterGroupStates.size === 0) {
				const currentStates = new Map<string, boolean>();
				groups.forEach((g) => {
					currentStates.set(g.id, g.collapsed);
				});
				setPreFilterGroupStates(currentStates);
			}
			if (preFilterBookmarksCollapsed === null) {
				setPreFilterBookmarksCollapsed(bookmarksCollapsed);
			}

			// Apply filter mode preferences if we have them, otherwise use defaults
			if (filterModeInitialized && filterModeGroupStates) {
				// Restore user's preferred filter mode states
				setGroups((prev) =>
					prev.map((g) => ({
						...g,
						collapsed: filterModeGroupStates.get(g.id) ?? true,
					}))
				);
				setBookmarksCollapsed(filterModeBookmarksCollapsed ?? false);
			} else {
				// First time opening filter - use defaults: collapse all groups, expand bookmarks
				setGroups((prev) => prev.map((g) => ({ ...g, collapsed: true })));
				setBookmarksCollapsed(false);
				setFilterModeInitialized(true);
			}
		} else {
			// Filter closing - save current states as filter mode preferences
			const currentFilterStates = new Map<string, boolean>();
			groups.forEach((g) => {
				currentFilterStates.set(g.id, g.collapsed);
			});
			setFilterModeGroupStates(currentFilterStates);
			setFilterModeBookmarksCollapsed(bookmarksCollapsed);

			if (preFilterGroupStates.size > 0) {
				// Restore original (non-filter) states
				setGroups((prev) =>
					prev.map((g) => ({
						...g,
						collapsed: preFilterGroupStates.get(g.id) ?? g.collapsed,
					}))
				);
				setPreFilterGroupStates(new Map());
			}
			if (preFilterBookmarksCollapsed !== null) {
				setBookmarksCollapsed(preFilterBookmarksCollapsed);
				setPreFilterBookmarksCollapsed(null);
			}
		}
	}, [sessionFilterOpen]);

	// Temporarily expand groups when filtering to show matching sessions
	useEffect(() => {
		if (sessionFilter) {
			// Find groups that contain matching sessions (search session name AND AI tab names)
			const groupsWithMatches = new Set<string>();
			const query = sessionFilter.toLowerCase();
			const matchingSessions = sessions.filter((s) => {
				if (s.name.toLowerCase().includes(query)) return true;
				if (s.aiTabs?.some((tab) => tab.name?.toLowerCase().includes(query))) return true;
				return false;
			});

			matchingSessions.forEach((session) => {
				if (session.groupId) {
					groupsWithMatches.add(session.groupId);
				}
			});

			// Check if any matching sessions are bookmarked
			const hasMatchingBookmarks = matchingSessions.some((s) => s.bookmarked);

			// Temporarily expand groups with matches
			setGroups((prev) =>
				prev.map((g) => ({
					...g,
					collapsed: groupsWithMatches.has(g.id) ? false : g.collapsed,
				}))
			);

			// Temporarily expand bookmarks if there are matching bookmarked sessions
			if (hasMatchingBookmarks) {
				setBookmarksCollapsed(false);
			}
		} else if (sessionFilterOpen) {
			// Filter cleared but filter input still open - collapse groups again, keep bookmarks expanded
			setGroups((prev) => prev.map((g) => ({ ...g, collapsed: true })));
			setBookmarksCollapsed(false);
		}
	}, [sessionFilter]);

	return {
		sessionFilter,
		setSessionFilter,
	};
}
