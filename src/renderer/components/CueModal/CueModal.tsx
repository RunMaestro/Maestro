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
import { BackupTab } from './BackupTab';
import { ResizeHandles } from '../ui/ResizeHandles';

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
	const cueModalData = useModalStore(selectModalData('cueModal'));
	const [activeTab, setActiveTab] = useState<CueModalTab>(cueModalData?.initialTab ?? 'dashboard');

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

	const [pendingPipelineId, setPendingPipelineId] = useState<{
		id: string | null;
		nonce: string;
	} | null>(null);

	const handleViewInPipeline = useCallback(
		(session: CueSessionStatus) => {
			// Find the pipeline by session-membership, not by color. Multiple
			// pipelines can share a color (e.g. two orange pipelines), so the
			// older color-based lookup would jump to whichever orange pipeline
			// appeared first in the array regardless of which agent was clicked.
			const pipeline = dashboardPipelines.find((p) =>
				p.nodes.some(
					(node) =>
						node.type === 'agent' &&
						'sessionId' in node.data &&
						node.data.sessionId === session.sessionId
				)
			);
			setPendingPipelineId({ id: pipeline?.id ?? null, nonce: generateId() });
			setActiveTab('pipeline');
		},
		[dashboardPipelines]
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
	// to the "View in Pipeline" target on the next remount.
	const handleSetActiveTab = useCallback((tab: CueModalTab) => {
		if (tab !== 'pipeline') setPendingPipelineId(null);
		setActiveTab(tab);
	}, []);

	// Cmd/Ctrl+Shift+[/] cycles between tabs. Disabled while help is open
	// so the help view's keyboard handlers stay in charge.
	const tabsRef = useRef<readonly CueModalTab[]>(['dashboard', 'pipeline', 'activity', 'backup']);
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
									onViewInPipeline={handleViewInPipeline}
									onEditYaml={handleEditYaml}
									onRemoveCue={handleRemoveCue}
									onTriggerSubscription={triggerSubscription}
									onStopRun={stopRun}
									onStopAll={stopAll}
								/>
							</div>
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
								initialPipelineId={pendingPipelineId ?? undefined}
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
