/**
 * CuePipelineEditor — React Flow-based visual pipeline editor for Maestro Cue.
 *
 * Thin shell that composes domain hooks:
 *   - usePipelineSelection       → selection state (owns selected*Id + setters)
 *   - usePipelineState           → pipeline data + CRUD + mutations + save/discard
 *   - usePipelineViewport        → stableYOffsets + initial/selection-change fit
 *   - usePipelineCanvasCallbacks → ReactFlow drag/connect/drop callbacks
 *   - usePipelineKeyboard        → Delete/Escape/Cmd+S shortcuts
 *   - usePipelineContextMenu     → right-click Configure/Delete/Duplicate
 *
 * The historical `useSelectionRef` bridge was removed in Phase 10: selection
 * IDs flow cleanly as params from usePipelineSelection → usePipelineState.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider, useReactFlow, type Node, type Edge } from 'reactflow';
import type { Theme } from '../../types';
import type { CueGraphSession } from '../../../shared/cue-pipeline-types';
import { convertToReactFlowNodes, convertToReactFlowEdges } from './utils/pipelineGraph';
import { usePipelineState } from '../../hooks/cue/usePipelineState';
import type { SessionInfo, ActiveRunInfo } from '../../hooks/cue/usePipelineState';
import { usePipelineSelection } from '../../hooks/cue/usePipelineSelection';
import { usePipelineViewport } from '../../hooks/cue/usePipelineViewport';
import { usePipelineCanvasCallbacks } from '../../hooks/cue/usePipelineCanvasCallbacks';
import { usePipelineKeyboard } from '../../hooks/cue/usePipelineKeyboard';
import { usePipelineContextMenu } from '../../hooks/cue/usePipelineContextMenu';
import { PipelineToolbar } from './PipelineToolbar';
import { PipelineCanvas } from './PipelineCanvas';
import { PipelineContextMenu } from './PipelineContextMenu';

export { validatePipelines, DEFAULT_TRIGGER_LABELS } from '../../hooks/cue/usePipelineState';
export type { SessionInfo, ActiveRunInfo } from '../../hooks/cue/usePipelineState';

export interface CuePipelineEditorProps {
	sessions: SessionInfo[];
	groups?: { id: string; name: string; emoji: string }[];
	graphSessions: CueGraphSession[];
	onSwitchToSession: (id: string) => void;
	onClose: () => void;
	theme: Theme;
	activeRuns?: ActiveRunInfo[];
	/** Callback to manually trigger a pipeline by name */
	onTriggerPipeline?: (pipelineName: string) => void;
	/** Callback fired after a successful save. Used by CueModal to refresh
	 *  dashboard graph data so saved state is visible immediately (Fix #3). */
	onSaveSuccess?: () => void;
	/** Pre-select a specific pipeline when navigating from "View in Pipeline".
	 *  Nonce ensures repeated clicks on the same pipeline re-trigger selection. */
	initialPipelineId?: { id: string | null; nonce: string };
	/** True while the initial graph-data fetch is in flight. Combined with the
	 *  hook's own pipeline-restore state to render a loading spinner instead of
	 *  flashing the "Create your first pipeline" CTA before pipelines arrive. */
	graphLoading?: boolean;
}

function CuePipelineEditorInner({
	sessions,
	groups,
	graphSessions,
	onSwitchToSession,
	theme,
	activeRuns: activeRunsProp,
	onTriggerPipeline,
	onSaveSuccess,
	initialPipelineId,
	graphLoading = false,
}: CuePipelineEditorProps) {
	const reactFlowInstance = useReactFlow();

	// Local drawer state — consumed by multiple hooks and children
	const [triggerDrawerOpen, setTriggerDrawerOpen] = useState(false);
	const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);

	// Selection bridge: usePipelineState needs selection IDs for its mutation
	// callbacks, but usePipelineSelection needs pipelineState. We resolve the
	// circular dep via a stable ref that's mutated in the render body AFTER
	// both hooks have returned. The ref object identity is stable across
	// renders, so usePipelineState's memoized callbacks can read
	// `selectionRef.current.xxx` without contributing to their dep arrays.
	//
	// Note: on the FIRST render, selectionRef.current holds placeholder nulls;
	// stateHook's mutation callbacks close over them, but since nothing can
	// invoke a mutation before the first render's JSX has mounted, this is
	// safe. Every subsequent render sees the latest selection IDs via the ref.
	const selectionRef = useRef<{
		selectedNodePipelineId: string | null;
		selectedEdgePipelineId: string | null;
		setSelectedNodeId: (id: string | null) => void;
		setSelectedEdgeId: (id: string | null) => void;
	}>({
		selectedNodePipelineId: null,
		selectedEdgePipelineId: null,
		setSelectedNodeId: () => {},
		setSelectedEdgeId: () => {},
	});

	// Stable adapter setters that always call the current selection hook's setters.
	// These are useCallback with EMPTY deps, so usePipelineState's memoized
	// callbacks that capture them stay stable across selection changes.
	const setSelectedNodeIdStable = useCallback((id: string | null) => {
		selectionRef.current.setSelectedNodeId(id);
	}, []);
	const setSelectedEdgeIdStable = useCallback((id: string | null) => {
		selectionRef.current.setSelectedEdgeId(id);
	}, []);

	const stateHook = usePipelineState({
		sessions,
		graphSessions,
		activeRuns: activeRunsProp,
		reactFlowInstance,
		selectedNodePipelineId: selectionRef.current.selectedNodePipelineId,
		selectedEdgePipelineId: selectionRef.current.selectedEdgePipelineId,
		setSelectedNodeId: setSelectedNodeIdStable,
		setSelectedEdgeId: setSelectedEdgeIdStable,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
		onSaveSuccess,
	});

	const selectionHook = usePipelineSelection({
		pipelineState: stateHook.pipelineState,
	});

	// When opened via "View in Pipeline", pre-select the resolved pipeline once
	// the pipeline list has loaded. appliedNonce prevents pipelines.length changes
	// (e.g. a pipeline being added) from overriding a subsequent user selection.
	const appliedNonce = useRef<string | null>(null);
	useEffect(() => {
		const nonce = initialPipelineId?.nonce;
		if (!nonce || stateHook.pipelineState.pipelines.length === 0) return;
		if (nonce === appliedNonce.current) return;
		appliedNonce.current = nonce;
		stateHook.selectPipeline(initialPipelineId!.id);
	}, [initialPipelineId?.nonce, stateHook.pipelineState.pipelines.length]);

	// Update ref in render body so next render (and any post-render callback
	// invocation) reads the latest selection values.
	selectionRef.current = {
		selectedNodePipelineId: selectionHook.selectedNodePipelineId,
		selectedEdgePipelineId: selectionHook.selectedEdgePipelineId,
		setSelectedNodeId: selectionHook.setSelectedNodeId,
		setSelectedEdgeId: selectionHook.setSelectedEdgeId,
	};

	const {
		pipelineState,
		setPipelineState,
		isAllPipelinesView,
		isDirty,
		setIsDirty,
		saveStatus,
		validationErrors,
		cueSettings,
		setCueSettings,
		showSettings,
		setShowSettings,
		runningPipelineIds,
		runningAgentsByPipeline,
		runningSubscriptionsByPipeline,
		persistLayout,
		pendingSavedViewportRef,
		pipelinesLoaded,
		handleSave,
		handleDiscard,
		createPipeline,
		deletePipeline,
		renamePipeline,
		selectPipeline,
		changePipelineColor,
		onUpdateNode,
		onUpdateEdgePrompt,
		onDeleteNode,
		onUpdateEdge,
		onDeleteEdge,
	} = stateHook;

	const {
		selectedNodeId,
		setSelectedNodeId,
		selectedEdgeId,
		setSelectedEdgeId,
		selectedNode,
		selectedNodePipelineId,
		selectedNodeHasOutgoingEdge,
		hasIncomingAgentEdges,
		incomingAgentEdgeCount,
		incomingAgentEdges,
		incomingTriggerEdges,
		selectedEdge,
		selectedEdgePipelineId,
		selectedEdgePipelineColor,
		edgeSourceNode,
		edgeTargetNode,
		onCanvasSessionIds,
		onNodeClick,
		onEdgeClick,
		onPaneClick,
		handleConfigureNode,
	} = selectionHook;

	// The per-node "Configure" icon calls this directly via node data, bypassing
	// onNodeClick. In All Pipelines view everything is read-only, so we refuse
	// to open the edit panel. Declared here (before computedNodes) so the memo
	// embeds the stable guarded callback.
	const handleConfigureNodeGuarded = useCallback(
		(compositeId: string) => {
			if (isAllPipelinesView) return;
			handleConfigureNode(compositeId);
		},
		[isAllPipelinesView, handleConfigureNode]
	);

	// ─── Viewport (stableYOffsets, initial fit, re-fit on selection change) ─
	// Must be called BEFORE computedNodes (which depends on stableYOffsets).
	// usePipelineViewport does not need computedNodes — it only needs the count
	// for the fitView gating — so the computedNodeCount is known from
	// pipelineState alone (sum of nodes across visible pipelines).
	const totalNodeCount = useMemo(() => {
		if (pipelineState.selectedPipelineId === null) {
			return pipelineState.pipelines.reduce((acc, p) => acc + p.nodes.length, 0);
		}
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineState.selectedPipelineId);
		return pipeline?.nodes.length ?? 0;
	}, [pipelineState.pipelines, pipelineState.selectedPipelineId]);

	const { stableYOffsets, stableYOffsetsRef } = usePipelineViewport({
		pipelineState,
		computedNodeCount: totalNodeCount,
		pendingSavedViewportRef,
		reactFlowInstance,
	});

	// ─── ReactFlow nodes/edges ──────────────────────────────────────────────

	// Compute canonical nodes from pipeline state.
	const computedNodes = useMemo(
		() =>
			convertToReactFlowNodes(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				handleConfigureNodeGuarded,
				{
					onTriggerPipeline,
					isSaved: !isDirty,
					runningPipelineIds,
					runningSubscriptionsByPipeline,
				},
				theme,
				stableYOffsets
			),
		[
			pipelineState.pipelines,
			pipelineState.selectedPipelineId,
			handleConfigureNodeGuarded,
			onTriggerPipeline,
			isDirty,
			runningPipelineIds,
			runningSubscriptionsByPipeline,
			theme,
			stableYOffsets,
		]
	);

	// Local display nodes that ReactFlow controls directly. During drag,
	// applyNodeChanges updates this state (cheap setState, no useMemo recompute).
	// On drag end, positions sync back to pipelineState.
	const [displayNodes, setDisplayNodes] = useState<Node[]>(computedNodes);
	useEffect(() => {
		setDisplayNodes(computedNodes);
	}, [computedNodes]);

	const nodes = displayNodes;

	const edges = useMemo(
		() =>
			convertToReactFlowEdges(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				selectedEdgeId,
				theme,
				runningAgentsByPipeline
			),
		[
			pipelineState.pipelines,
			pipelineState.selectedPipelineId,
			runningAgentsByPipeline,
			selectedEdgeId,
			theme,
		]
	);

	// ─── Canvas callbacks ──────────────────────────────────────────────────
	const canvasCallbacks = usePipelineCanvasCallbacks({
		state: { pipelineState, isAllPipelinesView },
		refs: { stableYOffsetsRef },
		display: { nodes, edges, setDisplayNodes },
		actions: { setPipelineState, persistLayout },
		selection: { setSelectedNodeId, setSelectedEdgeId },
		reactFlowInstance,
	});

	// ─── Keyboard shortcuts ────────────────────────────────────────────────
	usePipelineKeyboard({
		isAllPipelinesView,
		selectedNode,
		selectedNodePipelineId,
		selectedEdge,
		selectedEdgePipelineId,
		selectedNodeId,
		selectedEdgeId,
		triggerDrawerOpen,
		agentDrawerOpen,
		onDeleteNode,
		onDeleteEdge,
		setSelectedNodeId,
		setSelectedEdgeId,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
		handleSave,
	});

	// ─── Context menu ──────────────────────────────────────────────────────
	const {
		contextMenu,
		setContextMenu,
		onNodeContextMenu,
		handleContextMenuConfigure,
		handleContextMenuDelete,
		handleContextMenuDuplicate,
	} = usePipelineContextMenu({
		isAllPipelinesView,
		setPipelineState,
		setSelectedNodeId,
		setSelectedEdgeId,
	});

	// ─── Read-only click wrappers for All Pipelines view ───────────────────
	// Clicking a node/edge normally sets selection, which opens the node or
	// edge config panel with editable fields. In All Pipelines view nothing
	// is editable, so short-circuit selection at the source. Any pre-existing
	// selection from before the view switch is additionally guarded at panel
	// render time in PipelineCanvas.
	const onNodeClickGuarded = useCallback(
		(event: React.MouseEvent, node: Node) => {
			if (isAllPipelinesView) return;
			onNodeClick(event, node);
		},
		[isAllPipelinesView, onNodeClick]
	);
	const onEdgeClickGuarded = useCallback(
		(event: React.MouseEvent, edge: Edge) => {
			if (isAllPipelinesView) return;
			onEdgeClick(event, edge);
		},
		[isAllPipelinesView, onEdgeClick]
	);

	// ─── Render ──────────────────────────────────────────────────────────────

	return (
		<div className="flex-1 flex flex-col" style={{ width: '100%', height: '100%' }}>
			<PipelineToolbar
				theme={theme}
				isAllPipelinesView={isAllPipelinesView}
				triggerDrawerOpen={triggerDrawerOpen}
				setTriggerDrawerOpen={setTriggerDrawerOpen}
				agentDrawerOpen={agentDrawerOpen}
				setAgentDrawerOpen={setAgentDrawerOpen}
				showSettings={showSettings}
				setShowSettings={setShowSettings}
				pipelines={pipelineState.pipelines}
				selectedPipelineId={pipelineState.selectedPipelineId}
				selectPipeline={selectPipeline}
				createPipeline={createPipeline}
				deletePipeline={deletePipeline}
				renamePipeline={renamePipeline}
				changePipelineColor={changePipelineColor}
				isDirty={isDirty}
				saveStatus={saveStatus}
				handleSave={handleSave}
				handleDiscard={handleDiscard}
				validationErrors={validationErrors}
			/>

			<PipelineCanvas
				theme={theme}
				nodes={nodes}
				edges={edges}
				isReadOnly={isAllPipelinesView}
				onNodesChange={canvasCallbacks.onNodesChange}
				onEdgesChange={canvasCallbacks.onEdgesChange}
				onConnect={canvasCallbacks.onConnect}
				isValidConnection={canvasCallbacks.isValidConnection}
				onNodeClick={onNodeClickGuarded}
				onEdgeClick={onEdgeClickGuarded}
				onPaneClick={onPaneClick}
				onNodeContextMenu={onNodeContextMenu}
				onNodeDragStop={canvasCallbacks.onNodeDragStop}
				onDragOver={canvasCallbacks.onDragOver}
				onDrop={canvasCallbacks.onDrop}
				triggerDrawerOpen={triggerDrawerOpen}
				setTriggerDrawerOpen={setTriggerDrawerOpen}
				agentDrawerOpen={agentDrawerOpen}
				setAgentDrawerOpen={setAgentDrawerOpen}
				sessions={sessions}
				groups={groups}
				onCanvasSessionIds={onCanvasSessionIds}
				pipelineCount={pipelineState.pipelines.length}
				createPipeline={createPipeline}
				selectedPipelineId={pipelineState.selectedPipelineId}
				pipelines={pipelineState.pipelines}
				selectPipeline={selectPipeline}
				showSettings={showSettings}
				cueSettings={cueSettings}
				setCueSettings={setCueSettings}
				setShowSettings={setShowSettings}
				setIsDirty={setIsDirty}
				selectedNode={selectedNode}
				selectedEdge={selectedEdge}
				selectedNodeHasOutgoingEdge={selectedNodeHasOutgoingEdge}
				hasIncomingAgentEdges={hasIncomingAgentEdges}
				incomingAgentEdgeCount={incomingAgentEdgeCount}
				incomingAgentEdges={incomingAgentEdges}
				incomingTriggerEdges={incomingTriggerEdges}
				onUpdateNode={onUpdateNode}
				onUpdateEdgePrompt={onUpdateEdgePrompt}
				onDeleteNode={onDeleteNode}
				onSwitchToSession={onSwitchToSession}
				triggerDrawerOpenForConfig={triggerDrawerOpen}
				agentDrawerOpenForConfig={agentDrawerOpen}
				edgeSourceNode={edgeSourceNode}
				edgeTargetNode={edgeTargetNode}
				selectedEdgePipelineColor={selectedEdgePipelineColor}
				onUpdateEdge={onUpdateEdge}
				onDeleteEdge={onDeleteEdge}
				onTriggerPipeline={onTriggerPipeline}
				isDirty={isDirty}
				runningPipelineIds={runningPipelineIds}
				isLoading={graphLoading || !pipelinesLoaded}
			/>

			{contextMenu && (
				<PipelineContextMenu
					contextMenu={contextMenu}
					theme={theme}
					onConfigure={handleContextMenuConfigure}
					onDelete={handleContextMenuDelete}
					onDuplicate={handleContextMenuDuplicate}
					onDismiss={() => setContextMenu(null)}
				/>
			)}
		</div>
	);
}

export function CuePipelineEditor(props: CuePipelineEditorProps) {
	return (
		<ReactFlowProvider>
			<CuePipelineEditorInner {...props} />
		</ReactFlowProvider>
	);
}
