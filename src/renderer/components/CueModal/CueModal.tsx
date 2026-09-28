/**
 * CueModal - Main modal for Maestro Cue dashboard and pipeline editor.
 *
 * Thin shell: layer stack, tab switching, help overlay, unsaved changes
 * confirmation. Delegates:
 *   - Graph data fetch + refresh → useCueGraphData
 *   - Master toggle state + handler → useCueToggle
 *   - Header chrome → CueModalHeader
 *   - Dashboard sections → CueDashboard
 *   - Pipeline tab → CuePipelineEditor (with Fix #3 save-refresh wiring)
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useCue } from '../../hooks/useCue';
import type { CueSessionStatus } from '../../hooks/useCue';
import { CueHelpModal } from '../CueHelpModal';
import { CuePipelineEditor } from '../CuePipelineEditor';
import type { CueGraphTarget } from '../CuePipelineEditor/CuePipelineEditor';
import { pipelinesForSession } from '../CuePipelineEditor/utils/pipelineMembership';
import { generateId } from '../../utils/ids';
import { useSessionStore } from '../../stores/sessionStore';
import { getModalActions, useModalStore, selectModalData } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { captureException } from '../../utils/sentry';
import { cueService } from '../../services/cue';
import { useCueDirtyStore } from '../../stores/cueDirtyStore';
import { useCueGraphData } from '../../hooks/cue/useCueGraphData';
import { useCueToggle } from '../../hooks/cue/useCueToggle';
import { CueModalHeader, type CueModalTab } from './CueModalHeader';
import { CueDashboard } from './CueDashboard';
import { ActivityLog } from './ActivityLog';
import { PipelineListTab } from './PipelineListTab';
import { ScheduledTasksTab } from './ScheduledTasksTab';
import { BackupTab } from './BackupTab';
import { ResizeHandles } from '../ui/ResizeHandles';

// In-memory only - last tab the user was on. Reopening the modal lands here
// instead of snapping back to Dashboard, matching how the Settings modal
// behaves. Resets on app restart by design, and an explicit `initialTab`
// (a deep link, `maestro-cli open cue --tab ...`) always wins over it.
let lastOpenCueTab: CueModalTab | null = null;

/** Test-only: clear the remembered tab so suites that assume a fresh open
 *  aren't polluted by a prior test in the same file. */
export function __resetLastOpenCueTabForTests(): void {
	lastOpenCueTab = null;
}

export interface CueModalProps {
	theme: Theme;
	onClose: () => void;
	cueShortcutKeys?: string[];
}

export function CueModal({ theme, onClose, cueShortcutKeys }: CueModalProps) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const {
		sessions,
		activeRuns,
		activityLog,
		queueStatus,
		eventCount,
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

	// Agents that can own a scheduled task. Terminal agents are excluded: they
	// have no AI turn to send a prompt into.
	const activeSessionId = useSessionStore((state) => state.activeSessionId);
	const scheduledTaskAgents = useMemo(
		() =>
			allSessions.filter((s) => s.toolType !== 'terminal').map((s) => ({ id: s.id, name: s.name })),
		[allSessions]
	);

	const handleSwitchToSession = useCallback(
		(id: string) => {
			setActiveSessionId(id);
			onClose();
		},
		[setActiveSessionId, onClose]
	);

	const isEnabled = sessions.some((s) => s.enabled);
	const { toggling, handleToggle } = useCueToggle({ isEnabled, enable, disable });

	// Help modal state
	const [showHelp, setShowHelp] = useState(false);
	const showHelpRef = useRef(false);
	showHelpRef.current = showHelp;

	// Activity Log search state - lifted here so the modal layer escape handler
	// can clear it before the layer stack closes the modal.
	const [activitySearchQuery, setActivitySearchQuery] = useState('');
	const activitySearchInputRef = useRef<HTMLInputElement>(null);
	const activitySearchQueryRef = useRef(activitySearchQuery);
	activitySearchQueryRef.current = activitySearchQuery;

	useModalLayer(MODAL_PRIORITIES.CUE_MODAL, undefined, () => {
		// The help guide registers its own layer above this one (CUE_HELP), so
		// Escape while the guide is open is handled there - it never reaches here.
		// If Activity Log search is focused with text, clear it instead of closing.
		// First Escape clears, second Escape (now with empty input) closes the modal.
		if (
			document.activeElement === activitySearchInputRef.current &&
			activitySearchQueryRef.current.length > 0
		) {
			setActivitySearchQuery('');
			return;
		}
		// Skip the dirty-changes confirmation when a save is already in flight -
		// the save promise lives in the persistence hook and continues running
		// after CueModal unmounts (it toasts success/failure when it lands).
		// Forcing the user to wait or discard would defeat the whole point of
		// being able to close mid-save.
		const cueDirtyState = useCueDirtyStore.getState();
		if (cueDirtyState.pipelineDirty && !cueDirtyState.pipelineSaving) {
			getModalActions().showConfirmation(
				'You have unsaved changes in the pipeline editor. Discard and close?',
				() => onCloseRef.current()
			);
			return;
		}
		onCloseRef.current();
	});

	// Read initial tab from modal data (e.g., when navigating from YAML editor)
	// Resolved once in the lazy initializer rather than via a restore effect:
	// under StrictMode a restore-via-effect double-fires and clobbers the
	// remembered value with the default before it lands.
	const cueModalData = useModalStore(selectModalData('cueModal'));
	const [activeTab, setActiveTab] = useState<CueModalTab>(
		() => cueModalData?.initialTab ?? lastOpenCueTab ?? 'dashboard'
	);

	// Remember the tab for the next open.
	useEffect(() => {
		lastOpenCueTab = activeTab;
	}, [activeTab]);

	// Graph data (owned by hook: fetch on mount + tab change, cancellation race guard, refreshGraphData)
	const {
		graphSessions,
		graphError,
		initialLoading: graphInitialLoading,
		dashboardPipelines,
		subscriptionPipelineMap,
		refreshGraphData,
	} = useCueGraphData({ activeTab, sessionInfoList });

	// Reset pipeline dirty state when the modal unmounts
	useEffect(() => {
		return () => {
			useCueDirtyStore.getState().resetAll();
		};
	}, []);

	const handleEditYaml = useCallback((session: CueSessionStatus) => {
		getModalActions().openCueYamlEditor(session.sessionId, session.projectRoot);
	}, []);

	const [pendingGraphTarget, setPendingGraphTarget] = useState<CueGraphTarget | null>(null);

	// Jump to the graph tab with a specific pipeline pre-selected. The nonce is
	// what lets the editor re-apply the same target on a repeat click.
	const handleViewInGraph = useCallback((pipelineId: string | null) => {
		setPendingGraphTarget({ id: pipelineId, nonce: generateId() });
		setActiveTab('pipeline');
	}, []);

	const handleViewInGraphFromSession = useCallback(
		(session: CueSessionStatus) => {
			// Resolve by session membership, not by color: several pipelines can
			// share a color, and a command-only pipeline has no agent node to
			// match at all. `pipelinesForSession` covers both, plus pipelines the
			// agent declares in its cue.yaml without appearing in.
			const owned = pipelinesForSession(session.sessionId, dashboardPipelines, graphSessions);
			if (owned.length === 1) {
				handleViewInGraph(owned[0].id);
				return;
			}
			// More than one: stay in the All Pipelines view but scope it to this
			// agent's pipelines, so the user sees their fleet instead of everyone's.
			// Zero: no scope to apply - fall through to the unfiltered view.
			setPendingGraphTarget({
				id: null,
				nonce: generateId(),
				scope:
					owned.length > 1
						? {
								sessionId: session.sessionId,
								sessionName: session.sessionName,
								pipelineIds: owned.map((p) => p.id),
							}
						: undefined,
			});
			setActiveTab('pipeline');
		},
		[dashboardPipelines, graphSessions, handleViewInGraph]
	);

	const handleRemoveCue = useCallback(
		(session: CueSessionStatus) => {
			getModalActions().showConfirmation(
				`Remove Cue configuration for "${session.sessionName}"?\n\nThis will delete the cue.yaml file from this project. This cannot be undone.`,
				async () => {
					try {
						await cueService.deleteYaml(session.projectRoot);
					} catch (err) {
						captureException(err, {
							extra: { context: 'handleRemoveCue', projectRoot: session.projectRoot },
						});
						notifyToast({
							title: 'Failed to remove Cue configuration',
							message: 'Could not delete cue.yaml. Check file permissions.',
							type: 'error',
						});
						return;
					}
					try {
						await refresh();
					} catch (err) {
						captureException(err, {
							extra: { context: 'handleRemoveCue', projectRoot: session.projectRoot },
						});
						notifyToast({
							title: 'Failed to refresh project',
							message: 'Cue configuration was removed but the view could not be refreshed.',
							type: 'error',
						});
					}
				}
			);
		},
		[refresh]
	);

	// Close with unsaved changes confirmation. A save in flight bypasses the
	// confirmation (see escape handler above for the rationale).
	const handleCloseWithConfirm = useCallback(() => {
		const cueDirtyState = useCueDirtyStore.getState();
		if (cueDirtyState.pipelineDirty && !cueDirtyState.pipelineSaving) {
			getModalActions().showConfirmation(
				'You have unsaved changes in the pipeline editor. Discard and close?',
				() => onClose()
			);
			return;
		}
		onClose();
	}, [onClose]);

	// Active runs section is collapsible when empty
	const [activeRunsExpanded, setActiveRunsExpanded] = useState(true);

	// Wrap tab switching so navigating away from the pipeline tab clears the
	// pending selection token - prevents a stale nonce from re-snapping the editor
	// to the "View in Graph" target on the next remount.
	const handleSetActiveTab = useCallback((tab: CueModalTab) => {
		if (tab !== 'pipeline') setPendingGraphTarget(null);
		setActiveTab(tab);
	}, []);

	// Cmd/Ctrl+Shift+[/] cycles between tabs. Disabled while help is open
	// so the help view's keyboard handlers stay in charge.
	const tabsRef = useRef<readonly CueModalTab[]>([
		'dashboard',
		'scheduled',
		'pipeline',
		'pipeline-list',
		'activity',
		'backup',
	]);
	useEffect(() => {
		const handleTabCycle = (e: KeyboardEvent) => {
			if (showHelpRef.current) return;
			if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
			if (e.key !== '[' && e.key !== ']') return;
			e.preventDefault();
			const tabs = tabsRef.current;
			const currentIndex = tabs.indexOf(activeTab);
			const delta = e.key === '[' ? -1 : 1;
			const newIndex = (currentIndex + delta + tabs.length) % tabs.length;
			handleSetActiveTab(tabs[newIndex]);
		};
		window.addEventListener('keydown', handleTabCycle);
		return () => window.removeEventListener('keydown', handleTabCycle);
	}, [activeTab, handleSetActiveTab]);

	const handleOpenHelp = useCallback(() => setShowHelp(true), []);
	const handleCloseHelp = useCallback(() => setShowHelp(false), []);

	// Retry re-fetches both streams so a transient graph-fetch failure and a
	// main Cue status failure both clear on one click.
	const handleRetry = useCallback(() => {
		refresh();
		refreshGraphData();
	}, [refresh, refreshGraphData]);
	const resizableModal = useResizableModal({
		resizeKey: 'cue',
		defaultSize: { width: 1200, height: 760 },
		minSize: { width: 760, height: 520 },
	});

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
						ref={resizableModal.modalRef}
						role="dialog"
						aria-modal="true"
						aria-label="Maestro Cue"
						className="relative rounded-xl shadow-2xl flex flex-col select-none"
						style={{
							...resizableModal.style,
							backgroundColor: theme.colors.bgMain,
							border: `1px solid ${theme.colors.border}`,
						}}
						data-modal-resize-key="cue"
					>
						<ResizeHandles
							onResizeStart={resizableModal.onResizeStart}
							accentColor={theme.colors.accent}
							onResetSize={resizableModal.onResetSize}
							canReset={resizableModal.canReset}
						/>

						<CueModalHeader
							theme={theme}
							activeTab={activeTab}
							setActiveTab={handleSetActiveTab}
							isEnabled={isEnabled}
							toggling={toggling}
							handleToggle={handleToggle}
							onOpenHelp={handleOpenHelp}
							onClose={handleCloseWithConfirm}
						/>

						{/* Body */}
						{activeTab === 'dashboard' ? (
							<div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
								<CueDashboard
									theme={theme}
									loading={loading}
									error={error}
									graphError={graphError}
									onRetry={handleRetry}
									sessions={sessions}
									activeRuns={activeRuns}
									activityLog={activityLog}
									queueStatus={queueStatus}
									graphSessions={graphSessions}
									dashboardPipelines={dashboardPipelines}
									subscriptionPipelineMap={subscriptionPipelineMap}
									executionCount={eventCount}
									activeRunsExpanded={activeRunsExpanded}
									setActiveRunsExpanded={setActiveRunsExpanded}
									onViewInGraph={handleViewInGraphFromSession}
									onEditYaml={handleEditYaml}
									onRemoveCue={handleRemoveCue}
									onTriggerSubscription={triggerSubscription}
									onStopRun={stopRun}
									onStopAll={stopAll}
									focusSessionId={cueModalData?.focusSessionId}
								/>
							</div>
						) : activeTab === 'scheduled' ? (
							<ScheduledTasksTab
								theme={theme}
								active
								agents={scheduledTaskAgents}
								defaultAgentId={activeSessionId ?? undefined}
							/>
						) : activeTab === 'pipeline-list' ? (
							<PipelineListTab
								theme={theme}
								pipelines={dashboardPipelines}
								graphSessions={graphSessions}
								activeRuns={activeRuns}
								activityLog={activityLog}
								loading={loading || graphInitialLoading}
								error={error || graphError}
								onRetry={handleRetry}
								onViewInGraph={handleViewInGraph}
								onTriggerSubscription={triggerSubscription}
								onRenamed={handleRetry}
							/>
						) : activeTab === 'activity' ? (
							<div className="flex-1 min-h-0 px-5 py-4 select-text">
								<ActivityLog
									log={activityLog}
									theme={theme}
									subscriptionPipelineMap={subscriptionPipelineMap}
									searchQuery={activitySearchQuery}
									setSearchQuery={setActivitySearchQuery}
									searchInputRef={activitySearchInputRef}
								/>
							</div>
						) : activeTab === 'backup' ? (
							<div className="flex-1 min-h-0 flex flex-col">
								<BackupTab theme={theme} />
							</div>
						) : (
							<CuePipelineEditor
								sessions={sessionInfoList}
								groups={groups}
								graphSessions={graphSessions}
								onSwitchToSession={handleSwitchToSession}
								onClose={onClose}
								theme={theme}
								activeRuns={activeRuns}
								onTriggerPipeline={triggerSubscription}
								onSaveSuccess={refreshGraphData}
								initialGraphTarget={pendingGraphTarget ?? undefined}
								graphLoading={graphInitialLoading}
							/>
						)}
					</div>
				</div>,
				document.body
			)}

			{showHelp && (
				<CueHelpModal theme={theme} onClose={handleCloseHelp} cueShortcutKeys={cueShortcutKeys} />
			)}
		</>
	);
}
