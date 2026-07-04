/**
 * LongestAutoRunsTable
 *
 * Displays the top 25 longest Auto Run sessions in a sortable table.
 * Shown at the bottom of the Auto Run tab in the Usage Dashboard.
 *
 * Columns:
 * - Duration (sorted longest → shortest)
 * - Date (start time)
 * - Agent (agent type display name)
 * - Document (file name from documentPath)
 * - Tasks (completed / total)
 * - Project (last path segment)
 */

import { memo, useState, useEffect, useMemo, useCallback } from 'react';
import { Trophy } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange, AutoRunSession } from '../../../shared/stats-types';
import { captureException } from '../../utils/sentry';
import { formatDurationHuman as formatDuration } from '../../../shared/formatters';
import { isGoalRunDocument, goalRunLabel } from '../../../shared/goalDriven/goalRunLabel';
import {
	extractFileName,
	extractProjectName,
	formatAgentName,
	formatAutoRunDate,
	formatAutoRunTasksLabel,
	formatAutoRunTime,
	getTopAutoRunSessions,
	MAX_LONGEST_AUTORUN_ROWS,
} from './autoRunTableUtils';

interface LongestAutoRunsTableProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

export const LongestAutoRunsTable = memo(function LongestAutoRunsTable({
	timeRange,
	theme,
}: LongestAutoRunsTableProps) {
	const [sessions, setSessions] = useState<AutoRunSession[]>([]);
	const [loading, setLoading] = useState(true);

	const fetchData = useCallback(async () => {
		setLoading(true);
		try {
			const autoRunSessions = await window.maestro.stats.getAutoRunSessions(timeRange);
			setSessions(autoRunSessions);
		} catch (err) {
			captureException(err);
		} finally {
			setLoading(false);
		}
	}, [timeRange]);

	useEffect(() => {
		fetchData();

		const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
			fetchData();
		});

		return () => unsubscribe();
	}, [fetchData]);

	// Sort by duration (longest first) and take top 25
	const topSessions = useMemo(() => {
		return getTopAutoRunSessions(sessions);
	}, [sessions]);

	if (loading) {
		return (
			<div
				className="p-4 rounded-lg"
				style={{ backgroundColor: theme.colors.bgMain }}
				data-testid="longest-autoruns-loading"
			>
				<div
					className="h-32 flex items-center justify-center"
					style={{ color: theme.colors.textDim }}
				>
					Loading longest Auto Runs...
				</div>
			</div>
		);
	}

	if (topSessions.length === 0) {
		return null; // Don't show table if no data. AutoRunStats already shows empty state.
	}

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="longest-autoruns-table"
			role="region"
			aria-label="Top 25 longest Auto Run sessions"
		>
			<div className="flex items-center gap-2 mb-4">
				<Trophy className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Top {Math.min(topSessions.length, MAX_LONGEST_AUTORUN_ROWS)} Longest Auto Runs
				</h3>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					({sessions.length} total)
				</span>
			</div>

			<div className="overflow-x-auto">
				<table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
					<thead>
						<tr>
							{['#', 'Duration', 'Date', 'Time', 'Agent', 'Document', 'Tasks', 'Project'].map(
								(header) => (
									<th
										key={header}
										className="text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b"
										style={{
											color: theme.colors.textDim,
											borderColor: theme.colors.border,
										}}
									>
										{header}
									</th>
								)
							)}
						</tr>
					</thead>
					<tbody>
						{topSessions.map((session, index) => {
							// Goal runs have no document and no real task count. They record the
							// goal text (behind a `Goal: ` prefix) as the document path and their
							// 0-100 progress as tasksCompleted/tasksTotal. Render them with the goal
							// text + a "Goal" tag and a single percent so they aren't mistaken for
							// a "100-task" document run.
							const isGoal = isGoalRunDocument(session.documentPath);
							const tasksLabel = formatAutoRunTasksLabel(session);

							return (
								<tr
									key={session.id}
									className="transition-colors"
									style={{
										backgroundColor: index % 2 === 0 ? 'transparent' : `${theme.colors.border}10`,
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.backgroundColor =
											index % 2 === 0 ? 'transparent' : `${theme.colors.border}10`;
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
										{formatDuration(session.duration)}
									</td>
									<td
										className="px-3 py-2 whitespace-nowrap"
										style={{ color: theme.colors.textDim }}
									>
										{formatAutoRunDate(session.startTime)}
									</td>
									<td
										className="px-3 py-2 whitespace-nowrap"
										style={{ color: theme.colors.textDim }}
									>
										{formatAutoRunTime(session.startTime)}
									</td>
									<td
										className="px-3 py-2 whitespace-nowrap"
										style={{ color: theme.colors.textMain }}
									>
										{formatAgentName(session.agentType)}
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
													className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
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
										{tasksLabel}
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
		</div>
	);
});

export default LongestAutoRunsTable;
