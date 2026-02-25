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

import { memo, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Trophy } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange } from '../../hooks/stats/useStats';
import { captureException } from '../../utils/sentry';

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
}

interface LongestAutoRunsTableProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
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
	const names: Record<string, string> = {
		'claude-code': 'Claude Code',
		opencode: 'OpenCode',
		'openai-codex': 'OpenAI Codex',
		codex: 'Codex',
		'gemini-cli': 'Gemini CLI',
		'qwen3-coder': 'Qwen3 Coder',
		'factory-droid': 'Factory Droid',
		terminal: 'Terminal',
	};
	return names[agentType] || agentType;
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
}: LongestAutoRunsTableProps) {
	const [sessions, setSessions] = useState<AutoRunSession[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const requestIdRef = useRef(0);

	const fetchData = useCallback(async () => {
		const thisRequestId = ++requestIdRef.current;
		setLoading(true);
		setError(false);
		try {
			const autoRunSessions = await window.maestro.stats.getAutoRunSessions(timeRange);
			if (thisRequestId !== requestIdRef.current) return;
			setSessions(autoRunSessions);
		} catch (err) {
			captureException(err);
			if (thisRequestId !== requestIdRef.current) return;
			if (
				err instanceof Error &&
				(err.name === 'AbortError' ||
					err.message.includes('SQLITE') ||
					err.message.includes('timeout'))
			) {
				setError(true);
			} else {
				setError(true);
				throw err;
			}
		} finally {
			if (thisRequestId === requestIdRef.current) {
				setLoading(false);
			}
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
		return [...sessions].sort((a, b) => b.duration - a.duration).slice(0, MAX_ROWS);
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

	if (error) {
		return (
			<div
				className="p-4 rounded-lg outline-none"
				style={{ backgroundColor: theme.colors.bgMain }}
				data-testid="longest-autoruns-error"
				tabIndex={0}
				role="alert"
				aria-live="assertive"
				ref={(el) => el?.focus()}
			>
				<div
					className="h-32 flex items-center justify-center text-sm"
					style={{ color: theme.colors.textDim }}
				>
					Failed to load Auto Run data
				</div>
			</div>
		);
	}

	if (topSessions.length === 0) {
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
			</div>
		</div>
	);
});

export default LongestAutoRunsTable;
