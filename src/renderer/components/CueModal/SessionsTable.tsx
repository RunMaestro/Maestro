/**
 * SessionsTable — Table of Cue-enabled sessions with status, pipeline info, and actions.
 */

import { AlertTriangle, FileCode, GitFork, Play, Trash2 } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueSessionStatus } from '../../hooks/useCue';
import {
	CUE_COLOR,
	type CuePipeline,
	type CueGraphSession,
} from '../../../shared/cue-pipeline-types';
import { getPipelineColorForAgent } from '../CuePipelineEditor/pipelineColors';
import { StatusDot, PipelineDot } from './StatusDot';
import { formatRelativeTime } from './cueModalUtils';

interface SessionsTableProps {
	sessions: CueSessionStatus[];
	theme: Theme;
	onViewInPipeline: (session: CueSessionStatus) => void;
	onEditYaml: (session: CueSessionStatus) => void;
	onRemoveCue: (session: CueSessionStatus) => void;
	onTriggerSubscription: (subscriptionName: string) => void;
	queueStatus: Record<string, number>;
	pipelines: CuePipeline[];
	graphSessions: CueGraphSession[];
}

export function SessionsTable({
	sessions,
	theme,
	onViewInPipeline,
	onEditYaml,
	onRemoveCue,
	onTriggerSubscription,
	queueStatus,
	pipelines,
	graphSessions,
}: SessionsTableProps) {
	if (sessions.length === 0) {
		return (
			<div className="text-center py-8 text-sm" style={{ color: theme.colors.textDim }}>
				No sessions have a cue config file. Create .maestro/cue.yaml in your project to get started.
			</div>
		);
	}

	return (
		<table className="w-full text-sm">
			<thead>
				<tr
					className="text-left text-xs border-b"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<th className="pb-2 font-medium">Session</th>
					<th className="pb-2 font-medium">Agent</th>
					<th className="pb-2 font-medium">Pipelines</th>
					<th className="pb-2 font-medium">Status</th>
					<th className="pb-2 font-medium text-right">Last Triggered</th>
					<th className="pb-2 font-medium text-right">Subs</th>
					<th className="pb-2 font-medium text-right">Queue</th>
					<th className="pb-2 font-medium text-right"></th>
				</tr>
			</thead>
			<tbody>
				{sessions.map((s) => {
					const status = !s.enabled ? 'paused' : s.subscriptionCount > 0 ? 'active' : 'none';
					return (
						<tr
							key={s.sessionId}
							className="border-b last:border-b-0"
							style={{ borderColor: theme.colors.border }}
						>
							<td className="py-2" style={{ color: theme.colors.textMain }}>
								<span className="inline-flex items-center gap-1.5">
									{s.ownershipWarning && (
										<span
											role="img"
											tabIndex={0}
											title={s.ownershipWarning}
											aria-label={s.ownershipWarning}
											className="inline-flex focus:outline-none focus-visible:ring-1 focus-visible:ring-current rounded"
										>
											<AlertTriangle
												className="w-3.5 h-3.5 flex-shrink-0"
												style={{ color: theme.colors.error }}
												aria-hidden="true"
											/>
										</span>
									)}
									{s.sessionName}
								</span>
							</td>
							<td className="py-2" style={{ color: theme.colors.textDim }}>
								{s.toolType}
							</td>
							<td className="py-2">
								{(() => {
									const colors = getPipelineColorForAgent(s.sessionId, pipelines);
									if (colors.length === 0) {
										return <span style={{ color: theme.colors.textDim }}>—</span>;
									}
									const pipelineNames = pipelines
										.filter((p) => colors.includes(p.color))
										.map((p) => p.name);
									return (
										<span className="flex items-center gap-1">
											{colors.map((color, i) => (
												<PipelineDot key={color} color={color} name={pipelineNames[i] ?? ''} />
											))}
											{colors.length > 1 && (
												<span style={{ color: theme.colors.textDim, fontSize: '0.7rem' }}>
													×{colors.length}
												</span>
											)}
										</span>
									);
								})()}
							</td>
							<td className="py-2">
								<span className="flex items-center gap-1.5">
									<StatusDot status={status} theme={theme} />
									<span style={{ color: theme.colors.textDim }}>
										{status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'No Config'}
									</span>
								</span>
							</td>
							<td className="py-2 text-right" style={{ color: theme.colors.textDim }}>
								{formatRelativeTime(s.lastTriggered)}
							</td>
							<td className="py-2 text-right" style={{ color: theme.colors.textDim }}>
								{s.subscriptionCount}
							</td>
							<td className="py-2 text-right" style={{ color: theme.colors.textDim }}>
								{queueStatus[s.sessionId] ? `${queueStatus[s.sessionId]} queued` : '—'}
							</td>
							<td className="py-2 text-right">
								<span className="inline-flex items-center gap-2">
									{(() => {
										const gs = graphSessions.find((g) => g.sessionId === s.sessionId);
										const subs = gs?.subscriptions.filter((sub) => sub.enabled !== false) ?? [];
										if (subs.length === 0 || !s.enabled) return null;
										// Build a tooltip that makes fan-out semantics explicit. A single sub
										// with fan_out fires the trigger once and runs every target — clicking
										// Run Now on any participant row fans out to all of them, which would
										// otherwise be a surprising side-effect.
										const fanOutSub = subs.find((sub) => sub.fan_out && sub.fan_out.length > 1);
										const tooltip = fanOutSub
											? `Run ${fanOutSub.name} now — fans out to ${fanOutSub.fan_out!.length} agents`
											: `Run all ${subs.length} subscription(s) now`;
										return (
											<button
												onClick={() => {
													for (const sub of subs) {
														onTriggerSubscription(sub.name);
													}
												}}
												className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
												style={{ color: theme.colors.success }}
												title={tooltip}
											>
												<Play className="w-3.5 h-3.5" />
												Run Now
											</button>
										);
									})()}
									<button
										onClick={() => onEditYaml(s)}
										className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
										style={{ color: theme.colors.textDim }}
										title="Edit cue.yaml"
									>
										<FileCode className="w-3.5 h-3.5" />
										Edit YAML
									</button>
									<button
										onClick={() => onViewInPipeline(s)}
										className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
										style={{ color: CUE_COLOR }}
										title="View in Pipeline Editor"
									>
										<GitFork className="w-3.5 h-3.5" />
										View in Pipeline
									</button>
									<button
										onClick={() => onRemoveCue(s)}
										className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
										style={{ color: theme.colors.error }}
										title="Remove cue.yaml"
									>
										<Trash2 className="w-3.5 h-3.5" />
									</button>
								</span>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
