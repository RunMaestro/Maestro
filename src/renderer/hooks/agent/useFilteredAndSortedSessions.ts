import { useMemo, useCallback } from 'react';
import type { ClaudeSession } from './useSessionViewer';

/**
 * Search result with match information.
 */
export interface SearchResult {
	sessionId: string;
	matchType: 'title' | 'user' | 'assistant';
	matchPreview: string;
	matchCount: number;
}

/**
 * Search mode for filtering sessions.
 */
export type SearchMode = 'title' | 'user' | 'assistant' | 'all';

/**
 * Dependencies for the useFilteredAndSortedSessions hook.
 */
export interface UseFilteredAndSortedSessionsDeps {
	/** All loaded sessions */
	sessions: ClaudeSession[];
	/** Current search query */
	search: string;
	/** Current search mode */
	searchMode: SearchMode;
	/** Backend search results for content searches */
	searchResults: SearchResult[];
	/** Whether search is in progress */
	isSearching: boolean;
	/** Set of starred session IDs */
	starredSessions: Set<string>;
	/** Whether to show all sessions (including agent- prefix) */
	showAllSessions: boolean;
	/** Whether to only show named sessions */
	namedOnly: boolean;
}

/**
 * Return type for the useFilteredAndSortedSessions hook.
 */
export interface UseFilteredAndSortedSessionsReturn {
	/** Filtered and sorted sessions list */
	filteredSessions: ClaudeSession[];
	/** Helper to check if a session should be visible based on filters */
	isSessionVisible: (session: ClaudeSession) => boolean;
	/** Get search result info for a session (for display purposes) */
	getSearchResultInfo: (sessionId: string) => SearchResult | undefined;
}

/**
 * Hook for filtering and sorting Claude sessions.
 *
 * Features:
 * - Filters sessions by visibility (showAllSessions, namedOnly)
 * - Filters by search query (title, sessionId, first octet, sessionName)
 * - Supports backend content search results for user/assistant/all modes
 * - Sorts starred sessions to the top, then by modified date
 *
 * @param deps - Dependencies including sessions, search state, and filter options
 * @returns Filtered and sorted sessions with helper functions
 */
export function useFilteredAndSortedSessions(
	deps: UseFilteredAndSortedSessionsDeps
): UseFilteredAndSortedSessionsReturn {
	const {
		sessions,
		search,
		searchMode,
		searchResults,
		isSearching,
		starredSessions,
		showAllSessions,
		namedOnly,
	} = deps;

	// Helper to check if a session should be visible based on filters
	const isSessionVisible = useCallback(
		(session: ClaudeSession) => {
			// Named only filter - if enabled, only show sessions with a custom name
			if (namedOnly && !session.sessionName) {
				return false;
			}
			if (showAllSessions) return true;
			// Hide sessions that start with "agent-" (only show UUID-style sessions by default)
			return !session.sessionId.startsWith('agent-');
		},
		[showAllSessions, namedOnly]
	);

	// Get search result info for a session (for display purposes)
	const getSearchResultInfo = useCallback(
		(sessionId: string): SearchResult | undefined => {
			return searchResults.find((r) => r.sessionId === sessionId);
		},
		[searchResults]
	);

	// Filter sessions by search - use different strategies based on search mode
	const filteredSessions = useMemo(() => {
		// First filter by showAllSessions
		const visibleSessions = sessions.filter(isSessionVisible);

		// Sort starred sessions to the top, then by modified date
		const sortWithStarred = (sessionList: ClaudeSession[]) => {
			return [...sessionList].sort((a, b) => {
				const aStarred = starredSessions.has(a.sessionId);
				const bStarred = starredSessions.has(b.sessionId);
				if (aStarred && !bStarred) return -1;
				if (!aStarred && bStarred) return 1;
				// Within same starred status, sort by most recent
				return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
			});
		};

		if (!search.trim()) {
			return sortWithStarred(visibleSessions);
		}

		// For title search, filter locally (fast) - include sessionName, sessionId (UUID), and first octet
		if (searchMode === 'title') {
			const searchLower = search.toLowerCase();
			const searchUpper = search.toUpperCase();
			const filtered = visibleSessions.filter((s) => {
				// Check firstMessage
				if (s.firstMessage.toLowerCase().includes(searchLower)) return true;
				// Check full sessionId (UUID)
				if (s.sessionId.toLowerCase().includes(searchLower)) return true;
				// Check first octet (displayed format) - e.g., "D02D0BD6"
				const firstOctet = s.sessionId.split('-')[0].toUpperCase();
				if (firstOctet.includes(searchUpper)) return true;
				// Check sessionName
				if (s.sessionName && s.sessionName.toLowerCase().includes(searchLower)) return true;
				return false;
			});
			return sortWithStarred(filtered);
		}

		// For content searches, use backend results to filter sessions
		// Also include sessions that match by sessionName, sessionId (UUID), or first octet
		const searchLower = search.toLowerCase();
		const searchUpper = search.toUpperCase();
		const matchingIds = new Set(searchResults.map((r) => r.sessionId));

		// Add sessions that match by sessionName, sessionId (UUID), or first octet to the results
		const filtered = visibleSessions.filter((s) => {
			// Check if matched by backend content search
			if (matchingIds.has(s.sessionId)) return true;
			// Check sessionName match
			if (s.sessionName && s.sessionName.toLowerCase().includes(searchLower)) return true;
			// Check full sessionId (UUID) match
			if (s.sessionId.toLowerCase().includes(searchLower)) return true;
			// Check first octet (displayed format) match - e.g., "D02D0BD6"
			const firstOctet = s.sessionId.split('-')[0].toUpperCase();
			if (firstOctet.includes(searchUpper)) return true;
			return false;
		});

		if (filtered.length > 0) {
			return sortWithStarred(filtered);
		}

		// If searching but no results yet, return empty (or all if still loading)
		return isSearching ? sortWithStarred(visibleSessions) : [];
	}, [sessions, search, searchMode, searchResults, isSearching, isSessionVisible, starredSessions]);

	return {
		filteredSessions,
		isSessionVisible,
		getSearchResultInfo,
	};
}
