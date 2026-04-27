/**
 * usePipelineCanvasCallbacks — ReactFlow canvas event callbacks.
 *
 * Owns the set of canvas callbacks that are tightly coupled to ReactFlow's
 * mutable node state and the All-Pipelines-view read-only guards:
 *   - onNodesChange: updates displayNodes only (no pipelineState commit).
 *   - onNodeDragStop: commits final positions (subtracting stableYOffsets
 *     in All Pipelines view so positions round-trip correctly).
 *   - onEdgesChange: no-op (edge dragging disabled).
 *   - onConnect: validates + creates edge, auto-populates default prompts.
 *   - isValidConnection: live validation while dragging a connection.
 *   - onDragOver / onDrop: drawer-to-canvas drag-and-drop.
 *
 * onDrop specifically defers `setSelectedNodeId` via setTimeout(50ms) — the
 * new node must render before selection fires, otherwise `selectedNode` is
 * null on the first render after the drop.
 */

import { useCallback, useRef } from 'react';
import {
	applyNodeChanges,
	type Node,
	type NodeChange,
	type OnNodesChange,
	type OnEdgesChange,
	type Connection,
	type Edge,
	type ReactFlowInstance,
} from 'reactflow';
import type {
	CuePipelineState,
	CuePipeline,
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
	CueEventType,
} from '../../../shared/cue-pipeline-types';
import { getNextPipelineColor } from '../../components/CuePipelineEditor/pipelineColors';
import { defaultPromptFor } from '../../components/CuePipelineEditor/cueEventConstants';
import { DEFAULT_TRIGGER_LABELS } from '../../components/CuePipelineEditor/utils/pipelineValidation';
import { generateUUID } from '../../../shared/uuid';

/** Delay before selecting a dropped node — lets ReactFlow mount the new node
 *  before selection fires, otherwise `selectedNode` resolves to null on the
 *  first render. Preserve verbatim. */
const DROP_SELECT_DELAY_MS = 50;

export interface UsePipelineCanvasCallbacksParams {
	state: { pipelineState: CuePipelineState; isAllPipelinesView: boolean };
	refs: { stableYOffsetsRef: React.MutableRefObject<Map<string, number>> };
	display: {
		nodes: Node[];
		edges: Edge[];
		setDisplayNodes: React.Dispatch<React.SetStateAction<Node[]>>;
	};
	actions: {
		setPipelineState: React.Dispatch<React.SetStateAction<CuePipelineState>>;
		persistLayout: () => void;
	};
	selection: {
		setSelectedNodeId: (id: string | null) => void;
		setSelectedEdgeId: (id: string | null) => void;
	};
	reactFlowInstance: ReactFlowInstance;
}

export interface UsePipelineCanvasCallbacksReturn {
	onNodesChange: OnNodesChange;
	onNodeDragStop: (_event: React.MouseEvent, _node: Node, draggedNodes: Node[]) => void;
	onEdgesChange: OnEdgesChange;
	onConnect: (connection: Connection) => void;
	isValidConnection: (connection: Connection) => boolean;
	onDragOver: (event: React.DragEvent) => void;
	onDrop: (event: React.DragEvent) => void;
}

export function usePipelineCanvasCallbacks({
	state,
	refs,
	display,
	actions,
	selection,
	reactFlowInstance,
}: UsePipelineCanvasCallbacksParams): UsePipelineCanvasCallbacksReturn {
	const { isAllPipelinesView } = state;
	const { stableYOffsetsRef } = refs;
	const { nodes, edges, setDisplayNodes } = display;
	const { setPipelineState, persistLayout } = actions;
	const { setSelectedNodeId, setSelectedEdgeId } = selection;

	// Apply ALL node changes (including mid-drag) to the local displayNodes
	// so ReactFlow can render smooth dragging. Position commits to the
	// canonical pipelineState happen in onNodeDragStop instead.
	const onNodesChange: OnNodesChange = useCallback(
		(changes: NodeChange[]) => {
			setDisplayNodes((nds) => applyNodeChanges(changes, nds));
		},
		[setDisplayNodes]
	);

	// Commit final positions to canonical pipelineState when drag ends.
	const onNodeDragStop = useCallback(
		(_event: React.MouseEvent, _node: Node, draggedNodes: Node[]) => {
			if (isAllPipelinesView) return;
			if (draggedNodes.length === 0) return;

			setPipelineState((prev) => {
				const isAllPipelines = prev.selectedPipelineId === null;
				const yOffsets = stableYOffsetsRef.current;

				// Build a lookup from composite ID → final position
				const finalPositions = new Map<string, { x: number; y: number }>();
				for (const dn of draggedNodes) {
					if (dn.position) finalPositions.set(dn.id, dn.position);
				}

				const newPipelines = prev.pipelines.map((pipeline) => {
					const yOffset = isAllPipelines ? (yOffsets.get(pipeline.id) ?? 0) : 0;
					return {
						...pipeline,
						nodes: pipeline.nodes.map((pNode) => {
							const newPos = finalPositions.get(`${pipeline.id}:${pNode.id}`);
							if (!newPos) return pNode;
							return {
								...pNode,
								position: isAllPipelines ? { x: newPos.x, y: newPos.y - yOffset } : newPos,
							};
						}),
					};
				});
				return { ...prev, pipelines: newPipelines };
			});

			persistLayout();
		},
		[isAllPipelinesView, persistLayout, setPipelineState, stableYOffsetsRef]
	);

	const onEdgesChange: OnEdgesChange = useCallback(() => {}, []);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (isAllPipelinesView) return;
			if (!connection.source || !connection.target) return;

			const sourcePipelineId = connection.source.split(':')[0];
			const targetPipelineId = connection.target.split(':')[0];
			if (sourcePipelineId !== targetPipelineId) return;

			const sourceNodeId = connection.source.split(':').slice(1).join(':');
			const targetNodeId = connection.target.split(':').slice(1).join(':');

			setPipelineState((prev) => {
				const pipeline = prev.pipelines.find((p) => p.id === sourcePipelineId);
				if (!pipeline) return prev;

				const sourceNode = pipeline.nodes.find((n) => n.id === sourceNodeId);
				const targetNode = pipeline.nodes.find((n) => n.id === targetNodeId);
				if (!targetNode || targetNode.type === 'trigger') return prev;

				const newEdge: {
					id: string;
					source: string;
					target: string;
					mode: 'pass';
					prompt?: string;
				} = {
					id: `edge-${Date.now()}`,
					source: sourceNodeId,
					target: targetNodeId,
					mode: 'pass',
				};

				let updatedNodes = pipeline.nodes;
				let updatedEdges = pipeline.edges;

				if (sourceNode?.type === 'trigger' && targetNode.type === 'agent') {
					const triggerData = sourceNode.data as TriggerNodeData;
					const agentData = targetNode.data as AgentNodeData;
					const defaultPrompt = defaultPromptFor(triggerData.eventType);

					const existingTriggerEdges = pipeline.edges.filter((e) => {
						if (e.target !== targetNodeId) return false;
						const src = pipeline.nodes.find((n) => n.id === e.source);
						return src?.type === 'trigger';
					});

					if (existingTriggerEdges.length === 0) {
						// First incoming trigger — single-trigger mode. Seed the agent
						// node's inputPrompt so AgentConfigPanel's single-trigger
						// textarea has something helpful. Leave newEdge.prompt
						// undefined so save uses inputPrompt and user edits target the
						// same field. The moment a second trigger is connected below,
						// inputPrompt is migrated onto this edge and cleared.
						if (defaultPrompt && !agentData.inputPrompt?.trim()) {
							updatedNodes = pipeline.nodes.map((n) => {
								if (n.id !== targetNodeId) return n;
								return { ...n, data: { ...n.data, inputPrompt: defaultPrompt } };
							});
						}
					} else {
						// Second+ incoming trigger — now in multi-trigger mode. Give the
						// new edge its own template prompt and migrate any legacy
						// inputPrompt onto the existing edges that don't have their own
						// prompt yet, then clear inputPrompt so it can never leak.
						newEdge.prompt = defaultPrompt;

						if (agentData.inputPrompt?.trim()) {
							const legacyPrompt = agentData.inputPrompt;
							updatedEdges = pipeline.edges.map((e) =>
								existingTriggerEdges.some((te) => te.id === e.id) && !e.prompt
									? { ...e, prompt: legacyPrompt }
									: e
							);
							updatedNodes = pipeline.nodes.map((n) => {
								if (n.id !== targetNodeId) return n;
								return { ...n, data: { ...n.data, inputPrompt: undefined } };
							});
						}
					}
				}

				return {
					...prev,
					pipelines: prev.pipelines.map((p) => {
						if (p.id !== sourcePipelineId) return p;
						return { ...p, nodes: updatedNodes, edges: [...updatedEdges, newEdge] };
					}),
				};
			});
		},
		[isAllPipelinesView, setPipelineState]
	);

	// Phase 14C — stabilize isValidConnection identity.
	// ReactFlow re-registers its internal validation bookkeeping whenever the
	// callback identity changes. Previously nodes/edges were in the dep array,
	// so every node drag (which produces a new `nodes` array reference via
	// applyNodeChanges) invalidated the callback. Ref-forwarding keeps the
	// callback identity stable while still reading the latest state at call
	// time (isValidConnection is called synchronously during a connection
	// drag, so the refs are always up to date).
	const nodesRef = useRef(nodes);
	nodesRef.current = nodes;
	const edgesRef = useRef(edges);
	edgesRef.current = edges;

	const isValidConnection = useCallback(
		(connection: Connection) => {
			if (isAllPipelinesView) return false;
			if (!connection.source || !connection.target) return false;
			if (connection.source === connection.target) return false;

			const sourceNode = nodesRef.current.find((n) => n.id === connection.source);
			const targetNode = nodesRef.current.find((n) => n.id === connection.target);
			if (!sourceNode || !targetNode) return false;

			if (sourceNode.type === 'trigger' && targetNode.type === 'trigger') return false;
			if (targetNode.type === 'trigger') return false;

			const exists = edgesRef.current.some(
				(e) => e.source === connection.source && e.target === connection.target
			);
			if (exists) return false;

			return true;
		},
		[isAllPipelinesView]
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

			// All Pipelines view is read-only — refuse to place new nodes.
			// The toolbar disables the drawer buttons in this view, but a drag
			// from an already-open drawer (possible if the view changed mid-drag)
			// must still be rejected here.
			if (isAllPipelinesView) return;

			const raw = event.dataTransfer.getData('application/cue-pipeline');
			if (!raw) return;

			let dropData: {
				type: string;
				eventType?: CueEventType;
				label?: string;
				sessionId?: string;
				sessionName?: string;
				toolType?: string;
				owningSessionId?: string;
				owningSessionName?: string;
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
					// Ad-hoc first-pipeline creation on drop. ID must align with
					// the form yamlToPipeline generates on reload
					// (`pipeline-${baseName}`) so the first save+reopen cycle
					// matches positions correctly — same reason as the explicit
					// `createPipeline` path in `usePipelineCrud.ts`.
					const name = 'Pipeline 1';
					targetPipeline = {
						id: `pipeline-${name}`,
						name,
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
					// Each drop creates a fresh visual instance — even when the
					// user drags the same agent onto the canvas twice. The
					// `nodeKey` is what lets the YAML round-trip preserve those
					// distinct instances instead of merging them by sessionName
					// (the prior behavior, which silently fan-in'd two trigger
					// edges into one shared node on reload).
					const agentData: AgentNodeData = {
						sessionId: dropData.sessionId,
						sessionName: dropData.sessionName ?? 'Agent',
						toolType: dropData.toolType ?? 'unknown',
						nodeKey: generateUUID(),
					};
					newNode = {
						id: `agent-${dropData.sessionId}-${Date.now()}`,
						type: 'agent',
						position,
						data: agentData,
					};
				} else if (dropData.type === 'command') {
					// Two drop sources:
					//   1) standalone "Command" pill — no owningSessionId; the user picks
					//      the owning agent in CommandConfigPanel after dropping.
					//   2) legacy per-session terminal pill (no longer rendered) — pre-binds.
					const suffix = Date.now().toString(36).slice(-5);
					const ownerId = dropData.owningSessionId ?? '';
					const commandData: CommandNodeData = {
						name: `cmd-${suffix}`,
						mode: 'shell',
						shell: '',
						owningSessionId: ownerId,
						owningSessionName: dropData.owningSessionName ?? '',
						nodeKey: generateUUID(),
					};
					newNode = {
						id: `command-${ownerId || 'unbound'}-${Date.now()}`,
						type: 'command',
						position,
						data: commandData,
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
				}, DROP_SELECT_DELAY_MS);

				return {
					pipelines: updatedPipelines,
					selectedPipelineId: prev.selectedPipelineId ?? targetPipeline.id,
				};
			});
		},
		[isAllPipelinesView, reactFlowInstance, setPipelineState, setSelectedNodeId, setSelectedEdgeId]
	);

	return {
		onNodesChange,
		onNodeDragStop,
		onEdgesChange,
		onConnect,
		isValidConnection,
		onDragOver,
		onDrop,
	};
}
