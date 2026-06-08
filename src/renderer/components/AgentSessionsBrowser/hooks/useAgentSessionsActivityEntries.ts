import { useState, useEffect, useRef } from 'react';
import type { ActivityEntry } from '../../SessionActivityGraph';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';

interface UseAgentSessionsActivityEntriesArgs {
	namedOnly: boolean;
	showAllSessions: boolean;
	showSearchPanel: boolean;
	filteredSessions: AgentSession[];
}

export function useAgentSessionsActivityEntries({
	namedOnly,
	showAllSessions,
	showSearchPanel,
	filteredSessions,
}: UseAgentSessionsActivityEntriesArgs): {
	activityEntries: ActivityEntry[];
} {
	const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);
	const prevFiltersRef = useRef({ namedOnly, showAllSessions, showSearchPanel });

	useEffect(() => {
		const filtersChanged =
			prevFiltersRef.current.namedOnly !== namedOnly ||
			prevFiltersRef.current.showAllSessions !== showAllSessions;
		const switchingToGraph = prevFiltersRef.current.showSearchPanel && !showSearchPanel;

		prevFiltersRef.current = { namedOnly, showAllSessions, showSearchPanel };

		// Update graph entries when:
		// 1. Switching TO graph view (from search panel)
		// 2. Filters change while graph is visible
		// 3. Initial load when graph is visible and we have data but entries are empty
		const shouldUpdate =
			(switchingToGraph && filteredSessions.length > 0) ||
			(filtersChanged && !showSearchPanel && filteredSessions.length > 0) ||
			(!showSearchPanel && activityEntries.length === 0 && filteredSessions.length > 0);

		if (shouldUpdate) {
			setActivityEntries(filteredSessions.map((s) => ({ timestamp: s.modifiedAt })));
		}
	}, [showSearchPanel, namedOnly, showAllSessions, filteredSessions, activityEntries.length]);

	return { activityEntries };
}
