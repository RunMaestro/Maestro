/**
 * CuePipelineEditor — React Flow-based visual pipeline editor for Maestro Cue.
 *
 * Thin shell that wires three hooks (usePipelineState, usePipelineSelection)
 * and three components (PipelineToolbar, PipelineCanvas, PipelineContextMenu).
 * Retains canvas-specific callbacks (onNodesChange, onConnect, onDrop, keyboard
 * shortcuts, context menu handlers) that are tightly coupled to ReactFlow.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ReactFlowProvider,
	useReactFlow,
	type Node,
	type OnNodesChange,
	type OnEdgesChange,
	type Connection,
} from 'reactflow';
import type { Theme } from '../../types';
import type {
	CueGraphSession,
	TriggerNodeData,
	AgentNodeData,
	CueEventType,
	PipelineNode,
	CuePipeline,
} from '../../../shared/cue-pipeline-types';
import { getNextPipelineColor } from './pipelineColors';
import {
	convertToReactFlowNodes,
	convertToReactFlowEdges,
	computePipelineYOffsets,
} from './utils/pipelineGraph';
import { usePipelineState, DEFAULT_TRIGGER_LABELS } from '../../hooks/cue/usePipelineState';
import type { SessionInfo, ActiveRunInfo } from '../../hooks/cue/usePipelineState';
import { usePipelineSelection } from '../../hooks/cue/usePipelineSelection';
import { PipelineToolbar } from './PipelineToolbar';
import { PipelineCanvas } from './PipelineCanvas';
import { PipelineContextMenu, type ContextMenuState } from './PipelineContextMenu';

export { validatePipelines, DEFAULT_TRIGGER_LABELS } from '../../hooks/cue/usePipelineState';
export type { SessionInfo, ActiveRunInfo } from '../../hooks/cue/usePipelineState';

export interface CuePipelineEditorProps {
	sessions: SessionInfo[];
	groups?: { id: string; name: string; emoji: string }[];
	graphSessions: CueGraphSession[];
	onSwitchToSession: (id: string) => void;
	onClose: () => void;
	onDirtyChange?: (isDirty: boolean) => void;
	theme: Theme;
	activeRuns?: ActiveRunInfo[];
	/** Callback to manually trigger a pipeline by name */
	onTriggerPipeline?: (pipelineName: string) => void;
}

/** Bridges the circular dependency between usePipelineState and usePipelineSelection. */
function useSelectionRef() {
	return useRef({
		selectedNodePipelineId: null as string | null,
		selectedEdgePipelineId: null as string | null,
		setSelectedNodeId: (() => {}) as React.Dispatch<React.SetStateAction<string | null>>,
		setSelectedEdgeId: (() => {}) as React.Dispatch<React.SetStateAction<string | null>>,
	});
}

function CuePipelineEditorInner({
	sessions,
	groups,
	graphSessions,
	onSwitchToSession,
	onDirtyChange,
	theme,
	activeRuns: activeRunsProp,
	onTriggerPipeline,
}: CuePipelineEditorProps) {
	const reactFlowInstance = useReactFlow();

	// Local drawer/context-menu state
	const [triggerDrawerOpen, setTriggerDrawerOpen] = useState(false);
	const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

	// Bridge ref: usePipelineState needs selection IDs, but usePipelineSelection
	// needs pipelineState. We use a ref so state hook reads latest selection values
	// without creating a hook ordering issue. On first render both are null (correct).
	const selectionRef = useSelectionRef();

	const stateHook = usePipelineState({
		sessions,
		graphSessions,
		activeRuns: activeRunsProp,
		onDirtyChange,
		reactFlowInstance,
		selectedNodePipelineId: selectionRef.current.selectedNodePipelineId,
		selectedEdgePipelineId: selectionRef.current.selectedEdgePipelineId,
		setSelectedNodeId: selectionRef.current.setSelectedNodeId,
		setSelectedEdgeId: selectionRef.current.setSelectedEdgeId,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
	});

	const selectionHook = usePipelineSelection({
		pipelineState: stateHook.pipelineState,
	});

	// Update ref so state hook gets fresh values on next render
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
		persistLayout,
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

	// Stable Y-offsets for the "All Pipelines" view.
	//
	// In this view, pipelines are stacked vertically using computed offsets so
	// they don't overlap. These offsets are a VIEW-LAYER concern: they affect
	// how ReactFlow positions are derived from (and mapped back to) canonical
	// pipeline-state positions. Both convertToReactFlowNodes (display) and
	// onNodesChange (write-back) must use the SAME offsets on every frame,
	// otherwise nodes jump or vanish.
	//
	// We recompute offsets only when the pipeline structure changes (pipelines
	// added/removed, nodes added/removed) — NOT on every position change.
	// This prevents the feedback loop where dragging a node changes the
	// bounding box and shifts all pipelines below.
	const pipelineStructureKey = useMemo(
		() =>
			pipelineState.pipelines
				.map((p) => `${p.id}:${p.nodes.length}:${p.nodes.map((n) => n.id).join(',')}`)
				.join('|'),
		[pipelineState.pipelines]
	);
	const stableYOffsets = useMemo(
		() => computePipelineYOffsets(pipelineState.pipelines, pipelineState.selectedPipelineId),

		[pipelineStructureKey, pipelineState.selectedPipelineId]
	);

	const {
		selectedNodeId,
		setSelectedNodeId,
		selectedEdgeId,
		setSelectedEdgeId,
		selectedNode,
		selectedNodePipelineId,
		selectedNodeHasOutgoingEdge,
		hasIncomingAgentEdges,
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

	// ─── ReactFlow nodes/edges ───────────────────────────────────────────────

	const nodes = useMemo(
		() =>
			convertToReactFlowNodes(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				handleConfigureNode,
				{
					onTriggerPipeline,
					isSaved: !isDirty,
					runningPipelineIds,
				},
				theme,
				stableYOffsets
			),
		[
			pipelineState.pipelines,
			pipelineState.selectedPipelineId,
			handleConfigureNode,
			onTriggerPipeline,
			isDirty,
			runningPipelineIds,
			theme,
			stableYOffsets,
		]
	);

	const edges = useMemo(
		() =>
			convertToReactFlowEdges(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				runningPipelineIds,
				selectedEdgeId,
				theme
			),
		[
			pipelineState.pipelines,
			pipelineState.selectedPipelineId,
			runningPipelineIds,
			selectedEdgeId,
			theme,
		]
	);

	// ─── Canvas callbacks ────────────────────────────────────────────────────

	// Ref mirror so onNodesChange reads the latest stable offsets without
	// adding them as a dependency (which would recreate the callback and
	// break ReactFlow memoisation).
	const stableYOffsetsRef = useRef(stableYOffsets);
	stableYOffsetsRef.current = stableYOffsets;

	const onNodesChange: OnNodesChange = useCallback(
		(changes) => {
			const positionUpdates = new Map<string, { x: number; y: number }>();
			let hasPositionChange = false;
			for (const change of changes) {
				if (change.type === 'position' && change.position) {
					positionUpdates.set(change.id, change.position);
					if (!change.dragging) {
						hasPositionChange = true;
					}
				}
			}

			if (positionUpdates.size > 0) {
				setPipelineState((prev) => {
					const isAllPipelines = prev.selectedPipelineId === null;

					// In single-pipeline view there are no Y-offsets — write
					// ReactFlow positions straight through (original behavior).
					if (!isAllPipelines) {
						const newPipelines = prev.pipelines.map((pipeline) => ({
							...pipeline,
							nodes: pipeline.nodes.map((pNode) => {
								const newPos = positionUpdates.get(`${pipeline.id}:${pNode.id}`);
								return newPos ? { ...pNode, position: newPos } : pNode;
							}),
						}));
						return { ...prev, pipelines: newPipelines };
					}

					// All Pipelines view: ReactFlow positions include the visual
					// Y-offsets from convertToReactFlowNodes. Subtract the same
					// stable offsets used for display so the round-trip is clean.
					const yOffsets = stableYOffsetsRef.current;

					const newPipelines = prev.pipelines.map((pipeline) => {
						const yOffset = yOffsets.get(pipeline.id) ?? 0;
						return {
							...pipeline,
							nodes: pipeline.nodes.map((pNode) => {
								const newPos = positionUpdates.get(`${pipeline.id}:${pNode.id}`);
								if (newPos) {
									return {
										...pNode,
										position: {
											x: newPos.x,
											y: newPos.y - yOffset,
										},
									};
								}
								return pNode;
							}),
						};
					});
					return { ...prev, pipelines: newPipelines };
				});
			}

			if (hasPositionChange) {
				persistLayout();
			}
		},
		[persistLayout, setPipelineState]
	);

	const onEdgesChange: OnEdgesChange = useCallback(() => {}, []);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return;

			const sourcePipelineId = connection.source.split(':')[0];
			const targetPipelineId = connection.target.split(':')[0];
			if (sourcePipelineId !== targetPipelineId) return;

			const sourceNodeId = connection.source.split(':').slice(1).join(':');
			const targetNodeId = connection.target.split(':').slice(1).join(':');

			setPipelineState((prev) => {
				const pipeline = prev.pipelines.find((p) => p.id === sourcePipelineId);
				if (!pipeline) return prev;

				const targetNode = pipeline.nodes.find((n) => n.id === targetNodeId);
				if (!targetNode || targetNode.type === 'trigger') return prev;

				const newEdge = {
					id: `edge-${Date.now()}`,
					source: sourceNodeId,
					target: targetNodeId,
					mode: 'pass' as const,
				};

				return {
					...prev,
					pipelines: prev.pipelines.map((p) => {
						if (p.id !== sourcePipelineId) return p;
						return { ...p, edges: [...p.edges, newEdge] };
					}),
				};
			});
		},
		[setPipelineState]
	);

	const isValidConnection = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return false;
			if (connection.source === connection.target) return false;

			const sourceNode = nodes.find((n) => n.id === connection.source);
			const targetNode = nodes.find((n) => n.id === connection.target);
			if (!sourceNode || !targetNode) return false;

			if (sourceNode.type === 'trigger' && targetNode.type === 'trigger') return false;
			if (targetNode.type === 'trigger') return false;

			const exists = edges.some(
				(e) => e.source === connection.source && e.target === connection.target
			);
			if (exists) return false;

			return true;
		},
		[nodes, edges]
	);

	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = 'move';
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();

			const raw = event.dataTransfer.getData('application/cue-pipeline');
			if (!raw) return;

			let dropData: {
				type: string;
				eventType?: CueEventType;
				label?: string;
				sessionId?: string;
				sessionName?: string;
				toolType?: string;
			};
			try {
				dropData = JSON.parse(raw);
			} catch {
				return;
			}

			const position = reactFlowInstance.screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});

			setPipelineState((prev) => {
				let targetPipeline: CuePipeline;
				let pipelines = prev.pipelines;
				const selectedId = prev.selectedPipelineId;

				if (selectedId) {
					const found = pipelines.find((p) => p.id === selectedId);
					if (found) {
						targetPipeline = found;
					} else {
						return prev;
					}
				} else if (pipelines.length > 0) {
					targetPipeline = pipelines[0];
				} else {
					targetPipeline = {
						id: `pipeline-${Date.now()}`,
						name: 'Pipeline 1',
						color: getNextPipelineColor([]),
						nodes: [],
						edges: [],
					};
					pipelines = [targetPipeline];
				}

				let newNode: PipelineNode;

				if (dropData.type === 'trigger' && dropData.eventType) {
					const triggerData: TriggerNodeData = {
						eventType: dropData.eventType,
						label:
							dropData.label ?? DEFAULT_TRIGGER_LABELS[dropData.eventType] ?? dropData.eventType,
						config: {},
					};
					newNode = {
						id: `trigger-${Date.now()}`,
						type: 'trigger',
						position,
						data: triggerData,
					};
				} else if (dropData.type === 'agent' && dropData.sessionId) {
					const agentData: AgentNodeData = {
						sessionId: dropData.sessionId,
						sessionName: dropData.sessionName ?? 'Agent',
						toolType: dropData.toolType ?? 'unknown',
					};
					newNode = {
						id: `agent-${dropData.sessionId}-${Date.now()}`,
						type: 'agent',
						position,
						data: agentData,
					};
				} else {
					return prev;
				}

				const updatedPipelines = pipelines.map((p) => {
					if (p.id === targetPipeline.id) {
						return { ...p, nodes: [...p.nodes, newNode] };
					}
					return p;
				});

				if (!pipelines.some((p) => p.id === targetPipeline.id)) {
					targetPipeline.nodes.push(newNode);
					updatedPipelines.push(targetPipeline);
				}

				const compositeId = `${targetPipeline.id}:${newNode.id}`;
				setTimeout(() => {
					setSelectedNodeId(compositeId);
					setSelectedEdgeId(null);
				}, 50);

				return {
					pipelines: updatedPipelines,
					selectedPipelineId: prev.selectedPipelineId ?? targetPipeline.id,
				};
			});
		},
		[reactFlowInstance, setPipelineState, setSelectedNodeId, setSelectedEdgeId]
	);

	// ─── Keyboard shortcuts ──────────────────────────────────────────────────

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (isInput) return;
				if (selectedNode && selectedNodePipelineId) {
					e.preventDefault();
					onDeleteNode(selectedNode.id);
				} else if (selectedEdge && selectedEdgePipelineId) {
					e.preventDefault();
					onDeleteEdge(selectedEdge.id);
				}
			} else if (e.key === 'Escape') {
				if (triggerDrawerOpen) {
					setTriggerDrawerOpen(false);
				} else if (agentDrawerOpen) {
					setAgentDrawerOpen(false);
				} else if (selectedNodeId || selectedEdgeId) {
					setSelectedNodeId(null);
					setSelectedEdgeId(null);
				}
			} else if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				handleSave();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [
		selectedNode,
		selectedNodePipelineId,
		selectedEdge,
		selectedEdgePipelineId,
		selectedNodeId,
		selectedEdgeId,
		onDeleteNode,
		onDeleteEdge,
		triggerDrawerOpen,
		agentDrawerOpen,
		handleSave,
		setSelectedNodeId,
		setSelectedEdgeId,
	]);

	// ─── Context menu handlers ───────────────────────────────────────────────

	const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
		event.preventDefault();
		const sepIdx = node.id.indexOf(':');
		if (sepIdx === -1) return;
		const pipelineId = node.id.substring(0, sepIdx);
		const nodeId = node.id.substring(sepIdx + 1);
		setContextMenu({
			x: event.clientX,
			y: event.clientY,
			nodeId,
			pipelineId,
			nodeType: node.type as 'trigger' | 'agent',
		});
	}, []);

	const handleContextMenuConfigure = useCallback(() => {
		if (!contextMenu) return;
		setSelectedNodeId(`${contextMenu.pipelineId}:${contextMenu.nodeId}`);
		setSelectedEdgeId(null);
		setContextMenu(null);
	}, [contextMenu, setSelectedNodeId, setSelectedEdgeId]);

	const handleContextMenuDelete = useCallback(() => {
		if (!contextMenu) return;
		setPipelineState((prev) => ({
			...prev,
			pipelines: prev.pipelines.map((p) => {
				if (p.id !== contextMenu.pipelineId) return p;
				return {
					...p,
					nodes: p.nodes.filter((n) => n.id !== contextMenu.nodeId),
					edges: p.edges.filter(
						(e) => e.source !== contextMenu.nodeId && e.target !== contextMenu.nodeId
					),
				};
			}),
		}));
		setSelectedNodeId(null);
		setContextMenu(null);
	}, [contextMenu, setPipelineState, setSelectedNodeId]);

	const handleContextMenuDuplicate = useCallback(() => {
		if (!contextMenu || contextMenu.nodeType !== 'trigger') return;
		setPipelineState((prev) => {
			const pipeline = prev.pipelines.find((p) => p.id === contextMenu.pipelineId);
			if (!pipeline) return prev;
			const original = pipeline.nodes.find((n) => n.id === contextMenu.nodeId);
			if (!original || original.type !== 'trigger') return prev;
			const newNode: PipelineNode = {
				id: `trigger-${Date.now()}`,
				type: 'trigger',
				position: { x: original.position.x + 50, y: original.position.y + 50 },
				data: { ...(original.data as TriggerNodeData) },
			};
			return {
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== contextMenu.pipelineId) return p;
					return { ...p, nodes: [...p.nodes, newNode] };
				}),
			};
		});
		setContextMenu(null);
	}, [contextMenu, setPipelineState]);

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
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				isValidConnection={isValidConnection}
				onNodeClick={onNodeClick}
				onEdgeClick={onEdgeClick}
				onPaneClick={onPaneClick}
				onNodeContextMenu={onNodeContextMenu}
				onDragOver={onDragOver}
				onDrop={onDrop}
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
