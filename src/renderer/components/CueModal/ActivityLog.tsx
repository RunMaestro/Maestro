/**
 * ActivityLog — Expandable run history with load-more pagination.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Zap } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueRunResult } from '../../hooks/useCue';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { PipelineDot } from './StatusDot';
import { ActivityLogDetail } from './ActivityLogDetail';
import { formatDuration, getPipelineForSubscription } from './cueModalUtils';

interface ActivityLogProps {
	log: CueRunResult[];
	theme: Theme;
	subscriptionPipelineMap: Map<string, { name: string; color: string }>;
}

export function ActivityLog({ log, theme, subscriptionPipelineMap }: ActivityLogProps) {
	const [visibleCount, setVisibleCount] = useState(100);
	const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

	if (log.length === 0) {
		return (
			<div className="text-sm py-3" style={{ color: theme.colors.textDim }}>
				No activity yet
			</div>
		);
	}

	const visible = log.slice(0, visibleCount);

	return (
		<div className="space-y-0.5">
			{visible.map((entry) => {
				const isFailed = entry.status === 'failed' || entry.status === 'timeout';
				const eventType = entry.event.type;
				const filePayload =
					eventType === 'file.changed' && entry.event.payload?.file
						? ` (${String(entry.event.payload.file).split('/').pop()})`
						: '';
				const taskPayload =
					eventType === 'task.pending' && entry.event.payload?.filename
						? ` (${String(entry.event.payload.filename)}: ${String(entry.event.payload.taskCount ?? 0)} task(s))`
						: '';
				const githubPayload =
					(eventType === 'github.pull_request' || eventType === 'github.issue') &&
					entry.event.payload?.number
						? ` (#${String(entry.event.payload.number)} ${String(entry.event.payload.title ?? '')})`
						: '';
				const isReconciled = entry.event.payload?.reconciled === true;
				const isExpanded = expandedRunId === entry.runId;

				return (
					<div key={entry.runId}>
						<button
							onClick={() => setExpandedRunId(isExpanded ? null : entry.runId)}
							className="flex items-center gap-2 py-1.5 text-xs w-full text-left rounded hover:bg-white/5 transition-colors px-1"
						>
							{isExpanded ? (
								<ChevronDown
									className="w-3 h-3 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
							) : (
								<ChevronRight
									className="w-3 h-3 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
							)}
							<span className="flex-shrink-0 font-mono" style={{ color: theme.colors.textDim }}>
								{new Date(entry.startedAt).toLocaleTimeString()}
							</span>
							{(() => {
								const pInfo = getPipelineForSubscription(
									entry.subscriptionName,
									subscriptionPipelineMap
								);
								return pInfo ? (
									<PipelineDot color={pInfo.color} name={pInfo.name} />
								) : (
									<Zap className="w-3 h-3 flex-shrink-0" style={{ color: CUE_COLOR }} />
								);
							})()}
							<span className="flex-1 min-w-0 truncate">
								<span style={{ color: theme.colors.textMain }}>"{entry.subscriptionName}"</span>
								{isReconciled && (
									<span
										className="inline-block ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold"
										style={{
											backgroundColor: `${theme.colors.warning}20`,
											color: theme.colors.warning,
										}}
									>
										catch-up
									</span>
								)}
								<span style={{ color: theme.colors.textDim }}>
									{' '}
									triggered ({eventType}){filePayload}
									{taskPayload}
									{githubPayload} →{' '}
								</span>
								{isFailed ? (
									<span style={{ color: theme.colors.error }}>{entry.status} ✗</span>
								) : entry.status === 'stopped' ? (
									<span style={{ color: theme.colors.warning }}>stopped</span>
								) : (
									<span style={{ color: theme.colors.success }}>
										completed in {formatDuration(entry.durationMs)} ✓
									</span>
								)}
							</span>
						</button>
						{isExpanded && <ActivityLogDetail entry={entry} theme={theme} />}
					</div>
				);
			})}
			{log.length > visibleCount && (
				<button
					onClick={() => setVisibleCount((c) => c + 100)}
					className="text-xs py-2 w-full text-center rounded hover:opacity-80 transition-opacity"
					style={{ color: CUE_COLOR }}
				>
					Load more ({log.length - visibleCount} remaining)
				</button>
			)}
		</div>
	);
}
