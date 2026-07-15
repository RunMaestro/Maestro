/**
 * usePipelineCanvasCallbacks - ReactFlow canvas event callbacks.
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
 * onDrop specifically defers `setSelectedNodeId` via setTimeout(50ms) - the
 * new node must render before selection fires, otherwise `selectedNode` is
 * null on the first render after the drop.
 */

import { useCallback, useRef } from 'react';
import {
	applyNodeChanges,
	type Node,
	type NodeChange,
	type EdgeChange,
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
import {
	resolvePipelineOffset,
	resolveNonOverlappingPipelineOffset,
} from '../../components/CuePipelineEditor/utils/pipelineGraph';
import { DEFAULT_TRIGGER_LABELS } from '../../components/CuePipelineEditor/utils/pipelineValidation';
import { generateUUID } from '../../../shared/uuid';

/** Prefix used for ReactFlow-only pipeline-group background nodes. */
const PIPELINE_GROUP_PREFIX = 'pipeline-group:';

/** Delay before selecting a dropped node - lets ReactFlow mount the new node
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
	onNodeDragStart: (event: React.MouseEvent, node: Node, draggedNodes: Node[]) => void;
	onNodeDrag: (event: React.MouseEvent, node: Node, draggedNodes: Node[]) => void;
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

	// Always-fresh view of displayNodes so dragStart can snapshot child
	// positions synchronously (the drag callbacks use empty dep arrays, so the
	// `nodes` closure would otherwise be stale on the first gesture).
	const displayNodesRef = useRef(nodes);
	displayNodesRef.current = nodes;

	// Pipeline-group drag tracking. Captured at dragStart, used by onNodeDrag
	// to translate child nodes alongside the group, and by onNodeDragStop to
	// commit the cumulative delta into the pipeline's `viewOffset`.
	// `childStart` holds each content node's position AT DRAG START so onNodeDrag
	// can place them at start+delta (absolute), which is order-independent.
	// An incremental per-frame delta breaks: ReactFlow runs onNodesChange (which
	// moves the group node) BEFORE onNodeDrag, so reading the group's "previous"
	// position mid-drag already reflects the new spot and yields a zero delta -
	// the children never move and detach from the card.
	const groupDragRef = useRef<{
		groupId: string;
		pipelineId: string;
		startGroupPos: { x: number; y: number };
		childStart: Map<string, { x: number; y: number }>;
	} | null>(null);

	// Apply ALL node changes (including mid-drag) to the local displayNodes
	// so ReactFlow can render smooth dragging. Position commits to the
	// canonical pipelineState happen in onNodeDragStop instead.
	//
	// `remove` changes are the exception: box-select (lasso) + Delete routes
	// through ReactFlow's built-in delete, which emits `remove` changes here.
	// Updating displayNodes alone makes the nodes vanish visually but they
	// reappear on the next resync (computedNodes is rebuilt from an unchanged
	// pipelineState) and the dirty flag never flips. So we ALSO commit removals
	// to the canonical pipelineState - pruning connected edges, mirroring
	// onDeleteNode. (Single-node Delete via the keyboard hook / trash icon
	// already commits via onDeleteNode; this path covers multi-select where no
	// single node is tracked as selected.)
	const onNodesChange: OnNodesChange = useCallback(
		(changes: NodeChange[]) => {
			setDisplayNodes((nds) => applyNodeChanges(changes, nds));

			// All Pipelines view is read-only - no deletions.
			if (isAllPipelinesView) return;

			// Group removed node ids by owning pipeline (composite id:
			// "pipelineId:nodeId"; pipeline ids never contain ':').
			const removedByPipeline = new Map<string, Set<string>>();
			for (const change of changes) {
				if (change.type !== 'remove') continue;
				const sepIdx = change.id.indexOf(':');
				if (sepIdx === -1) continue;
				const pipelineId = change.id.slice(0, sepIdx);
				const nodeId = change.id.slice(sepIdx + 1);
				let set = removedByPipeline.get(pipelineId);
				if (!set) {
					set = new Set<string>();
					removedByPipeline.set(pipelineId, set);
				}
				set.add(nodeId);
			}
			if (removedByPipeline.size === 0) return;

			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					const removed = removedByPipeline.get(p.id);
					if (!removed) return p;
					return {
						...p,
						nodes: p.nodes.filter((n) => !removed.has(n.id)),
						edges: p.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
					};
				}),
			}));
			// A deleted node may have been the click-selected one driving the
			// config panel; clear selection so a stale composite id can't linger.
			setSelectedNodeId(null);
			setSelectedEdgeId(null);
		},
		[isAllPipelinesView, setDisplayNodes, setPipelineState, setSelectedNodeId, setSelectedEdgeId]
	);

	// Capture the pipeline-group's start position so we can apply the running
	// drag delta to its children as the user drags. Only meaningful in All
	// Pipelines view, where pipeline-group nodes exist and are draggable.
	const onNodeDragStart = useCallback(
		(_event: React.MouseEvent, node: Node, _draggedNodes: Node[]) => {
			if (node.type !== 'pipeline-group') {
				groupDragRef.current = null;
				return;
			}
			const pipelineId = node.id.startsWith(PIPELINE_GROUP_PREFIX)
				? node.id.slice(PIPELINE_GROUP_PREFIX.length)
				: '';
			if (!pipelineId) {
				groupDragRef.current = null;
				return;
			}
			// Snapshot every content node's start position (composite id
			// "pipelineId:nodeId"). The group node's own id is "pipeline-group:…"
			// and never matches this prefix, so it's correctly excluded.
			const pipelinePrefix = `${pipelineId}:`;
			const childStart = new Map<string, { x: number; y: number }>();
			for (const dn of displayNodesRef.current) {
				if (dn.id.startsWith(pipelinePrefix)) {
					childStart.set(dn.id, { x: dn.position.x, y: dn.position.y });
				}
			}
			groupDragRef.current = {
				groupId: node.id,
				pipelineId,
				startGroupPos: { x: node.position.x, y: node.position.y },
				childStart,
			};
		},
		[]
	);

	// While dragging the group, place every child node at its captured start
	// position plus the group's TOTAL delta from drag start. Absolute (not
	// incremental) so it's immune to ReactFlow's event ordering - onNodesChange
	// moves the group before onNodeDrag fires, which would zero out a per-frame
	// delta and strand the children. Children's canonical pipelineState
	// positions are NOT touched here - the delta is committed once on drag stop
	// as a viewOffset.
	const onNodeDrag = useCallback(
		(_event: React.MouseEvent, node: Node, _draggedNodes: Node[]) => {
			const drag = groupDragRef.current;
			if (!drag || node.id !== drag.groupId || node.type !== 'pipeline-group') return;
			const dx = node.position.x - drag.startGroupPos.x;
			const dy = node.position.y - drag.startGroupPos.y;
			setDisplayNodes((prev) =>
				prev.map((dn) => {
					const start = drag.childStart.get(dn.id);
					if (!start) return dn;
					const nx = start.x + dx;
					const ny = start.y + dy;
					if (dn.position.x === nx && dn.position.y === ny) return dn;
					return { ...dn, position: { x: nx, y: ny } };
				})
			);
		},
		[setDisplayNodes]
	);

	// Commit final positions to canonical pipelineState when drag ends.
	const onNodeDragStop = useCallback(
		(_event: React.MouseEvent, _node: Node, draggedNodes: Node[]) => {
			// Pipeline-group drag commits an additive `viewOffset` on the moved
			// pipeline AND freezes the current resolved offsets of every other
			// pipeline as their viewOffset. Without that snapshot, removing the
			// moved pipeline from the auto-stack chain would shift the rest
			// upward (or rearrange them) on the very next render.
			const groupDragged = draggedNodes.find((n) => n.type === 'pipeline-group');
			const drag = groupDragRef.current;
			if (groupDragged && drag && groupDragged.id === drag.groupId) {
				const dx = groupDragged.position.x - drag.startGroupPos.x;
				const dy = groupDragged.position.y - drag.startGroupPos.y;
				groupDragRef.current = null;
				if (dx === 0 && dy === 0) return;
				const movedId = drag.pipelineId;
				const yOffsets = stableYOffsetsRef.current;
				setPipelineState((prev) => {
					const movedPipeline = prev.pipelines.find((p) => p.id === movedId);
					if (!movedPipeline) return prev;

					const currentMovedOffset = resolvePipelineOffset(movedPipeline, yOffsets);
					const desiredMovedOffset = {
						x: currentMovedOffset.x + dx,
						y: currentMovedOffset.y + dy,
					};

					// Slide the dropped pipeline to a free spot if its desired
					// position would overlap any other pipeline group's bounding box.
					const others = prev.pipelines
						.filter((p) => p.id !== movedId)
						.map((p) => ({ pipeline: p, offset: resolvePipelineOffset(p, yOffsets) }));
					const adjustedMovedOffset = resolveNonOverlappingPipelineOffset(
						movedPipeline,
						desiredMovedOffset,
						others
					);

					return {
						...prev,
						pipelines: prev.pipelines.map((pipeline) => {
							const current = resolvePipelineOffset(pipeline, yOffsets);
							const next = pipeline.id === movedId ? adjustedMovedOffset : current;
							return { ...pipeline, viewOffset: next };
						}),
					};
				});
				persistLayout();
				return;
			}

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

	// Edge dragging is disabled, so the only changes that matter here are
	// `remove`s emitted by ReactFlow's built-in delete (box-select + Delete, or
	// deleting a node which cascades to its connected edges). Commit those to
	// pipelineState so the deletion sticks and the dirty flag flips - without
	// this, edge removes were silently dropped and the edge reappeared on resync.
	const onEdgesChange: OnEdgesChange = useCallback(
		(changes: EdgeChange[]) => {
			if (isAllPipelinesView) return;

			// Group removed edge ids by owning pipeline (composite id:
			// "pipelineId:edgeId").
			const removedByPipeline = new Map<string, Set<string>>();
			for (const change of changes) {
				if (change.type !== 'remove') continue;
				const sepIdx = change.id.indexOf(':');
				if (sepIdx === -1) continue;
				const pipelineId = change.id.slice(0, sepIdx);
				const edgeId = change.id.slice(sepIdx + 1);
				let set = removedByPipeline.get(pipelineId);
				if (!set) {
					set = new Set<string>();
					removedByPipeline.set(pipelineId, set);
				}
				set.add(edgeId);
			}
			if (removedByPipeline.size === 0) return;

			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					const removed = removedByPipeline.get(p.id);
					if (!removed) return p;
					return { ...p, edges: p.edges.filter((e) => !removed.has(e.id)) };
				}),
			}));
			setSelectedEdgeId(null);
		},
		[isAllPipelinesView, setPipelineState, setSelectedEdgeId]
	);

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
						// First incoming trigger - single-trigger mode. Seed the agent
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
						// Second+ incoming trigger - now in multi-trigger mode. Give the
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

	// Phase 14C - stabilize isValidConnection identity.
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

			// All Pipelines view is read-only - refuse to place new nodes.
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
					// matches positions correctly - same reason as the explicit
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
					// Each drop creates a fresh visual instance - even when the
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
					//   1) standalone "Command" pill - no owningSessionId; the user picks
					//      the owning agent in CommandConfigPanel after dropping.
					//   2) legacy per-session terminal pill (no longer rendered) - pre-binds.
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
		onNodeDragStart,
		onNodeDrag,
		onNodeDragStop,
		onEdgesChange,
		onConnect,
		isValidConnection,
		onDragOver,
		onDrop,
	};
}
