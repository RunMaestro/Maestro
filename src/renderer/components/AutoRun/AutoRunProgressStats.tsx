/**
 * The three-column stat strip at the top of the Auto Run progress card:
 * how far along the run is, how long it has been working, and how long it has
 * left. The math lives in `shared/autorunProgress.ts`; this only lays it out.
 */

import { memo } from 'react';
import type { BatchRunState, Theme } from '../../types';
import { autoRunProgressPercent, estimateAutoRunEta } from '../../../shared/autorunProgress';
import type { AutoRunEta } from '../../../shared/autorunProgress';
import {
	DURATION_MS,
	formatDurationCompact,
	formatDurationHuman,
	formatTimestamp,
} from '../../../shared/formatters';

interface AutoRunProgressStatsProps {
	theme: Theme;
	batchState: BatchRunState;
	/** Live active elapsed time (sleep and paused spans excluded), or null before the first tick. */
	elapsedMs: number | null;
	/** Paints the percent in the error color (error-paused or stopping), matching the bar. */
	halted: boolean;
	errorPaused: boolean;
}

const ETA_TOOLTIP =
	"Projected from this run's average time per task. Approximate: the total grows when a document resets its tasks.";

function remainingSubline(
	eta: AutoRunEta,
	{ errorPaused, loopEnabled }: { errorPaused: boolean; loopEnabled: boolean }
): string {
	if (!eta.available) {
		switch (eta.reason) {
			case 'goal':
				return 'goal run';
			case 'warming-up':
				return `after ${eta.tasksUntilEstimate} more task${eta.tasksUntilEstimate === 1 ? '' : 's'}`;
			case 'no-baseline':
				return 'not available';
		}
	}
	if (errorPaused) return 'paused';
	if (eta.remainingMs < DURATION_MS.minute) return 'almost done';
	const doneAt = formatTimestamp(Date.now() + eta.remainingMs, 'smart');
	return loopEnabled ? `this pass ≈ ${doneAt}` : `done ≈ ${doneAt}`;
}

export const AutoRunProgressStats = memo(function AutoRunProgressStats({
	theme,
	batchState,
	elapsedMs,
	halted,
	errorPaused,
}: AutoRunProgressStatsProps) {
	const percent = autoRunProgressPercent(batchState);
	const eta = estimateAutoRunEta({
		goalMode: batchState.goalMode,
		totalTasksAcrossAllDocs: batchState.totalTasksAcrossAllDocs,
		completedTasksAcrossAllDocs: batchState.completedTasksAcrossAllDocs,
		initialCompletedTasks: batchState.initialCompletedTasks,
		activeElapsedMs: elapsedMs ?? 0,
	});

	const useAllDocTotals = batchState.totalTasksAcrossAllDocs > 0;
	const completed = useAllDocTotals
		? batchState.completedTasksAcrossAllDocs
		: batchState.completedTasks;
	const total = useAllDocTotals ? batchState.totalTasksAcrossAllDocs : batchState.totalTasks;
	const progressSub = batchState.goalMode
		? batchState.goalIteration
			? `iteration ${batchState.goalIteration}`
			: 'goal progress'
		: `${completed} / ${total} tasks`;

	const columns: Array<{
		id: string;
		label: string;
		value: string;
		sub: string;
		valueColor: string;
		title?: string;
	}> = [
		{
			id: 'progress',
			label: 'Progress',
			value: `${Math.round(percent)}%`,
			sub: progressSub,
			valueColor: halted ? theme.colors.error : theme.colors.warning,
		},
		{
			id: 'elapsed',
			label: 'Elapsed',
			value: elapsedMs === null ? '-' : formatDurationHuman(elapsedMs),
			sub: eta.available ? `≈ ${formatDurationHuman(eta.msPerTask)} / task` : 'active time',
			valueColor: theme.colors.textMain,
			title: 'Active run time: machine sleep and paused spans are excluded',
		},
		{
			id: 'remaining',
			label: 'Remaining',
			value: eta.available ? `~${formatDurationCompact(eta.remainingMs)}` : '-',
			sub: remainingSubline(eta, { errorPaused, loopEnabled: batchState.loopEnabled }),
			valueColor: theme.colors.textMain,
			title: ETA_TOOLTIP,
		},
	];

	return (
		<div className="grid grid-cols-3 mb-2" data-testid="autorun-progress-stats">
			{columns.map((col, index) => (
				<div
					key={col.id}
					className={`min-w-0 ${index > 0 ? 'pl-3 border-l' : ''} ${index < columns.length - 1 ? 'pr-3' : ''}`}
					style={index > 0 ? { borderColor: theme.colors.border } : undefined}
					title={col.title}
					data-testid={`autorun-stat-${col.id}`}
				>
					<div
						className="text-2xs font-semibold uppercase tracking-wider truncate"
						style={{ color: theme.colors.textDim }}
					>
						{col.label}
					</div>
					<div
						className="text-base font-bold tabular-nums whitespace-nowrap truncate"
						style={{ color: col.valueColor }}
						data-testid={`autorun-stat-${col.id}-value`}
					>
						{col.value}
					</div>
					<div
						className="text-2xs truncate"
						style={{ color: theme.colors.textDim }}
						data-testid={`autorun-stat-${col.id}-sub`}
					>
						{col.sub}
					</div>
				</div>
			))}
		</div>
	);
});
