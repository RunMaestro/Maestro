import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import type { ProcessDetailData, ProcessMonitorProps, ProcessNode } from './types';
import { buildProcessTree } from './processTree';
import { useProcessMonitorData } from './hooks/useProcessMonitorData';
import { useProcessExpansion } from './hooks/useProcessExpansion';
import { useProcessKill } from './hooks/useProcessKill';
import { useProcessKeyboardNav } from './hooks/useProcessKeyboardNav';
import { ProcessListView } from './ProcessListView';
import { ProcessDetailView } from './ProcessDetailView';
import { KillConfirmDialog } from './KillConfirmDialog';
import { ResizeHandles } from '../ui/ResizeHandles';
import { useSettingsStore } from '../../stores/settingsStore';

// Hook composition order:
//   1. useProcessMonitorData owns polling and exposes refresh.
//   2. tree is memoised from raw inputs only — does NOT depend on expansion state,
//      because the renderer reads expandedIds.has(node.id) directly rather than
//      consulting the (formerly stamped) node.expanded field.
//   3. useProcessExpansion receives tree for stepper depth math + initial-restore.
//      Its `hasExpandedInitially` guard makes per-poll re-runs safe no-ops.
//   4. useProcessKill receives data.refresh + a settle callback that clears the kill prompt.
//   5. useProcessKeyboardNav is stateless and just maps keys → mutators.
export function ProcessMonitor(props: ProcessMonitorProps) {
	const virtuososEnabled = useSettingsStore((s) => s.encoreFeatures.virtuosos);
	const {
		theme,
		sessions,
		groups,
		groupChats = [],
		onClose,
		onNavigateToSession,
		onNavigateToGroupChat,
	} = props;

	const data = useProcessMonitorData();
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [detailView, setDetailView] = useState<ProcessDetailData | null>(null);
	const [killConfirm, setKillConfirm] = useState<{
		processSessionId: string;
		cueRunId?: string;
	} | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const tree = useMemo(
		() =>
			buildProcessTree({
				sessions,
				groups,
				groupChats,
				activeProcesses: data.activeProcesses,
			}),
		[sessions, groups, groupChats, data.activeProcesses]
	);

	const expansion = useProcessExpansion(tree, data.isLoading);

	const kill = useProcessKill(data.refresh, () => setKillConfirm(null));

	const openProcessDetail = useCallback((node: ProcessNode) => {
		if (!node.processSessionId || !node.pid) return;

		const labelParts = node.label.split(' - ');
		const sessionName = labelParts.length > 1 ? labelParts[0] : node.label;

		setDetailView({
			processSessionId: node.processSessionId,
			pid: node.pid,
			toolType: node.toolType || 'unknown',
			cwd: node.cwd || '',
			startTime: node.startTime || Date.now(),
			command: node.command,
			args: node.args,
			agentSessionId: node.agentSessionId,
			sessionName,
			processType: node.processType,
			isAutoRun: node.isAutoRun,
			cueRunId: node.cueRunId,
			cueSubscriptionName: node.cueSubscriptionName,
			cueEventType: node.cueEventType,
			cueSessionName: node.cueSessionName,
			tabName: node.tabName,
			childProcesses: node.childProcesses,
			maestroEnvVars: node.maestroEnvVars,
			sshRemoteCommand: node.sshRemoteCommand,
		});
	}, []);

	const { onKeyDown } = useProcessKeyboardNav({
		tree,
		expandedIds: expansion.expandedIds,
		selectedNodeId,
		setSelectedNodeId,
		openProcessDetail,
		toggleNode: expansion.toggleNode,
		refresh: data.refresh,
	});

	// Escape: close detail view when open, otherwise close the modal. When a
	// KillConfirmDialog is mounted it registers a higher-priority layer
	// (MODAL_PRIORITIES.CONFIRM = 1000 > PROCESS_MONITOR = 550) so the dialog
	// wins Escape automatically — no killConfirm guard needed here.
	useModalLayer(MODAL_PRIORITIES.PROCESS_MONITOR, 'System Processes', () => {
		if (detailView) {
			setDetailView(null);
		} else {
			onClose();
		}
	});

	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	// Restore focus to the container when returning from detail view.
	useEffect(() => {
		if (!detailView) {
			containerRef.current?.focus();
		}
	}, [detailView]);

	const handleRequestKill = useCallback((processSessionId: string, cueRunId?: string) => {
		setKillConfirm({ processSessionId, cueRunId });
	}, []);

	const totalActiveProcesses = data.activeProcesses.length;
	const resizableModal = useResizableModal({
		resizeKey: 'process-monitor',
		defaultSize: { width: 960, height: 680 },
		minSize: { width: 700, height: 420 },
		externalRef: containerRef,
	});

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
			onClick={onClose}
		>
			<div
				ref={containerRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label={detailView ? 'Process Details' : 'System Processes'}
				className="relative rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none select-none"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={detailView ? undefined : onKeyDown}
				data-modal-resize-key="process-monitor"
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
				/>

				{detailView ? (
					<ProcessDetailView
						theme={theme}
						detail={detailView}
						accountName={(() => {
							if (!virtuososEnabled) return undefined;
							const sess = sessions.find((s) => s.id === detailView.agentSessionId);
							return sess?.accountId ? (sess.accountName ?? sess.accountId) : undefined;
						})()}
						onBack={() => setDetailView(null)}
						onClose={onClose}
					/>
				) : (
					<>
						{/* Header */}
						<div
							className="px-6 py-4 border-b flex items-center justify-between"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-3">
								<Activity className="w-5 h-5" style={{ color: theme.colors.accent }} />
								<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
									System Processes
								</h2>
								{totalActiveProcesses > 0 && (
									<span
										className="text-xs px-2 py-1 rounded-full"
										style={{
											backgroundColor: `${theme.colors.success}20`,
											color: theme.colors.success,
										}}
									>
										{totalActiveProcesses} active
									</span>
								)}
							</div>
							<div className="flex items-center gap-1">
								<button
									onClick={() => data.refresh()}
									className="p-1.5 rounded hover:bg-opacity-10 flex items-center gap-1"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
									title="Refresh (R)"
								>
									<RefreshCw className={`w-4 h-4 ${data.isRefreshing ? 'animate-spin' : ''}`} />
								</button>
								<button
									onClick={expansion.expandStep}
									className="p-1.5 rounded hover:bg-opacity-10"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
									title="Expand one level"
								>
									<div className="flex flex-col items-center -space-y-1.5">
										<ChevronUp className="w-4 h-4" />
										<ChevronDown className="w-4 h-4" />
									</div>
								</button>
								<button
									onClick={expansion.collapseStep}
									className="p-1.5 rounded hover:bg-opacity-10"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
									title="Collapse one level"
								>
									<div className="flex flex-col items-center -space-y-1.5">
										<ChevronDown className="w-4 h-4" />
										<ChevronUp className="w-4 h-4" />
									</div>
								</button>
								<button
									onClick={onClose}
									className="p-1.5 rounded hover:bg-opacity-10"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
									title="Close (Esc)"
								>
									<X className="w-4 h-4" />
								</button>
							</div>
						</div>

						{/* Process tree */}
						<div className="overflow-y-auto flex-1 scrollbar-thin">
							<ProcessListView
								theme={theme}
								sessions={sessions}
								tree={tree}
								isLoading={data.isLoading}
								selectedNodeId={selectedNodeId}
								expandedIds={expansion.expandedIds}
								onSelectNode={setSelectedNodeId}
								onToggleNode={expansion.toggleNode}
								onOpenDetail={openProcessDetail}
								onRequestKill={handleRequestKill}
								onCloseModal={onClose}
								onNavigateToSession={onNavigateToSession}
								onNavigateToGroupChat={onNavigateToGroupChat}
							/>
						</div>

						{/* Footer */}
						<div
							className="px-6 py-3 border-t flex items-center gap-4 text-xs"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textDim,
							}}
						>
							<span className="whitespace-nowrap">
								{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} • {groups.length}{' '}
								{groups.length === 1 ? 'group' : 'groups'}
							</span>
							<span className="whitespace-nowrap" style={{ opacity: 0.7 }}>
								↑↓ navigate • Enter view details • R refresh
							</span>
						</div>
					</>
				)}
			</div>

			{killConfirm && (
				<KillConfirmDialog
					theme={theme}
					isKilling={kill.isKilling}
					onConfirm={() => kill.kill(killConfirm.processSessionId, killConfirm.cueRunId)}
					onCancel={() => setKillConfirm(null)}
				/>
			)}
		</div>
	);
}
