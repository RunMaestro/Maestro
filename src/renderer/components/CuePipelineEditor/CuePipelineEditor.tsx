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
import { PipelineCanvas, type CanvasInteractionMode } from './PipelineCanvas';
import { PipelineContextMenu } from './PipelineContextMenu';
import { arrangePipelineNodes, arrangePipelineGroups } from './utils/pipelineAutoArrange';
import { ConfirmModal } from '../ConfirmModal';
import { LayoutGrid } from 'lucide-react';
import type { TriggerNodeData } from '../../../shared/cue-pipeline-types';

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

	// Root element of the editor — used by usePipelineKeyboard to distinguish
	// inputs inside the editor (where typing should pass through) from inputs
	// behind the modal (where the modal must claim the keystroke).
	const containerRef = useRef<HTMLDivElement>(null);

	// Local drawer state — consumed by multiple hooks and children
	const [triggerDrawerOpen, setTriggerDrawerOpen] = useState(false);
	const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);

	// Canvas interaction mode: hand (pan on drag) vs pointer (box-select on drag).
	const [interactionMode, setInteractionMode] = useState<CanvasInteractionMode>('hand');

	// Canvas lock — when true, drag / select / connect are disabled (pan + zoom
	// still work). Lifted here so the L keyboard shortcut can toggle it.
	const [isLocked, setIsLocked] = useState(false);

	// Auto-arrange confirmation gate. The button opens this; confirming runs
	// handleAutoArrange. Kept here (not in PipelineCanvas) so the layout
	// mutation has access to setPipelineState / persistLayout / offsets.
	const [arrangeConfirmOpen, setArrangeConfirmOpen] = useState(false);

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
		saveStatus,
		validationErrors,
		runningPipelineIds,
		runningAgentsByPipeline,
		runningSubscriptionsByPipeline,
		optimisticTriggeredPipelineIds,
		markPipelineTriggered,
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

	// Wrap the manual-trigger handler so the click produces immediate UI feedback:
	// mark the owning pipeline as optimistically triggered so the trigger
	// spinner flips synchronously and every edge in the pipeline animates for
	// a brief window — covers fast shell-only triggers that would otherwise
	// complete before activeRuns polling caught the run. Success/failure toast
	// comes from useCue.triggerSubscription downstream.
	const handleTriggerPipeline = useCallback(
		(subscriptionName: string) => {
			let owningPipelineId: string | null = null;
			for (const pipeline of pipelineState.pipelines) {
				for (const node of pipeline.nodes) {
					if (node.type !== 'trigger') continue;
					const tData = node.data as TriggerNodeData;
					// Trigger nodes carry the EXACT sub name they own (incl. -chain-N).
					// Fall back to pipeline name match for legacy trigger nodes that
					// were never saved (no `subscriptionName` stamped).
					if (tData.subscriptionName === subscriptionName || pipeline.name === subscriptionName) {
						owningPipelineId = pipeline.id;
						break;
					}
				}
				if (owningPipelineId) break;
			}
			if (owningPipelineId) {
				markPipelineTriggered(owningPipelineId, subscriptionName);
			}
			onTriggerPipeline?.(subscriptionName);
		},
		[pipelineState.pipelines, markPipelineTriggered, onTriggerPipeline]
	);

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
					onTriggerPipeline: handleTriggerPipeline,
					isSaved: !isDirty,
					runningPipelineIds,
					runningSubscriptionsByPipeline,
					runningAgentsByPipeline,
				},
				theme,
				stableYOffsets,
				interactionMode === 'hand'
			),
		[
			pipelineState.pipelines,
			pipelineState.selectedPipelineId,
			handleConfigureNodeGuarded,
			handleTriggerPipeline,
			isDirty,
			runningPipelineIds,
			runningSubscriptionsByPipeline,
			runningAgentsByPipeline,
			theme,
			stableYOffsets,
			interactionMode,
		]
	);

	// Local display nodes that ReactFlow controls directly. During drag,
	// applyNodeChanges updates this state (cheap setState, no useMemo recompute).
	// On drag end, positions sync back to pipelineState.
	const [displayNodes, setDisplayNodes] = useState<Node[]>(computedNodes);
	// Tracks the `pipelineState.pipelines` reference that the resync last
	// observed. Used to distinguish "pipelineState actually changed" (drag
	// committed, node added/deleted, discard, mount) from "computedNodes
	// recomputed because a non-positional dep changed" (activeRuns polling
	// produced a fresh `runningPipelineIds` Set, theme change, etc.).
	const lastSyncedPipelinesRef = useRef(pipelineState.pipelines);
	useEffect(() => {
		setDisplayNodes((prev) => {
			// If pipelineState.pipelines is unchanged since the last resync, this
			// fire is poll-driven (or theme/selection/running-state-driven), NOT a
			// real position update. Preserve ReactFlow's live positions on prev so
			// a just-dragged node isn't snapped back when activeRuns polls a few
			// seconds later. Tracking by reference rather than gating on isDirty
			// because the dirty flag flips AFTER its own effect runs and isn't
			// load-bearing for "did the source-of-truth positions change."
			const pipelinesChanged = lastSyncedPipelinesRef.current !== pipelineState.pipelines;
			lastSyncedPipelinesRef.current = pipelineState.pipelines;
			if (pipelinesChanged) return computedNodes;
			const prevById = new Map(prev.map((n) => [n.id, n]));
			return computedNodes.map((cn) => {
				const existing = prevById.get(cn.id);
				if (!existing) return cn;
				return { ...cn, position: existing.position };
			});
		});
	}, [computedNodes, pipelineState.pipelines]);

	const nodes = displayNodes;

	const edges = useMemo(
		() =>
			convertToReactFlowEdges(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				selectedEdgeId,
				theme,
				runningAgentsByPipeline,
				optimisticTriggeredPipelineIds
			),
		[
			pipelineState.pipelines,
			pipelineState.selectedPipelineId,
			runningAgentsByPipeline,
			optimisticTriggeredPipelineIds,
			selectedEdgeId,
			theme,
		]
	);

	// ─── Auto-arrange ──────────────────────────────────────────────────────
	// In All-Pipelines view, pack the group cards into a grid (viewOffset per
	// pipeline). In a single-pipeline view, lay that pipeline's nodes out in
	// flow-depth columns. Either way: mutate canonical state (flips dirty,
	// undoable via Discard), persist like a drag, then re-fit so the result
	// is centered in view.
	const handleAutoArrange = useCallback(() => {
		setPipelineState((prev) => {
			if (prev.selectedPipelineId === null) {
				const offsets = arrangePipelineGroups(prev.pipelines, stableYOffsetsRef.current);
				if (offsets.size === 0) return prev;
				return {
					...prev,
					pipelines: prev.pipelines.map((p) => {
						const next = offsets.get(p.id);
						return next ? { ...p, viewOffset: next } : p;
					}),
				};
			}
			return {
				...prev,
				pipelines: prev.pipelines.map((p) =>
					p.id === prev.selectedPipelineId ? { ...p, nodes: arrangePipelineNodes(p) } : p
				),
			};
		});
		persistLayout();
		// Wait for React → ReactFlow to re-measure the moved nodes before fitting.
		setTimeout(() => reactFlowInstance.fitView({ padding: 0.2, duration: 300 }), 180);
	}, [setPipelineState, persistLayout, stableYOffsetsRef, reactFlowInstance]);

	const arrangeConfirmMessage = useMemo(() => {
		if (isAllPipelinesView) {
			const count = pipelineState.pipelines.filter((p) => p.nodes.length > 0).length;
			return `Auto-arrange will reposition all ${count} pipeline${count === 1 ? '' : 's'} into a tidy grid. Your current placement is preserved as ordering, just aligned. You can undo with Discard before saving.`;
		}
		const name = pipelineState.pipelines.find(
			(p) => p.id === pipelineState.selectedPipelineId
		)?.name;
		return `Auto-arrange will reposition the nodes in "${name ?? 'this pipeline'}" into a clean left-to-right layout. You can undo with Discard before saving.`;
	}, [isAllPipelinesView, pipelineState.pipelines, pipelineState.selectedPipelineId]);

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
		setInteractionMode,
		handleSave,
		zoomIn: reactFlowInstance.zoomIn,
		zoomOut: reactFlowInstance.zoomOut,
		fitView: reactFlowInstance.fitView,
		setIsLocked,
		containerRef,
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
		<div
			ref={containerRef}
			className="flex-1 flex flex-col"
			style={{ width: '100%', height: '100%' }}
		>
			<PipelineToolbar
				theme={theme}
				isAllPipelinesView={isAllPipelinesView}
				triggerDrawerOpen={triggerDrawerOpen}
				setTriggerDrawerOpen={setTriggerDrawerOpen}
				agentDrawerOpen={agentDrawerOpen}
				setAgentDrawerOpen={setAgentDrawerOpen}
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
				onNodeDragStart={canvasCallbacks.onNodeDragStart}
				onNodeDrag={canvasCallbacks.onNodeDrag}
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
				onCloseNodeConfig={() => setSelectedNodeId(null)}
				onSwitchToSession={onSwitchToSession}
				triggerDrawerOpenForConfig={triggerDrawerOpen}
				agentDrawerOpenForConfig={agentDrawerOpen}
				edgeSourceNode={edgeSourceNode}
				edgeTargetNode={edgeTargetNode}
				selectedEdgePipelineColor={selectedEdgePipelineColor}
				onUpdateEdge={onUpdateEdge}
				onDeleteEdge={onDeleteEdge}
				onTriggerPipeline={handleTriggerPipeline}
				isDirty={isDirty}
				runningPipelineIds={runningPipelineIds}
				isLoading={graphLoading || (graphSessions.length > 0 && !pipelinesLoaded)}
				interactionMode={interactionMode}
				setInteractionMode={setInteractionMode}
				isLocked={isLocked}
				setIsLocked={setIsLocked}
				onAutoArrange={() => setArrangeConfirmOpen(true)}
			/>

			{arrangeConfirmOpen && (
				<ConfirmModal
					theme={theme}
					title="Auto-arrange layout"
					message={arrangeConfirmMessage}
					destructive={false}
					confirmLabel="Arrange"
					headerIcon={<LayoutGrid className="w-4 h-4" style={{ color: theme.colors.accent }} />}
					icon={<LayoutGrid className="w-5 h-5" style={{ color: theme.colors.warning }} />}
					onConfirm={handleAutoArrange}
					onClose={() => setArrangeConfirmOpen(false)}
				/>
			)}

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
