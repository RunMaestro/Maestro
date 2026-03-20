/**
 * ActiveRunsList — Displays currently running Cue tasks with stop controls.
 */

import { Square, StopCircle } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueRunResult } from '../../hooks/useCue';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { PipelineDot } from './StatusDot';
import { formatElapsed, getPipelineForSubscription } from './cueModalUtils';

interface ActiveRunsListProps {
	runs: CueRunResult[];
	theme: Theme;
	onStopRun: (runId: string) => void;
	onStopAll: () => void;
	subscriptionPipelineMap: Map<string, { name: string; color: string }>;
}

export function ActiveRunsList({
	runs,
	theme,
	onStopRun,
	onStopAll,
	subscriptionPipelineMap,
}: ActiveRunsListProps) {
	if (runs.length === 0) {
		return (
			<div className="text-sm py-3" style={{ color: theme.colors.textDim }}>
				No active runs
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{runs.length > 1 && (
				<div className="flex justify-end">
					<button
						onClick={onStopAll}
						className="flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
						style={{ color: '#ef4444' }}
					>
						<StopCircle className="w-3.5 h-3.5" />
						Stop All
					</button>
				</div>
			)}
			{runs.map((run) => (
				<div
					key={run.runId}
					className="flex items-center gap-3 px-3 py-2 rounded"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<button
						onClick={() => onStopRun(run.runId)}
						className="flex-shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
						title="Stop run"
					>
						<Square className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />
					</button>
					<div className="flex-1 min-w-0 flex items-center gap-1.5">
						{(() => {
							const pInfo = getPipelineForSubscription(
								run.subscriptionName,
								subscriptionPipelineMap
							);
							return pInfo ? <PipelineDot color={pInfo.color} name={pInfo.name} /> : null;
						})()}
						<span style={{ color: theme.colors.textMain }}>{run.sessionName}</span>
						<span style={{ color: theme.colors.textDim }}>—</span>
						<span style={{ color: CUE_COLOR }}>"{run.subscriptionName}"</span>
					</div>
					<span className="text-xs font-mono flex-shrink-0" style={{ color: theme.colors.textDim }}>
						{formatElapsed(run.startedAt)}
					</span>
				</div>
			))}
		</div>
	);
}
