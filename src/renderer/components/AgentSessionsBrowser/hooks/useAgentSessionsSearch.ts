import { useState, useEffect, useRef } from 'react';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import type { SearchMode, SearchResult } from '../types';

interface UseAgentSessionsSearchArgs {
	search: string;
	searchMode: SearchMode;
	projectPathForSessions: string | undefined;
	agentId: string;
	sshRemoteId: string | undefined;
}

export function useAgentSessionsSearch({
	search,
	searchMode,
	projectPathForSessions,
	agentId,
	sshRemoteId,
}: UseAgentSessionsSearchArgs): {
	searchResults: SearchResult[];
	isSearching: boolean;
} {
	const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (searchTimeoutRef.current) {
			clearTimeout(searchTimeoutRef.current);
		}

		// Title search filters in-memory - no IPC needed
		if (searchMode === 'title' || !search.trim()) {
			setSearchResults([]);
			setIsSearching(false);
			return;
		}

		setIsSearching(true);
		searchTimeoutRef.current = setTimeout(async () => {
			if (cancelled) return;
			if (!projectPathForSessions || !search.trim()) {
				setSearchResults([]);
				setIsSearching(false);
				return;
			}

			try {
				const results = await window.maestro.agentSessions.search(
					agentId,
					projectPathForSessions,
					search,
					searchMode,
					sshRemoteId
				);
				if (!cancelled) {
					setSearchResults(results);
				}
			} catch (error) {
				if (cancelled) return;
				logger.error('Search failed:', undefined, error);
				captureException(error, {
					extra: { fn: 'useAgentSessionsSearch', agentId, projectPathForSessions },
				});
				setSearchResults([]);
			} finally {
				if (!cancelled) {
					setIsSearching(false);
				}
			}
		}, 300);

		return () => {
			cancelled = true;
			if (searchTimeoutRef.current) {
				clearTimeout(searchTimeoutRef.current);
			}
		};
	}, [search, searchMode, projectPathForSessions, agentId, sshRemoteId]);

	return { searchResults, isSearching };
}
