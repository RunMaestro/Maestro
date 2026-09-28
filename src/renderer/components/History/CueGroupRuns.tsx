/**
 * The runs behind an expanded Cue group row.
 *
 * Collapsing a trigger to one line is only honest if the runs it stands for
 * stay reachable, and this is that escape hatch: one compact line per run,
 * each opening the same detail modal an ungrouped row would.
 *
 * Fetch-on-mount / drop-on-unmount is the same lifecycle `LiveOutputPanel` in
 * `CueModal/ActiveRunsList.tsx` uses. Expansion STATE outlives the unmount
 * (it lives in `useExpandedCueGroups`), so a row that scrolls out of the
 * virtualizer's window and back reopens on its own and refetches - a hundred
 * rows' worth of runs held in memory for a panel the user is not looking at
 * would be the worse trade.
 */

import { memo, useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { HistoryEntry, Theme } from '../../types';
import { formatTimestamp } from '../../../shared/formatters';
import { stripMarkdown } from '../../utils/textProcessing';
import type { CueGroupExpansionApi } from '../../hooks/history/useExpandedCueGroups';

/** Tallest the run list grows before it scrolls inside the row. */
const RUNS_MAX_HEIGHT = 240;

export interface CueGroupRunsProps {
	/** The collapsed row being expanded. Carries the group key and the agent. */
	entry: HistoryEntry;
	theme: Theme;
	/** Supplies the runs. From `useExpandedCueGroups`. */
	expansion: CueGroupExpansionApi;
	/** Opens one run in the detail modal, keeping selection on the group row. */
	onOpenRun?: (run: HistoryEntry) => void;
}

export const CueGroupRuns = memo(function CueGroupRuns({
	entry,
	theme,
	expansion,
	onOpenRun,
}: CueGroupRunsProps) {
	const [runs, setRuns] = useState<HistoryEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const { loadRuns } = expansion;
	useEffect(() => {
		let cancelled = false;
		setRuns(null);
		setError(null);
		loadRuns(entry)
			.then((loaded) => {
				if (!cancelled) setRuns(loaded);
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [entry, loadRuns]);

	return (
		<div
			data-cue-group-runs={entry.cueGroup?.key}
			className="mt-2 pt-2 border-t"
			style={{ borderColor: theme.colors.border }}
			// The parent row opens the detail modal on click; a click inside
			// the run list means the run the user aimed at, not the group.
			onClick={(e) => e.stopPropagation()}
		>
			{error ? (
				<p className="text-2xs" style={{ color: theme.colors.error }}>
					Failed to load runs: {error}
				</p>
			) : runs === null ? (
				<p className="text-2xs" style={{ color: theme.colors.textDim }}>
					Loading runs…
				</p>
			) : runs.length === 0 ? (
				<p className="text-2xs" style={{ color: theme.colors.textDim }}>
					No runs in this window.
				</p>
			) : (
				<div style={{ maxHeight: RUNS_MAX_HEIGHT, overflowY: 'auto' }}>
					{runs.map((run) => (
						<button
							key={run.id}
							onClick={() => onOpenRun?.(run)}
							className="w-full flex items-center gap-2 px-1 py-1 rounded text-left hover:bg-white/5 transition-colors"
							title={run.summary}
						>
							{run.success === false ? (
								<X className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.error }} />
							) : (
								<Check className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.success }} />
							)}
							<span
								className="text-2xs font-mono flex-shrink-0"
								style={{ color: theme.colors.textDim }}
							>
								{formatTimestamp(run.timestamp, 'smart')}
							</span>
							<span className="text-2xs truncate" style={{ color: theme.colors.textMain }}>
								{run.summary ? stripMarkdown(run.summary) : 'No summary available'}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
});
