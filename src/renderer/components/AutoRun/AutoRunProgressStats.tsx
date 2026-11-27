/**
 * The three-column stat strip at the top of the Auto Run progress card:
 * how far along the run is, how long it has been working, and how long it has
 * left. The math lives in `shared/autorunProgress.ts`; this only lays it out.
 *
 * A goal run has no task count to project an ETA from, so its third column
 * shows momentum instead: what the last loop gained and how close the run is
 * to the stall stop (`summarizeGoalLoops` in `shared/goalDriven`).
 */

import { memo } from 'react';
import type { BatchRunState, Theme } from '../../types';
import {
	autoRunProgressPercent,
	autoRunTaskCounts,
	estimateAutoRunEta,
} from '../../../shared/autorunProgress';
import type { AutoRunEta } from '../../../shared/autorunProgress';
import type { GoalLoopStats } from '../../../shared/goalDriven/types';
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

interface StatColumn {
	id: string;
	label: string;
	value: string;
	sub: string;
	valueColor: string;
	subColor?: string;
	title?: string;
}

/** Signed percent for a loop's gain: whole points, one decimal under 1%. */
function formatGoalDelta(delta: number): string {
	const abs = Math.abs(delta);
	const magnitude =
		abs >= 1 ? String(Math.round(abs)) : abs >= 0.1 ? abs.toFixed(1) : abs > 0 ? '<0.1' : '0';
	const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
	return `${sign}${magnitude}%`;
}

/**
 * The goal-mode columns. `goalIteration` counts FINISHED loops, so the loop in
 * flight is one past it (capped, since the last loop's count can land before
 * the run exits).
 */
function goalColumns(
	theme: Theme,
	batchState: BatchRunState,
	elapsedMs: number | null,
	halted: boolean
): StatColumn[] {
	const loops: GoalLoopStats | undefined = batchState.goalLoops;
	const finished = batchState.goalIteration ?? 0;
	const max = loops?.maxIterations ?? null;
	const inFlight = max === null ? finished + 1 : Math.min(finished + 1, max);
	const avgLoopMs = loops && finished > 0 ? loops.completedActiveMs / finished : 0;
	const delta = loops?.lastDelta ?? null;
	const nearStall = loops !== undefined && loops.flatStreak > 0;

	return [
		{
			id: 'progress',
			label: 'Progress',
			value: `${Math.round(autoRunProgressPercent(batchState))}%`,
			sub: max === null ? `loop ${inFlight}` : `loop ${inFlight} of ${max}`,
			valueColor: halted ? theme.colors.error : theme.colors.warning,
		},
		{
			id: 'elapsed',
			label: 'Elapsed',
			value: elapsedMs === null ? '-' : formatDurationHuman(elapsedMs),
			sub: avgLoopMs > 0 ? `≈ ${formatDurationHuman(avgLoopMs)} / loop` : 'active time',
			valueColor: theme.colors.textMain,
			title: 'Active run time: machine sleep and paused spans are excluded',
		},
		{
			id: 'remaining',
			label: 'Last loop',
			value: delta === null ? '-' : formatGoalDelta(delta),
			sub:
				delta === null || !loops
					? 'after loop 1'
					: `stall ${loops.flatStreak} of ${loops.flatLimit}`,
			valueColor:
				delta === null || delta === 0
					? theme.colors.textMain
					: delta > 0
						? theme.colors.success
						: theme.colors.error,
			subColor: nearStall ? theme.colors.warning : undefined,
			title: loops
				? `Progress the last finished loop gained. The run stops as stalled after ${loops.flatLimit} loops in a row with no gain.`
				: undefined,
		},
	];
}

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

function taskColumns(
	theme: Theme,
	batchState: BatchRunState,
	elapsedMs: number | null,
	halted: boolean,
	errorPaused: boolean
): StatColumn[] {
	const eta = estimateAutoRunEta({
		goalMode: batchState.goalMode,
		totalTasksAcrossAllDocs: batchState.totalTasksAcrossAllDocs,
		completedTasksAcrossAllDocs: batchState.completedTasksAcrossAllDocs,
		initialCompletedTasks: batchState.initialCompletedTasks,
		activeElapsedMs: elapsedMs ?? 0,
	});

	const { completed, total } = autoRunTaskCounts(batchState);
	return [
		{
			id: 'progress',
			label: 'Progress',
			value: `${Math.round(autoRunProgressPercent(batchState))}%`,
			sub: `${completed} / ${total} tasks`,
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
}

export const AutoRunProgressStats = memo(function AutoRunProgressStats({
	theme,
	batchState,
	elapsedMs,
	halted,
	errorPaused,
}: AutoRunProgressStatsProps) {
	const columns = batchState.goalMode
		? goalColumns(theme, batchState, elapsedMs, halted)
		: taskColumns(theme, batchState, elapsedMs, halted, errorPaused);

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
						style={{ color: col.subColor ?? theme.colors.textDim }}
						data-testid={`autorun-stat-${col.id}-sub`}
					>
						{col.sub}
					</div>
				</div>
			))}
		</div>
	);
});
