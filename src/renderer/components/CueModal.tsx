import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Zap, Square, HelpCircle, StopCircle } from 'lucide-react';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useCue } from '../hooks/useCue';
import type { CueSessionStatus, CueRunResult } from '../hooks/useCue';

interface CueModalProps {
	theme: Theme;
	onClose: () => void;
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

function SessionsTable({ sessions, theme }: { sessions: CueSessionStatus[]; theme: Theme }) {
	if (sessions.length === 0) {
		return (
			<div className="text-center py-8 text-sm" style={{ color: theme.colors.textDim }}>
				No sessions have a maestro-cue.yaml file. Create one in your project root to get started.
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
					<th className="pb-2 font-medium">Status</th>
					<th className="pb-2 font-medium text-right">Last Triggered</th>
					<th className="pb-2 font-medium text-right">Subs</th>
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
}: {
	runs: CueRunResult[];
	theme: Theme;
	onStopRun: (runId: string) => void;
	onStopAll: () => void;
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
					<div className="flex-1 min-w-0">
						<span style={{ color: theme.colors.textMain }}>{run.sessionName}</span>
						<span className="mx-1.5" style={{ color: theme.colors.textDim }}>
							—
						</span>
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

function ActivityLog({ log, theme }: { log: CueRunResult[]; theme: Theme }) {
	const [visibleCount, setVisibleCount] = useState(100);

	if (log.length === 0) {
		return (
			<div className="text-sm py-3" style={{ color: theme.colors.textDim }}>
				No activity yet
			</div>
		);
	}

	const visible = log.slice(0, visibleCount);

	return (
		<div className="space-y-1">
			{visible.map((entry) => {
				const isFailed = entry.status === 'failed' || entry.status === 'timeout';
				const eventType = entry.event.type;
				const filePayload =
					eventType === 'file.changed' && entry.event.payload?.file
						? ` (${String(entry.event.payload.file).split('/').pop()})`
						: '';

				return (
					<div key={entry.runId} className="flex items-center gap-2 py-1.5 text-xs">
						<span className="flex-shrink-0 font-mono" style={{ color: theme.colors.textDim }}>
							{new Date(entry.startedAt).toLocaleTimeString()}
						</span>
						<Zap className="w-3 h-3 flex-shrink-0" style={{ color: CUE_TEAL }} />
						<span className="flex-1 min-w-0 truncate">
							<span style={{ color: theme.colors.textMain }}>"{entry.subscriptionName}"</span>
							<span style={{ color: theme.colors.textDim }}>
								{' '}
								triggered ({eventType}){filePayload} →{' '}
							</span>
							{isFailed ? (
								<span style={{ color: '#ef4444' }}>{entry.status} ✗</span>
							) : (
								<span style={{ color: '#22c55e' }}>
									completed in {formatDuration(entry.durationMs)} ✓
								</span>
							)}
						</span>
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

export function CueModal({ theme, onClose }: CueModalProps) {
	const { registerLayer, unregisterLayer } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const { sessions, activeRuns, activityLog, loading, enable, disable, stopRun, stopAll } =
		useCue();

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

	// Active runs section is collapsible when empty
	const [activeRunsExpanded, setActiveRunsExpanded] = useState(true);

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center"
			style={{ zIndex: MODAL_PRIORITIES.CUE_MODAL }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/50" />

			{/* Modal */}
			<div
				className="relative rounded-xl shadow-2xl flex flex-col"
				style={{
					width: 780,
					maxHeight: '85vh',
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-5 py-4 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3">
						<Zap className="w-5 h-5" style={{ color: CUE_TEAL }} />
						<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
							Maestro Cue
						</h2>
					</div>
					<div className="flex items-center gap-3">
						{/* Master toggle */}
						<button
							onClick={handleToggle}
							className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
							style={{
								backgroundColor: isEnabled ? `${CUE_TEAL}20` : theme.colors.bgActivity,
								color: isEnabled ? CUE_TEAL : theme.colors.textDim,
							}}
						>
							<div
								className="relative w-8 h-4 rounded-full transition-colors"
								style={{ backgroundColor: isEnabled ? CUE_TEAL : theme.colors.border }}
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
							className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
							title="Help"
							style={{ color: theme.colors.textDim }}
						>
							<HelpCircle className="w-4 h-4" />
						</button>

						{/* Close button */}
						<button
							onClick={onClose}
							className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* Body */}
				<div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
					{loading ? (
						<div className="text-center py-12 text-sm" style={{ color: theme.colors.textDim }}>
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
								<SessionsTable sessions={sessions} theme={theme} />
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
											style={{ backgroundColor: CUE_TEAL, color: '#fff' }}
										>
											{activeRuns.length}
										</span>
									)}
								</button>
								{activeRunsExpanded && (
									<ActiveRunsList
										runs={activeRuns}
										theme={theme}
										onStopRun={stopRun}
										onStopAll={stopAll}
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
									className="max-h-64 overflow-y-auto rounded-md px-3 py-2"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									<ActivityLog log={activityLog} theme={theme} />
								</div>
							</div>
						</>
					)}
				</div>
			</div>
		</div>,
		document.body
	);
}
