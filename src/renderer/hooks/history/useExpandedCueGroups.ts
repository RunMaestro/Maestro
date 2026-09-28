/**
 * Expansion state for the History panel's collapsed Cue rows.
 *
 * A grouped row stands for hundreds of runs (1,382 for `Pedsidian-Command-Bus`
 * in one week on this machine). This hook is what keeps those runs REACHABLE:
 * it owns which rows are open and how to fetch the runs behind one.
 *
 * State lives here rather than inside `HistoryEntryItem` because the list is
 * virtualized - a row scrolled out of the overscan window unmounts, and a row
 * that forgot it was open every time the user looked away would be worse than
 * no expander at all. The `Set` + toggle shape is the same one
 * `CueModal/ActiveRunsList.tsx` uses for its live-logs panels.
 */

import { useCallback, useMemo, useState } from 'react';
import type { HistoryEntry } from '../../types';
import { logger } from '../../utils/logger';

/**
 * Runs fetched when a group is opened, newest first.
 *
 * A cap exists at all because a group can stand for thousands of runs and the
 * panel draws them inside one row. It is generous enough that scrolling the
 * expanded list is the normal way to reach an older run, and the detail modal
 * plus the ungrouped view (turn `groupCueEntries` off) remain the way to reach
 * everything.
 */
export const EXPANDED_CUE_GROUP_RUN_LIMIT = 200;

/** How a row asks for the runs behind it. Stable across renders. */
export interface CueGroupExpansionApi {
	/** Open or close the group on the row with this entry id. */
	toggle: (entryId: string) => void;
	/** The runs behind a collapsed row, newest first. */
	loadRuns: (entry: HistoryEntry) => Promise<HistoryEntry[]>;
}

export interface UseExpandedCueGroupsOptions {
	/**
	 * The panel's lookback, in hours (`null` = all time). Passed straight
	 * through to the query so the runs an expander shows are exactly the ones
	 * the row's count was computed over.
	 */
	lookbackHours?: number | null;
	/** The panel's project scope, for resolving the agent's directory. */
	projectPath?: string;
}

export interface UseExpandedCueGroupsResult {
	/** Entry ids whose group is currently open. */
	expandedIds: Set<string>;
	/** Passed to every row; identity is stable so memoized rows stay memoized. */
	expansion: CueGroupExpansionApi;
}

export function useExpandedCueGroups({
	lookbackHours,
	projectPath,
}: UseExpandedCueGroupsOptions = {}): UseExpandedCueGroupsResult {
	const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

	const toggle = useCallback((entryId: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(entryId)) next.delete(entryId);
			else next.add(entryId);
			return next;
		});
	}, []);

	const loadRuns = useCallback(
		async (entry: HistoryEntry): Promise<HistoryEntry[]> => {
			const groupKey = entry.cueGroup?.key;
			if (!groupKey || !entry.sessionId) return [];
			try {
				return await window.maestro.history.getCueGroupRuns({
					sessionId: entry.sessionId,
					groupKey,
					projectPath: entry.projectPath || projectPath,
					lookbackHours,
					limit: EXPANDED_CUE_GROUP_RUN_LIMIT,
				});
			} catch (error) {
				logger.error(`Failed to load runs for Cue group "${groupKey}": ${error}`, 'History');
				throw error;
			}
		},
		[lookbackHours, projectPath]
	);

	const expansion = useMemo<CueGroupExpansionApi>(() => ({ toggle, loadRuns }), [toggle, loadRuns]);

	return { expandedIds, expansion };
}
