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
import type { StatsTimeRange } from '../../hooks/stats/useStats';
import { captureException } from '../../utils/sentry';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import {
	DEFAULT_AUTORUN_ANALYTICS_FILTERS,
	formatAgentStrategy,
	formatPromptProfile,
	formatSchedulerMode,
	formatWorktreeMode,
	hasActiveAutoRunFilters,
	type AutoRunAnalyticsFilters,
} from './autoRunFilters';

/**
 * Auto Run session data shape from the API
 */
interface AutoRunSession {
	id: string;
	sessionId: string;
	agentType: string;
	documentPath?: string;
	startTime: number;
	duration: number;
	tasksTotal?: number;
	tasksCompleted?: number;
	projectPath?: string;
	playbookName?: string;
	promptProfile?: 'full' | 'compact-code' | 'compact-doc';
	agentStrategy?: 'single' | 'plan-execute-verify';
	worktreeMode?: 'disabled' | 'managed' | 'existing-open' | 'existing-closed' | 'create-new';
	schedulerMode?: 'sequential' | 'dag';
}

interface LongestAutoRunsTableProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
	/** Shared Auto Run filters for linked dashboard views */
	filters?: AutoRunAnalyticsFilters;
	/** Callback for controlled filter changes */
	onFiltersChange?: (filters: AutoRunAnalyticsFilters) => void;
}

const MAX_ROWS = 25;

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
	if (ms === 0) return '0s';

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Format agent type to display name
 */
function formatAgentName(agentType: string): string {
	return getAgentDisplayName(agentType);
}

/**
 * Extract file name from a document path
 */
function extractFileName(path?: string): string {
	if (!path) return '—';
	const segments = path.replace(/\\/g, '/').split('/');
	return segments[segments.length - 1] || '—';
}

/**
 * Extract last path segment from project path
 */
function extractProjectName(path?: string): string {
	if (!path) return '—';
	const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
	return segments[segments.length - 1] || '—';
}

function buildFilterOptions(
	values: string[],
	formatLabel?: (value: string) => string
): Array<{ value: string; label: string }> {
	return [...new Set(values)]
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b))
		.map((value) => ({ value, label: formatLabel ? formatLabel(value) : value }));
}

/**
 * Format date for table display
 */
function formatDate(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

/**
 * Format time for table display
 */
function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString('en-US', {
		hour: 'numeric',
		minute: '2-digit',
	});
}

export const LongestAutoRunsTable = memo(function LongestAutoRunsTable({
	timeRange,
	theme,
	filters,
	onFiltersChange,
}: LongestAutoRunsTableProps) {
	const [sessions, setSessions] = useState<AutoRunSession[]>([]);
	const [loading, setLoading] = useState(true);
	const [internalFilters, setInternalFilters] = useState<AutoRunAnalyticsFilters>(
		DEFAULT_AUTORUN_ANALYTICS_FILTERS
	);
	const activeFilters = filters ?? internalFilters;

	const updateFilters = useCallback(
		(nextFilters: AutoRunAnalyticsFilters) => {
			if (onFiltersChange) {
				onFiltersChange(nextFilters);
				return;
			}
			setInternalFilters(nextFilters);
		},
		[onFiltersChange]
	);

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
	const filterOptions = useMemo(
		() => ({
			playbooks: buildFilterOptions(
				sessions.map((session) => session.playbookName).filter(Boolean) as string[]
			),
			profiles: buildFilterOptions(
				sessions.map((session) => session.promptProfile).filter(Boolean) as string[],
				(value) => formatPromptProfile(value as AutoRunSession['promptProfile'])
			),
			strategies: buildFilterOptions(
				sessions.map((session) => session.agentStrategy).filter(Boolean) as string[],
				(value) => formatAgentStrategy(value as AutoRunSession['agentStrategy'])
			),
			worktrees: buildFilterOptions(
				sessions.map((session) => session.worktreeMode).filter(Boolean) as string[],
				(value) => formatWorktreeMode(value as AutoRunSession['worktreeMode'])
			),
			schedulers: buildFilterOptions(
				sessions.map((session) => session.schedulerMode).filter(Boolean) as string[],
				(value) => formatSchedulerMode(value as AutoRunSession['schedulerMode'])
			),
		}),
		[sessions]
	);

	const filteredSessions = useMemo(() => {
		return sessions.filter((session) => {
			if (
				activeFilters.playbookName &&
				(session.playbookName || '') !== activeFilters.playbookName
			) {
				return false;
			}
			if (activeFilters.promptProfile && session.promptProfile !== activeFilters.promptProfile) {
				return false;
			}
			if (activeFilters.agentStrategy && session.agentStrategy !== activeFilters.agentStrategy) {
				return false;
			}
			if (activeFilters.worktreeMode && session.worktreeMode !== activeFilters.worktreeMode) {
				return false;
			}
			if (activeFilters.schedulerMode && session.schedulerMode !== activeFilters.schedulerMode) {
				return false;
			}
			return true;
		});
	}, [sessions, activeFilters]);

	const topSessions = useMemo(() => {
		return [...filteredSessions].sort((a, b) => b.duration - a.duration).slice(0, MAX_ROWS);
	}, [filteredSessions]);

	const hasActiveFilters = hasActiveAutoRunFilters(activeFilters);

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

	if (sessions.length === 0) {
		return null; // Don't show table if no data — AutoRunStats already shows empty state
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
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Top {Math.min(topSessions.length, MAX_ROWS)} Longest Auto Runs
				</h3>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					({filteredSessions.length} filtered / {sessions.length} total)
				</span>
				{hasActiveFilters && (
					<button
						type="button"
						onClick={() => updateFilters(DEFAULT_AUTORUN_ANALYTICS_FILTERS)}
						className="ml-auto px-2.5 py-1 rounded text-xs font-medium border"
						style={{
							color: theme.colors.accent,
							borderColor: `${theme.colors.accent}55`,
							backgroundColor: `${theme.colors.accent}10`,
						}}
					>
						Clear Filters
					</button>
				)}
			</div>

			<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5 mb-4">
				{(
					[
						{
							label: 'Playbook',
							value: activeFilters.playbookName,
							onChange: (value: string) =>
								updateFilters({
									...activeFilters,
									playbookName: value,
								}),
							options: filterOptions.playbooks,
						},
						{
							label: 'Prompt Profile',
							value: activeFilters.promptProfile,
							onChange: (value: AutoRunAnalyticsFilters['promptProfile']) =>
								updateFilters({
									...activeFilters,
									promptProfile: value,
								}),
							options: filterOptions.profiles,
						},
						{
							label: 'Strategy',
							value: activeFilters.agentStrategy,
							onChange: (value: AutoRunAnalyticsFilters['agentStrategy']) =>
								updateFilters({
									...activeFilters,
									agentStrategy: value,
								}),
							options: filterOptions.strategies,
						},
						{
							label: 'Worktree',
							value: activeFilters.worktreeMode,
							onChange: (value: AutoRunAnalyticsFilters['worktreeMode']) =>
								updateFilters({
									...activeFilters,
									worktreeMode: value,
								}),
							options: filterOptions.worktrees,
						},
						{
							label: 'Scheduler',
							value: activeFilters.schedulerMode,
							onChange: (value: AutoRunAnalyticsFilters['schedulerMode']) =>
								updateFilters({
									...activeFilters,
									schedulerMode: value,
								}),
							options: filterOptions.schedulers,
						},
					] as Array<{
						label: string;
						value: string;
						onChange: (value: string) => void;
						options: Array<{ value: string; label: string }>;
					}>
				).map((filter) => (
					<label key={filter.label} className="flex flex-col gap-1">
						<span
							className="text-[10px] font-bold uppercase"
							style={{ color: theme.colors.textDim }}
						>
							{filter.label}
						</span>
						<select
							value={filter.value}
							onChange={(event) => filter.onChange(event.target.value)}
							className="rounded border px-2 py-1.5 text-sm"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						>
							<option value="">All</option>
							{filter.options.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</label>
				))}
			</div>

			<div className="overflow-x-auto">
				{topSessions.length === 0 ? (
					<div
						className="rounded border px-4 py-8 text-sm text-center"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
						}}
					>
						No Auto Run sessions match the current filters.
					</div>
				) : (
					<table
						className="w-full text-sm"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
					>
						<thead>
							<tr>
								{[
									'#',
									'Duration',
									'Date',
									'Time',
									'Agent',
									'Playbook',
									'Run Mode',
									'Document',
									'Tasks',
									'Project',
								].map((header) => (
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
								))}
							</tr>
						</thead>
						<tbody>
							{topSessions.map((session, index) => {
								const tasksLabel =
									session.tasksTotal != null
										? `${session.tasksCompleted ?? 0} / ${session.tasksTotal}`
										: '—';

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
											{formatDate(session.startTime)}
										</td>
										<td
											className="px-3 py-2 whitespace-nowrap"
											style={{ color: theme.colors.textDim }}
										>
											{formatTime(session.startTime)}
										</td>
										<td
											className="px-3 py-2 whitespace-nowrap"
											style={{ color: theme.colors.textMain }}
										>
											{formatAgentName(session.agentType)}
										</td>
										<td
											className="px-3 py-2 max-w-[180px] truncate"
											style={{ color: theme.colors.textMain }}
											title={session.playbookName || undefined}
										>
											{session.playbookName || '—'}
										</td>
										<td
											className="px-3 py-2 whitespace-nowrap"
											style={{ color: theme.colors.textDim }}
										>
											{`${formatPromptProfile(session.promptProfile)} / ${formatAgentStrategy(session.agentStrategy)} / WT ${formatWorktreeMode(session.worktreeMode)} / ${formatSchedulerMode(session.schedulerMode)}`}
										</td>
										<td
											className="px-3 py-2 max-w-[200px] truncate"
											style={{ color: theme.colors.textDim }}
											title={session.documentPath || undefined}
										>
											{extractFileName(session.documentPath)}
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
				)}
			</div>
		</div>
	);
});

export default LongestAutoRunsTable;
