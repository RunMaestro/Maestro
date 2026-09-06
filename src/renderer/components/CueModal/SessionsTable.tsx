/**
 * SessionsTable - Table of Cue-enabled sessions with status, pipeline info, and actions.
 */

import { useEffect, useRef } from 'react';
import { AlertTriangle, FileCode, GitFork, Play, Trash2 } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueSessionStatus } from '../../hooks/useCue';
import {
	CUE_COLOR,
	type CuePipeline,
	type CueGraphSession,
} from '../../../shared/cue-pipeline-types';
import { pipelinesForSession } from '../CuePipelineEditor/utils/pipelineMembership';
import { StatusDot, PipelineDot } from './StatusDot';
import { formatRelativeTime } from './cueModalUtils';
import type { CueSubscription } from '../../../shared/cue';

// Mirrors the engine's anchor-group key so Run Now fires exactly one
// representative per (pipeline_name, trigger-config) pair - not one per
// pipeline_name, which would miss distinct trigger groups within a pipeline.
function triggerGroupKey(sub: CueSubscription): string {
	const filter = sub.filter
		? Object.keys(sub.filter)
				.sort()
				.reduce<Record<string, unknown>>((acc, k) => {
					acc[k] = (sub.filter as Record<string, unknown>)[k];
					return acc;
				}, {})
		: null;
	return JSON.stringify({
		event: sub.event,
		schedule_times: sub.schedule_times ?? null,
		schedule_days: sub.schedule_days ?? null,
		interval_minutes: sub.interval_minutes ?? null,
		watch: sub.watch ?? null,
		repo: sub.repo ?? null,
		poll_minutes: sub.poll_minutes ?? null,
		gh_state: sub.gh_state ?? null,
		label: sub.label ?? null,
		filter,
	});
}

interface SessionsTableProps {
	sessions: CueSessionStatus[];
	/**
	 * Agent to highlight and scroll into view. Set when the dashboard was opened
	 * from one agent's right-click menu, which promises a single agent while
	 * this table shows them all. Undefined for the global entry points, which
	 * have nothing to disambiguate.
	 */
	focusSessionId?: string;
	theme: Theme;
	onViewInGraph: (session: CueSessionStatus) => void;
	onEditYaml: (session: CueSessionStatus) => void;
	onRemoveCue: (session: CueSessionStatus) => void;
	onTriggerSubscription: (subscriptionName: string) => void;
	queueStatus: Record<string, number>;
	pipelines: CuePipeline[];
	graphSessions: CueGraphSession[];
}

export function SessionsTable({
	sessions,
	focusSessionId,
	theme,
	onViewInGraph,
	onEditYaml,
	onRemoveCue,
	onTriggerSubscription,
	queueStatus,
	pipelines,
	graphSessions,
}: SessionsTableProps) {
	const focusedRowRef = useRef<HTMLTableRowElement>(null);

	// Bring the right-clicked agent into view. `block: 'nearest'` so a row that
	// is already visible does not jump the table, and the effect keys on the id
	// rather than firing once on mount - the rows arrive asynchronously with the
	// status query, and re-opening for a different agent must re-scroll.
	useEffect(() => {
		if (!focusSessionId) return;
		focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
	}, [focusSessionId, sessions]);

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
					const isFocused = !!focusSessionId && s.sessionId === focusSessionId;
					return (
						<tr
							key={s.sessionId}
							ref={isFocused ? focusedRowRef : undefined}
							data-focused={isFocused || undefined}
							data-testid={isFocused ? 'cue-session-row-focused' : undefined}
							className="border-b last:border-b-0"
							style={{
								borderColor: theme.colors.border,
								// Tint rather than a border: the row already owns its
								// bottom border, and swapping that would shift the table.
								backgroundColor: isFocused ? `${theme.colors.accent}1a` : undefined,
							}}
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
									// Dots are per PIPELINE, not per color: two pipelines can share a
									// color, and pairing names to colors dropped one of them and
									// mislabeled the other.
									const owned = pipelinesForSession(s.sessionId, pipelines, graphSessions);
									if (owned.length === 0) {
										return <span style={{ color: theme.colors.textDim }}>—</span>;
									}
									return (
										<span className="flex items-center gap-1">
											{owned.map((p) => (
												<PipelineDot key={p.id} color={p.color} name={p.name} />
											))}
											{owned.length > 1 && (
												<span style={{ color: theme.colors.textDim, fontSize: '0.7rem' }}>
													×{owned.length}
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
										// with fan_out fires the trigger once and runs every target - clicking
										// Run Now on any participant row fans out to all of them, which would
										// otherwise be a surprising side-effect.
										const fanOutSub = subs.find((sub) => sub.fan_out && sub.fan_out.length > 1);
										const tooltip = fanOutSub
											? `Run ${fanOutSub.name} now — fans out to ${fanOutSub.fan_out!.length} agents`
											: `Run all ${subs.length} subscription(s) now`;
										return (
											<button
												onClick={() => {
													// Deduplicate by (pipeline_name, triggerGroupKey): the
													// engine fires all siblings sharing both the same
													// pipeline_name AND the same trigger config (anchor-group
													// logic). Keying on pipeline_name alone drops distinct
													// trigger groups within a pipeline (e.g. heartbeat +
													// file-watcher). Fire one representative per unique
													// (name, config) pair; ungrouped subs fire individually.
													const seenGroups = new Set<string>();
													for (const sub of subs) {
														if (sub.pipeline_name) {
															const key = `${sub.pipeline_name}\u0000${triggerGroupKey(sub)}`;
															if (seenGroups.has(key)) continue;
															seenGroups.add(key);
														}
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
										onClick={() => onViewInGraph(s)}
										className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
										style={{ color: CUE_COLOR }}
										title="View on the Pipeline Graph tab"
									>
										<GitFork className="w-3.5 h-3.5" />
										View in Graph
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
