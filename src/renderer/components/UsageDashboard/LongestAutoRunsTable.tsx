/**
 * LongestAutoRunsTable
 *
 * Every Auto Run in the range as a sortable table, longest first by default,
 * 25 rows at a time with "Show more". Shown at the bottom of the Auto Run tab.
 *
 * Columns: Duration, Date and Time (start), Provider, Document, Tasks
 * (completed / total, or a goal run's percent), Project (last path segment).
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { Trophy } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange, AutoRunSession } from '../../../shared/stats-types';
import { formatDurationHuman, formatNumber } from '../../../shared/formatters';
import { isGoalRunDocument, goalRunLabel } from '../../../shared/goalDriven/goalRunLabel';
import { SortableTh } from '../ui/SortableTh';
import { useTableSort } from '../../hooks/ui/useTableSort';
import {
	extractFileName,
	extractProjectName,
	formatAutoRunDate,
	formatAutoRunProvider,
	formatAutoRunTasksLabel,
	formatAutoRunTime,
	LONGEST_AUTORUN_PAGE_SIZE,
	sortAutoRunSessions,
	type AutoRunSortKey,
} from './autoRunTableUtils';
import { DashboardPanelState } from './DashboardPanelState';
import { useAutoRunSessions } from './useAutoRunSessions';

interface LongestAutoRunsTableProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

const NO_SESSIONS: AutoRunSession[] = [];

const COLUMNS: Array<{ key: AutoRunSortKey; label: string }> = [
	{ key: 'duration', label: 'Duration' },
	{ key: 'start', label: 'Started' },
	{ key: 'provider', label: 'Provider' },
	{ key: 'document', label: 'Document' },
	{ key: 'tasks', label: 'Tasks' },
	{ key: 'project', label: 'Project' },
];

/** Magnitudes and dates start biggest/newest first; names start A to Z. */
const defaultDirectionFor = (key: AutoRunSortKey) =>
	key === 'duration' || key === 'start' || key === 'tasks' ? 'desc' : 'asc';

export const LongestAutoRunsTable = memo(function LongestAutoRunsTable({
	timeRange,
	theme,
}: LongestAutoRunsTableProps) {
	// Shares its cache entry with AutoRunStats: one fetch feeds both panels.
	const { data, loading, error, refresh } = useAutoRunSessions(timeRange);
	const sessions = data ?? NO_SESSIONS;
	const { sortKey, direction, isDescending, toggleSort } = useTableSort<AutoRunSortKey>(
		'duration',
		{ defaultDirectionFor }
	);
	const [visibleCount, setVisibleCount] = useState(LONGEST_AUTORUN_PAGE_SIZE);
	useEffect(() => setVisibleCount(LONGEST_AUTORUN_PAGE_SIZE), [timeRange]);

	const sorted = useMemo(
		() => sortAutoRunSessions(sessions, sortKey, isDescending),
		[sessions, sortKey, isDescending]
	);
	const rows = sorted.slice(0, visibleCount);
	const remaining = sorted.length - rows.length;

	const headerClass =
		'text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b select-none';
	const headerStyle = { color: theme.colors.textDim, borderColor: theme.colors.border };

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="longest-autoruns-table"
			role="region"
			aria-label="Auto Runs by duration"
		>
			<div className="flex items-center gap-2 mb-4">
				<Trophy className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Longest Auto Runs
				</h3>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					({formatNumber(sessions.length)} in range)
				</span>
			</div>

			<DashboardPanelState
				theme={theme}
				loading={loading}
				error={error}
				empty={sessions.length === 0}
				emptyMessage="No Auto Runs in this time range"
				onRetry={() => void refresh()}
				testId="longest-autoruns"
			>
				<div className="overflow-x-auto">
					<table
						className="w-full text-sm"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
					>
						<thead>
							<tr>
								<th className={headerClass} style={headerStyle}>
									#
								</th>
								{COLUMNS.map((column) => (
									<SortableTh
										key={column.key}
										columnKey={column.key}
										label={column.label}
										sortKey={sortKey}
										direction={direction}
										onSort={toggleSort}
										theme={theme}
										className={headerClass}
										style={headerStyle}
										title={`Sort by ${column.label}`}
										testId={`longest-autoruns-sort-${column.key}`}
									/>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((session, index) => {
								// Goal runs have no document and no real task count. They record the
								// goal text (behind a `Goal: ` prefix) as the document path and their
								// 0-100 progress as tasksCompleted/tasksTotal. Render them with the goal
								// text + a "Goal" tag and a single percent so they aren't mistaken for
								// a "100-task" document run.
								const isGoal = isGoalRunDocument(session.documentPath);
								const unfinished = session.duration <= 0;
								return (
									<tr
										key={session.id}
										data-testid="longest-autoruns-row"
										style={{
											backgroundColor: index % 2 === 0 ? 'transparent' : `${theme.colors.border}10`,
										}}
									>
										<td
											className="px-3 py-2 font-mono text-xs"
											style={{ color: theme.colors.textDim }}
										>
											{index + 1}
										</td>
										<td
											className="px-3 py-2 font-mono font-medium whitespace-nowrap"
											style={{ color: theme.colors.textMain }}
										>
											{unfinished ? 'unfinished' : formatDurationHuman(session.duration)}
										</td>
										<td
											className="px-3 py-2 whitespace-nowrap"
											style={{ color: theme.colors.textDim }}
										>
											{formatAutoRunDate(session.startTime)}{' '}
											<span className="text-xs">{formatAutoRunTime(session.startTime)}</span>
										</td>
										<td
											className="px-3 py-2 whitespace-nowrap"
											style={{ color: theme.colors.textMain }}
										>
											{formatAutoRunProvider(session.agentType)}
										</td>
										<td
											className="px-3 py-2 max-w-[200px] truncate"
											style={{ color: theme.colors.textDim }}
											title={
												isGoal
													? goalRunLabel(session.documentPath)
													: session.documentPath || undefined
											}
										>
											{isGoal ? (
												<span className="inline-flex items-center gap-1.5 min-w-0">
													<span
														className="shrink-0 px-1.5 py-0.5 rounded text-2xs font-semibold uppercase tracking-wide"
														style={{
															backgroundColor: `${theme.colors.accent}20`,
															color: theme.colors.accent,
														}}
													>
														Goal
													</span>
													<span className="truncate">{goalRunLabel(session.documentPath)}</span>
												</span>
											) : (
												extractFileName(session.documentPath)
											)}
										</td>
										<td
											className="px-3 py-2 whitespace-nowrap font-mono text-xs"
											style={{ color: theme.colors.textDim }}
										>
											{formatAutoRunTasksLabel(session)}
										</td>
										<td
											className="px-3 py-2 max-w-[150px] truncate"
											style={{ color: theme.colors.textDim }}
											title={session.projectPath || undefined}
										>
											{extractProjectName(session.projectPath)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				{remaining > 0 && (
					<div className="flex justify-center mt-3">
						<button
							type="button"
							onClick={() => setVisibleCount((n) => n + LONGEST_AUTORUN_PAGE_SIZE)}
							className="px-3 py-1 rounded text-xs border"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							data-testid="longest-autoruns-show-more"
						>
							Show {formatNumber(Math.min(remaining, LONGEST_AUTORUN_PAGE_SIZE))} more (
							{formatNumber(remaining)} hidden)
						</button>
					</div>
				)}
			</DashboardPanelState>
		</div>
	);
});
