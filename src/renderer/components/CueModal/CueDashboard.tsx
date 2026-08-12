/**
 * CueDashboard - Dashboard tab body. Top-row stats, sessions table, and
 * collapsible active runs. The Activity Log lives on its own tab.
 *
 * Pure presentational. Parent CueModal owns all data + callbacks.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueSessionStatus } from '../../hooks/useCue';
import type { CuePipeline, CueGraphSession } from '../../../shared/cue-pipeline-types';
import type { CueRunResult } from '../../../shared/cue/contracts';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { SessionsTable } from './SessionsTable';
import { ActiveRunsList } from './ActiveRunsList';
import { CueDashboardStats } from './CueDashboardStats';

export interface CueDashboardProps {
	theme: Theme;
	loading: boolean;
	error: string | null;
	graphError: string | null;
	onRetry: () => void;
	sessions: CueSessionStatus[];
	activeRuns: CueRunResult[];
	/** Recent completed/failed runs - used to compute average runtime stat. */
	activityLog: CueRunResult[];
	queueStatus: Record<string, number>;
	graphSessions: CueGraphSession[];
	dashboardPipelines: CuePipeline[];
	subscriptionPipelineMap: Map<string, { name: string; color: string }>;
	/** Lifetime count of Cue events from the on-disk journal. */
	executionCount: number;
	activeRunsExpanded: boolean;
	setActiveRunsExpanded: (expanded: boolean) => void;
	onViewInPipeline: (session: CueSessionStatus) => void;
	onEditYaml: (session: CueSessionStatus) => void;
	onRemoveCue: (session: CueSessionStatus) => void;
	onTriggerSubscription: (subscriptionName: string) => void;
	/** Fire-and-forget - matches ActiveRunsList's onClick invocation. Any returned
	 *  promise is discarded; errors should be surfaced via toasts in the caller. */
	onStopRun: (runId: string) => void;
	onStopAll: () => void;
}

export function CueDashboard({
	theme,
	loading,
	error,
	graphError,
	onRetry,
	sessions,
	activeRuns,
	activityLog,
	queueStatus,
	graphSessions,
	dashboardPipelines,
	subscriptionPipelineMap,
	executionCount,
	activeRunsExpanded,
	setActiveRunsExpanded,
	onViewInPipeline,
	onEditYaml,
	onRemoveCue,
	onTriggerSubscription,
	onStopRun,
	onStopAll,
}: CueDashboardProps) {
	// Average runtime across the loaded activity log. Excludes still-running
	// entries (durationMs is final-state only). null when no finished runs are
	// available so the stat card can render an em dash instead of "0ms".
	const averageRuntimeMs = useMemo(() => {
		const finished = activityLog.filter((r) => r.status !== 'running');
		if (finished.length === 0) return null;
		const total = finished.reduce((sum, r) => sum + r.durationMs, 0);
		return total / finished.length;
	}, [activityLog]);

	// Hide sessions flagged with an ownershipWarning by default - these are
	// non-owners of a shared cue.yaml (e.g. a Codex / OpenCode agent sitting
	// at the same cwd as the agent that actually owns the subs). They add
	// visual noise to a dashboard a user normally only cares about for the
	// agents that ARE wired into a pipeline. Toggle reveals them when
	// debugging shared-cwd ownership.
	const [showWarningSessions, setShowWarningSessions] = useState(false);

	// Sort alphabetically (ignoring leading emojis so 🧠 Substrate sorts as
	// "Substrate", not by emoji codepoint) then optionally drop ownership-
	// warning rows. Done in one memo so a sort + filter swap doesn't re-render
	// twice.
	const visibleSessions = useMemo(() => {
		const sorted = [...sessions].sort((a, b) =>
			compareNamesIgnoringEmojis(a.sessionName, b.sessionName)
		);
		return showWarningSessions ? sorted : sorted.filter((s) => !s.ownershipWarning);
	}, [sessions, showWarningSessions]);

	const hiddenWarningCount = useMemo(
		() => sessions.filter((s) => s.ownershipWarning).length,
		[sessions]
	);

	// Distinct agents referenced by any pipeline's agent nodes - "agents
	// associated with Cue" in the dashboard sense.
	const agentCount = useMemo(() => {
		const ids = new Set<string>();
		for (const pipeline of dashboardPipelines) {
			for (const node of pipeline.nodes) {
				if (node.type === 'agent' && 'sessionId' in node.data) {
					ids.add(node.data.sessionId);
				}
			}
		}
		return ids.size;
	}, [dashboardPipelines]);

	if (loading) {
		return (
			<div className="text-center py-12 text-sm" style={{ color: theme.colors.textDim }}>
				Loading Cue status...
			</div>
		);
	}

	return (
		<>
			{(error || graphError) && (
				<div
					className="flex items-center gap-2 px-3 py-2 rounded-md text-xs"
					style={{
						backgroundColor: `${theme.colors.error}15`,
						border: `1px solid ${theme.colors.error}40`,
						color: theme.colors.error,
					}}
				>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
					<span className="flex-1">{error || graphError}</span>
					<button
						onClick={onRetry}
						className="px-2 py-0.5 rounded text-xs hover:opacity-80"
						style={{ color: theme.colors.textMain }}
					>
						Retry
					</button>
				</div>
			)}

			{/* Top-row stats */}
			<CueDashboardStats
				theme={theme}
				pipelineCount={dashboardPipelines.length}
				executionCount={executionCount}
				averageRuntimeMs={averageRuntimeMs}
				agentCount={agentCount}
			/>

			{/* Sessions with Cue */}
			<div>
				<div className="flex items-center justify-between mb-3">
					<h3
						className="text-xs font-bold uppercase tracking-wider"
						style={{ color: theme.colors.textDim }}
					>
						Sessions with Cue
					</h3>
					{hiddenWarningCount > 0 && (
						<label
							className="flex items-center gap-1.5 text-xs cursor-pointer select-none hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.textDim }}
							title="Show sessions flagged with an ownership warning (non-owners of a shared cue.yaml)."
						>
							<input
								type="checkbox"
								checked={showWarningSessions}
								onChange={(e) => setShowWarningSessions(e.target.checked)}
								className="cursor-pointer"
								style={{ accentColor: theme.colors.accent }}
							/>
							<span>
								Show {hiddenWarningCount} flagged session
								{hiddenWarningCount === 1 ? '' : 's'}
							</span>
						</label>
					)}
				</div>
				<SessionsTable
					sessions={visibleSessions}
					theme={theme}
					onViewInPipeline={onViewInPipeline}
					onEditYaml={onEditYaml}
					onRemoveCue={onRemoveCue}
					onTriggerSubscription={onTriggerSubscription}
					queueStatus={queueStatus}
					pipelines={dashboardPipelines}
					graphSessions={graphSessions}
				/>
			</div>

			{/* Active Runs */}
			<div>
				<button
					onClick={() => setActiveRunsExpanded(!activeRunsExpanded)}
					className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider mb-3 hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.textDim }}
				>
					Active Runs
					{activeRuns.length > 0 && (
						<span
							className="px-1.5 py-0.5 rounded-full text-[10px] font-bold"
							style={{ backgroundColor: CUE_COLOR, color: '#fff' }}
						>
							{activeRuns.length}
						</span>
					)}
					{activeRuns.length > 0 && sessions.some((s) => s.activeRuns > 0) && (
						<span
							className="text-[10px] font-normal normal-case tracking-normal"
							style={{ color: theme.colors.textDim }}
						>
							{sessions
								.filter((s) => s.activeRuns > 0)
								.map(
									(s) =>
										`${s.sessionName}: ${s.activeRuns} slot${s.activeRuns !== 1 ? 's' : ''} used`
								)
								.join(' · ')}
						</span>
					)}
				</button>
				{activeRunsExpanded && (
					<ActiveRunsList
						runs={activeRuns}
						theme={theme}
						onStopRun={onStopRun}
						onStopAll={onStopAll}
						subscriptionPipelineMap={subscriptionPipelineMap}
					/>
				)}
			</div>
		</>
	);
}
