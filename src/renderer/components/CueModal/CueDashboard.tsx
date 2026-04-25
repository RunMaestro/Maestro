/**
 * CueDashboard — Composes the dashboard tab's three sections: Sessions
 * table, Active Runs list (collapsible), and Activity Log.
 *
 * Pure presentational. Parent CueModal owns all data + callbacks.
 */

import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueSessionStatus } from '../../hooks/useCue';
import type { CuePipeline, CueGraphSession } from '../../../shared/cue-pipeline-types';
import type { CueRunResult } from '../../../shared/cue/contracts';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { SessionsTable } from './SessionsTable';
import { ActiveRunsList } from './ActiveRunsList';
import { ActivityLog } from './ActivityLog';

export interface CueDashboardProps {
	theme: Theme;
	loading: boolean;
	error: string | null;
	graphError: string | null;
	onRetry: () => void;
	sessions: CueSessionStatus[];
	activeRuns: CueRunResult[];
	activityLog: CueRunResult[];
	queueStatus: Record<string, number>;
	graphSessions: CueGraphSession[];
	dashboardPipelines: CuePipeline[];
	subscriptionPipelineMap: Map<string, { name: string; color: string }>;
	activeRunsExpanded: boolean;
	setActiveRunsExpanded: (expanded: boolean) => void;
	onViewInPipeline: (session: CueSessionStatus) => void;
	onEditYaml: (session: CueSessionStatus) => void;
	onRemoveCue: (session: CueSessionStatus) => void;
	onTriggerSubscription: (subscriptionName: string) => void;
	/** Fire-and-forget — matches ActiveRunsList's onClick invocation. Any returned
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
	activeRunsExpanded,
	setActiveRunsExpanded,
	onViewInPipeline,
	onEditYaml,
	onRemoveCue,
	onTriggerSubscription,
	onStopRun,
	onStopAll,
}: CueDashboardProps) {
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

			{/* Section 1: Sessions with Cue */}
			<div>
				<h3
					className="text-xs font-bold uppercase tracking-wider mb-3"
					style={{ color: theme.colors.textDim }}
				>
					Sessions with Cue
				</h3>
				<SessionsTable
					sessions={sessions}
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

			{/* Section 2: Active Runs */}
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

			{/* Section 3: Activity Log */}
			<div>
				<h3
					className="text-xs font-bold uppercase tracking-wider mb-3"
					style={{ color: theme.colors.textDim }}
				>
					Activity Log
				</h3>
				<div
					className="max-h-96 overflow-y-auto rounded-md px-3 py-2"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<ActivityLog
						log={activityLog}
						theme={theme}
						subscriptionPipelineMap={subscriptionPipelineMap}
					/>
				</div>
			</div>
		</>
	);
}
