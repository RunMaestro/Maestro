/**
 * CueModal — Main modal for Maestro Cue dashboard and pipeline editor.
 *
 * Thin shell: tab switching, master toggle, help overlay, layer stack,
 * unsaved changes confirmation. Sub-components handle dashboard sections.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
	X,
	Zap,
	HelpCircle,
	LayoutDashboard,
	GitFork,
	ArrowLeft,
	AlertTriangle,
} from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useCue } from '../../hooks/useCue';
import type { CueSessionStatus } from '../../hooks/useCue';
import { CueHelpContent } from '../CueHelpModal';
import { CuePipelineEditor } from '../CuePipelineEditor';
import { useSessionStore } from '../../stores/sessionStore';
import { getModalActions } from '../../stores/modalStore';
import { CUE_COLOR, type CueGraphSession } from '../../../shared/cue-pipeline-types';
import { graphSessionsToPipelines } from '../CuePipelineEditor/utils/yamlToPipeline';
import { SessionsTable } from './SessionsTable';
import { ActiveRunsList } from './ActiveRunsList';
import { ActivityLog } from './ActivityLog';
import { buildSubscriptionPipelineMap } from './cueModalUtils';

type CueModalTab = 'dashboard' | 'pipeline';

export interface CueModalProps {
	theme: Theme;
	onClose: () => void;
	cueShortcutKeys?: string[];
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
		error,
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
	const [toggling, setToggling] = useState(false);

	const handleToggle = useCallback(async () => {
		if (toggling) return;
		setToggling(true);
		try {
			if (isEnabled) {
				await disable();
			} else {
				await enable();
			}
		} finally {
			setToggling(false);
		}
	}, [isEnabled, enable, disable, toggling]);

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

	// Graph data fetch error state
	const [graphError, setGraphError] = useState<string | null>(null);

	// Fetch graph data on mount and when tab changes (needed for both dashboard and pipeline tabs)
	useEffect(() => {
		let cancelled = false;
		setGraphError(null);
		window.maestro.cue
			.getGraphData()
			.then((data: CueGraphSession[]) => {
				if (!cancelled) setGraphSessions(data);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setGraphError(err instanceof Error ? err.message : 'Failed to load graph data');
				}
			});
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

	const handleEditYaml = useCallback((session: CueSessionStatus) => {
		getModalActions().openCueYamlEditor(session.sessionId, session.projectRoot);
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
										<Zap className="w-5 h-5" style={{ color: CUE_COLOR }} />
										<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
											Maestro Cue Guide
										</h2>
									</>
								) : (
									<>
										<Zap className="w-5 h-5" style={{ color: CUE_COLOR }} />
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
											disabled={toggling}
											className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
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
													onClick={refresh}
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
															backgroundColor: CUE_COLOR,
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
								onTriggerPipeline={triggerSubscription}
							/>
						)}
					</div>
				</div>,
				document.body
			)}
		</>
	);
}
