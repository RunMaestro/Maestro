import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
	X,
	Zap,
	Square,
	HelpCircle,
	StopCircle,
	LayoutDashboard,
	GitFork,
	ArrowLeft,
	FileCode,
	Trash2,
	Play,
	ChevronDown,
	ChevronRight,
	Clock,
	Terminal,
	AlertTriangle,
} from 'lucide-react';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useCue } from '../hooks/useCue';
import type { CueSessionStatus, CueRunResult } from '../hooks/useCue';
import { CueYamlEditor } from './CueYamlEditor';
import { CueHelpContent } from './CueHelpModal';
// Kept for reference - visual pipeline editor replaces this
// import { CueGraphView } from './CueGraphView';
import { CuePipelineEditor } from './CuePipelineEditor';
import { useSessionStore } from '../stores/sessionStore';
import type { CuePipeline } from '../../shared/cue-pipeline-types';
import { getPipelineColorForAgent } from './CuePipelineEditor/pipelineColors';
import { graphSessionsToPipelines } from './CuePipelineEditor/utils/yamlToPipeline';

type CueModalTab = 'dashboard' | 'pipeline';

interface CueGraphSession {
	sessionId: string;
	sessionName: string;
	toolType: string;
	subscriptions: Array<{
		name: string;
		event: string;
		enabled: boolean;
		prompt?: string;
		output_prompt?: string;
		interval_minutes?: number;
		schedule_times?: string[];
		schedule_days?: string[];
		watch?: string;
		source_session?: string | string[];
		fan_out?: string[];
		filter?: Record<string, string | number | boolean>;
		repo?: string;
		poll_minutes?: number;
		agent_id?: string;
	}>;
}

interface CueModalProps {
	theme: Theme;
	onClose: () => void;
	cueShortcutKeys?: string[];
}

const CUE_TEAL = '#06b6d4';

function formatRelativeTime(dateStr?: string): string {
	if (!dateStr) return '—';
	const diff = Date.now() - new Date(dateStr).getTime();
	if (diff < 0) return 'just now';
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSeconds = seconds % 60;
	return `${minutes}m ${remainSeconds}s`;
}

function formatElapsed(startedAt: string): string {
	const diff = Date.now() - new Date(startedAt).getTime();
	return formatDuration(Math.max(0, diff));
}

function StatusDot({ status }: { status: 'active' | 'paused' | 'none' }) {
	const color = status === 'active' ? '#22c55e' : status === 'paused' ? '#eab308' : '#6b7280';
	return <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />;
}

function PipelineDot({ color, name }: { color: string; name: string }) {
	return (
		<span
			className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
			style={{ backgroundColor: color }}
			title={name}
		/>
	);
}

/** Maps subscription names to pipeline info by checking name prefixes. */
function buildSubscriptionPipelineMap(
	pipelines: CuePipeline[]
): Map<string, { name: string; color: string }> {
	const map = new Map<string, { name: string; color: string }>();
	for (const pipeline of pipelines) {
		// Pipeline subscriptions are named: pipelineName, pipelineName-chain-N
		map.set(pipeline.name, { name: pipeline.name, color: pipeline.color });
	}
	return map;
}

/** Looks up the pipeline for a subscription name by matching the base name prefix. */
function getPipelineForSubscription(
	subscriptionName: string,
	pipelineMap: Map<string, { name: string; color: string }>
): { name: string; color: string } | null {
	// Strip -chain-N suffix to get base pipeline name
	const baseName = subscriptionName.replace(/-chain-\d+$/, '').replace(/-fanin$/, '');
	return pipelineMap.get(baseName) ?? null;
}

function SessionsTable({
	sessions,
	theme,
	onViewInPipeline,
	onEditYaml,
	onRemoveCue,
	onTriggerSubscription,
	queueStatus,
	pipelines,
	graphSessions,
}: {
	sessions: CueSessionStatus[];
	theme: Theme;
	onViewInPipeline: (session: CueSessionStatus) => void;
	onEditYaml: (session: CueSessionStatus) => void;
	onRemoveCue: (session: CueSessionStatus) => void;
	onTriggerSubscription: (subscriptionName: string) => void;
	queueStatus: Record<string, number>;
	pipelines: CuePipeline[];
	graphSessions: CueGraphSession[];
}) {
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
								{s.sessionName}
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
										</span>
									);
								})()}
							</td>
							<td className="py-2">
								<span className="flex items-center gap-1.5">
									<StatusDot status={status} />
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
										return (
											<button
												onClick={() => {
													for (const sub of subs) {
														onTriggerSubscription(sub.name);
													}
												}}
												className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
												style={{ color: '#22c55e' }}
												title={`Run all ${subs.length} subscription(s) now`}
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
										style={{ color: CUE_TEAL }}
										title="View in Pipeline Editor"
									>
										<GitFork className="w-3.5 h-3.5" />
										View in Pipeline
									</button>
									<button
										onClick={() => onRemoveCue(s)}
										className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
										style={{ color: '#ef4444' }}
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

function ActiveRunsList({
	runs,
	theme,
	onStopRun,
	onStopAll,
	subscriptionPipelineMap,
}: {
	runs: CueRunResult[];
	theme: Theme;
	onStopRun: (runId: string) => void;
	onStopAll: () => void;
	subscriptionPipelineMap: Map<string, { name: string; color: string }>;
}) {
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
						<span style={{ color: CUE_TEAL }}>"{run.subscriptionName}"</span>
					</div>
					<span className="text-xs font-mono flex-shrink-0" style={{ color: theme.colors.textDim }}>
						{formatElapsed(run.startedAt)}
					</span>
				</div>
			))}
		</div>
	);
}

/** Formats event payload into human-readable key-value pairs, filtering out noise. */
function formatPayloadEntries(payload: Record<string, unknown>): Array<[string, string]> {
	const skipKeys = new Set(['outputPromptPhase', 'manual']);
	const entries: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(payload)) {
		if (skipKeys.has(key)) continue;
		if (value === undefined || value === null || value === '') continue;
		const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
		// Truncate very long values for display
		entries.push([key, strValue.length > 500 ? strValue.slice(0, 500) + '…' : strValue]);
	}
	return entries;
}

function ActivityLogDetail({ entry, theme }: { entry: CueRunResult; theme: Theme }) {
	const payloadEntries = formatPayloadEntries(entry.event.payload);
	const hasStdout = entry.stdout.trim().length > 0;
	const hasStderr = entry.stderr.trim().length > 0;

	return (
		<div
			className="mt-1 mb-2 rounded-md px-3 py-3 text-xs space-y-3"
			style={{ backgroundColor: theme.colors.bgMain, border: `1px solid ${theme.colors.border}` }}
		>
			{/* Execution metadata */}
			<div className="grid grid-cols-2 gap-x-6 gap-y-1">
				<div className="flex items-center gap-1.5">
					<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span style={{ color: theme.colors.textDim }}>Started:</span>
					<span style={{ color: theme.colors.textMain }}>
						{new Date(entry.startedAt).toLocaleString()}
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span style={{ color: theme.colors.textDim }}>Duration:</span>
					<span style={{ color: theme.colors.textMain }}>{formatDuration(entry.durationMs)}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Zap className="w-3 h-3" style={{ color: CUE_TEAL }} />
					<span style={{ color: theme.colors.textDim }}>Event:</span>
					<span style={{ color: theme.colors.textMain }}>{entry.event.type}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Terminal className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span style={{ color: theme.colors.textDim }}>Exit code:</span>
					<span
						style={{
							color:
								entry.exitCode === 0
									? '#22c55e'
									: entry.exitCode != null
										? '#ef4444'
										: theme.colors.textDim,
						}}
					>
						{entry.exitCode ?? '—'}
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span style={{ color: theme.colors.textDim }}>Session:</span>
					<span style={{ color: theme.colors.textMain }}>{entry.sessionName}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span style={{ color: theme.colors.textDim }}>Run ID:</span>
					<span className="font-mono" style={{ color: theme.colors.textDim }}>
						{entry.runId.slice(0, 8)}
					</span>
				</div>
			</div>

			{/* Event payload */}
			{payloadEntries.length > 0 && (
				<div>
					<div
						className="text-[10px] font-bold uppercase tracking-wider mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Event Payload
					</div>
					<div
						className="rounded px-2 py-1.5 font-mono text-[11px] space-y-0.5 max-h-32 overflow-y-auto"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						{payloadEntries.map(([key, value]) => (
							<div key={key} className="flex gap-2">
								<span className="flex-shrink-0" style={{ color: CUE_TEAL }}>
									{key}:
								</span>
								<span className="break-all" style={{ color: theme.colors.textMain }}>
									{value}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* stdout */}
			{hasStdout && (
				<div>
					<div
						className="text-[10px] font-bold uppercase tracking-wider mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Output
					</div>
					<pre
						className="rounded px-2 py-1.5 text-[11px] max-h-48 overflow-y-auto whitespace-pre-wrap break-all"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
					>
						{entry.stdout.slice(-5000)}
					</pre>
				</div>
			)}

			{/* stderr */}
			{hasStderr && (
				<div>
					<div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider mb-1">
						<AlertTriangle className="w-3 h-3" style={{ color: '#ef4444' }} />
						<span style={{ color: '#ef4444' }}>Errors</span>
					</div>
					<pre
						className="rounded px-2 py-1.5 text-[11px] max-h-32 overflow-y-auto whitespace-pre-wrap break-all"
						style={{ backgroundColor: '#ef444410', color: '#ef4444' }}
					>
						{entry.stderr.slice(-3000)}
					</pre>
				</div>
			)}
		</div>
	);
}

function ActivityLog({
	log,
	theme,
	subscriptionPipelineMap,
}: {
	log: CueRunResult[];
	theme: Theme;
	subscriptionPipelineMap: Map<string, { name: string; color: string }>;
}) {
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
									<Zap className="w-3 h-3 flex-shrink-0" style={{ color: CUE_TEAL }} />
								);
							})()}
							<span className="flex-1 min-w-0 truncate">
								<span style={{ color: theme.colors.textMain }}>"{entry.subscriptionName}"</span>
								{isReconciled && (
									<span
										className="inline-block ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold"
										style={{ backgroundColor: '#f59e0b20', color: '#f59e0b' }}
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
									<span style={{ color: '#ef4444' }}>{entry.status} ✗</span>
								) : entry.status === 'stopped' ? (
									<span style={{ color: '#f59e0b' }}>stopped</span>
								) : (
									<span style={{ color: '#22c55e' }}>
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
					style={{ color: CUE_TEAL }}
				>
					Load more ({log.length - visibleCount} remaining)
				</button>
			)}
		</div>
	);
}

export function CueModal({ theme, onClose, cueShortcutKeys }: CueModalProps) {
	const { registerLayer, unregisterLayer } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const {
		sessions,
		activeRuns,
		activityLog,
		queueStatus,
		loading,
		enable,
		disable,
		stopRun,
		stopAll,
		triggerSubscription,
		refresh,
	} = useCue();

	const allSessions = useSessionStore((state) => state.sessions);
	const groups = useSessionStore((state) => state.groups);
	const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);

	const sessionInfoList = useMemo(
		() =>
			allSessions.map((s) => ({
				id: s.id,
				groupId: s.groupId,
				name: s.name,
				toolType: s.toolType,
				projectRoot: s.projectRoot,
			})),
		[allSessions]
	);

	const [graphSessions, setGraphSessions] = useState<CueGraphSession[]>([]);

	const handleSwitchToSession = useCallback(
		(id: string) => {
			setActiveSessionId(id);
			onClose();
		},
		[setActiveSessionId, onClose]
	);

	const isEnabled = sessions.some((s) => s.enabled);

	const handleToggle = useCallback(() => {
		if (isEnabled) {
			disable();
		} else {
			enable();
		}
	}, [isEnabled, enable, disable]);

	// Register layer on mount
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.CUE_MODAL,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			onEscape: () => {
				if (showHelpRef.current) {
					setShowHelp(false);
					return;
				}
				if (pipelineDirtyRef.current) {
					const confirmed = window.confirm(
						'You have unsaved changes in the pipeline editor. Discard and close?'
					);
					if (!confirmed) return;
				}
				onCloseRef.current();
			},
		});
		layerIdRef.current = id;

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Tab state
	const [activeTab, setActiveTab] = useState<CueModalTab>('pipeline');

	// Fetch graph data on mount and when tab changes (needed for both dashboard and pipeline tabs)
	useEffect(() => {
		let cancelled = false;
		window.maestro.cue
			.getGraphData()
			.then((data: CueGraphSession[]) => {
				if (!cancelled) setGraphSessions(data);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [activeTab]);

	// Compute pipelines from graph sessions for dashboard pipeline info
	const dashboardPipelines = useMemo(() => {
		if (graphSessions.length === 0) return [];
		return graphSessionsToPipelines(graphSessions, sessionInfoList);
	}, [graphSessions, sessionInfoList]);

	// Build subscription-to-pipeline lookup map
	const subscriptionPipelineMap = useMemo(
		() => buildSubscriptionPipelineMap(dashboardPipelines),
		[dashboardPipelines]
	);

	// Help modal state
	const [showHelp, setShowHelp] = useState(false);
	const showHelpRef = useRef(false);
	showHelpRef.current = showHelp;

	// Pipeline dirty state (unsaved changes)
	const [pipelineDirty, setPipelineDirty] = useState(false);
	const pipelineDirtyRef = useRef(false);
	pipelineDirtyRef.current = pipelineDirty;

	// YAML editor state
	const [yamlEditorSession, setYamlEditorSession] = useState<CueSessionStatus | null>(null);

	const handleEditYaml = useCallback((session: CueSessionStatus) => {
		setYamlEditorSession(session);
	}, []);

	const handleViewInPipeline = useCallback((_session: CueSessionStatus) => {
		setActiveTab('pipeline');
	}, []);

	const handleRemoveCue = useCallback(
		async (session: CueSessionStatus) => {
			const confirmed = window.confirm(
				`Remove Cue configuration for "${session.sessionName}"?\n\nThis will delete the cue.yaml file from this project. This cannot be undone.`
			);
			if (!confirmed) return;
			await window.maestro.cue.deleteYaml(session.projectRoot);
			await refresh();
		},
		[refresh]
	);

	// Close with unsaved changes confirmation
	const handleCloseWithConfirm = useCallback(() => {
		if (pipelineDirtyRef.current) {
			const confirmed = window.confirm(
				'You have unsaved changes in the pipeline editor. Discard and close?'
			);
			if (!confirmed) return;
		}
		onClose();
	}, [onClose]);

	// Active runs section is collapsible when empty
	const [activeRunsExpanded, setActiveRunsExpanded] = useState(true);

	return (
		<>
			{createPortal(
				<div
					className="fixed inset-0 flex items-center justify-center"
					style={{ zIndex: MODAL_PRIORITIES.CUE_MODAL }}
					onClick={(e) => {
						if (e.target === e.currentTarget) handleCloseWithConfirm();
					}}
				>
					{/* Backdrop */}
					<div className="absolute inset-0 bg-black/50" />

					{/* Modal */}
					<div
						className="relative rounded-xl shadow-2xl flex flex-col"
						style={{
							width: '80vw',
							maxWidth: 1400,
							height: '85vh',
							maxHeight: 900,
							backgroundColor: theme.colors.bgMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{/* Header */}
						<div
							className="flex items-center justify-between px-5 py-4 border-b shrink-0"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-3">
								{showHelp ? (
									<>
										<button
											onClick={() => setShowHelp(false)}
											className="p-1 rounded-md hover:bg-white/10 transition-colors"
											style={{ color: theme.colors.textDim }}
											title="Back to dashboard"
										>
											<ArrowLeft className="w-4 h-4" />
										</button>
										<Zap className="w-5 h-5" style={{ color: CUE_TEAL }} />
										<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
											Maestro Cue Guide
										</h2>
									</>
								) : (
									<>
										<Zap className="w-5 h-5" style={{ color: CUE_TEAL }} />
										<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
											Maestro Cue
										</h2>

										{/* Tab bar */}
										<div
											className="flex items-center gap-1 ml-3 rounded-md p-0.5"
											style={{ backgroundColor: theme.colors.bgActivity }}
										>
											<button
												onClick={() => setActiveTab('dashboard')}
												className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors"
												style={{
													backgroundColor:
														activeTab === 'dashboard' ? theme.colors.bgMain : 'transparent',
													color:
														activeTab === 'dashboard'
															? theme.colors.textMain
															: theme.colors.textDim,
												}}
											>
												<LayoutDashboard className="w-3.5 h-3.5" />
												Dashboard
											</button>
											<button
												onClick={() => setActiveTab('pipeline')}
												className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors"
												style={{
													backgroundColor:
														activeTab === 'pipeline' ? theme.colors.bgMain : 'transparent',
													color:
														activeTab === 'pipeline' ? theme.colors.textMain : theme.colors.textDim,
												}}
											>
												<GitFork className="w-3.5 h-3.5" />
												Pipeline Editor
											</button>
										</div>
									</>
								)}
							</div>
							<div className="flex items-center gap-3">
								{!showHelp && (
									<>
										{/* Master toggle */}
										<button
											onClick={handleToggle}
											className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
											style={{
												backgroundColor: isEnabled
													? `${theme.colors.accent}20`
													: theme.colors.bgActivity,
												color: isEnabled ? theme.colors.accent : theme.colors.textDim,
											}}
										>
											<div
												className="relative w-8 h-4 rounded-full transition-colors"
												style={{
													backgroundColor: isEnabled ? theme.colors.accent : theme.colors.border,
												}}
											>
												<div
													className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
													style={{
														transform: isEnabled ? 'translateX(17px)' : 'translateX(2px)',
													}}
												/>
											</div>
											{isEnabled ? 'Enabled' : 'Disabled'}
										</button>

										{/* Help button */}
										<button
											onClick={() => setShowHelp(true)}
											className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
											title="Help"
											style={{ color: theme.colors.textDim }}
										>
											<HelpCircle className="w-4 h-4" />
										</button>
									</>
								)}

								{/* Close button */}
								<button
									onClick={handleCloseWithConfirm}
									className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textDim }}
								>
									<X className="w-4 h-4" />
								</button>
							</div>
						</div>

						{/* Body */}
						{showHelp ? (
							<div className="flex-1 overflow-y-auto px-5 py-4">
								<CueHelpContent theme={theme} cueShortcutKeys={cueShortcutKeys} />
							</div>
						) : activeTab === 'dashboard' ? (
							<div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
								{loading ? (
									<div
										className="text-center py-12 text-sm"
										style={{ color: theme.colors.textDim }}
									>
										Loading Cue status...
									</div>
								) : (
									<>
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
												onViewInPipeline={handleViewInPipeline}
												onEditYaml={handleEditYaml}
												onRemoveCue={handleRemoveCue}
												onTriggerSubscription={triggerSubscription}
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
														style={{
															backgroundColor: CUE_TEAL,
															color: '#fff',
														}}
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
													onStopRun={stopRun}
													onStopAll={stopAll}
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
								)}
							</div>
						) : (
							<CuePipelineEditor
								sessions={sessionInfoList}
								groups={groups}
								graphSessions={graphSessions}
								onSwitchToSession={handleSwitchToSession}
								onClose={onClose}
								onDirtyChange={setPipelineDirty}
								theme={theme}
								activeRuns={activeRuns}
							/>
						)}
					</div>
				</div>,
				document.body
			)}
			{showHelp && <CueHelpContent theme={theme} cueShortcutKeys={cueShortcutKeys} />}
		</>
	);
}
