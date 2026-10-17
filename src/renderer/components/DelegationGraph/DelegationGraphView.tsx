/**
 * DelegationGraphView - the fleet's peer relationships, drawn.
 *
 * The Document Graph canvas in View, and the existing reactflow editor in Edit,
 * show agent nodes and directed delegation edges under a
 * toolbar (scope, mode, layout, fit, reset, legend), with a legend, a minimap
 * and a panel for the selected agent. The reactflow wiring follows
 * `CuePipelineEditor/PipelineCanvas.tsx`.
 *
 * TWO MODES, and it opens in View every time. In View nothing here edits a
 * roster: the connection handles are not drawn, no edge can be started, and
 * the one way to a relationship is the link to the Peers tab of an agent's
 * settings. Edit is what the user switches on to change who can reach whom:
 * an edge dragged from one agent to another opens `DelegationEdgeEditor` where
 * it was dropped, and confirming it writes one row into the roster of the
 * agent the edge STARTS from (`writeDelegationEdge`). Nothing is written to
 * the agent it ends on, and nothing is written before the confirm. An edge
 * already drawn opens the same editor when it is clicked, on its line or on
 * its badge, and that is where it is changed and taken away. Taking one away
 * is two different writes (`deleteDelegationEdge`): the row of an edge the user
 * wrote is deleted, and an edge a grant derived has no row, so the peer is
 * excluded. A toast says which one happened.
 * Edit is also where an agent the graph does not draw is put on it, from the
 * "Add agent" control of the toolbar or by dropping its Left Bar row on the
 * canvas. That changes no agent (`DelegationGraphPlacement`): the agent is not
 * moved into the group, and it is on the canvas only until the graph closes
 * unless an edge is drawn to it.
 * The switch is a guard and not ceremony: a graph of a real fleet is a dense
 * target, and a slipped drag on a surface that looks read-only would rewrite
 * an agent's permissions without a sign that it had. The mode is not saved,
 * so the graph can never open already armed.
 *
 * Dragging a node works in both modes. It changes where an agent is DRAWN,
 * never whom it can reach.
 *
 * Where the picture comes from:
 *
 *   - The model is `buildDelegationGraph` over the live agents
 *     (`useDelegationGraphModel`), rebuilt only when a field it reads changes.
 *   - The arrangement is `arrangeDelegationGraph`: a saved position wins, and
 *     an agent with none is placed beside its neighbors and then kept there.
 *   - The saved arrangement is per scope (`useDelegationGraphLayout`). A drag
 *     turns the scope `manual` and saves it; a named layout replaces it.
 *
 * Positions on screen are local state, because a drag moves a node many times
 * between two saves. The arrangement is copied into that state whenever it
 * changes, and reactflow's own changes (a drag, a measurement, a selection)
 * are applied to it directly. A save this canvas made comes back as a new
 * arrangement a render later: that echo is recognized and ignored, so a node
 * under the pointer is never pulled back to where it was saved a moment ago.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type DragEvent as ReactDragEvent,
	type MouseEvent as ReactMouseEvent,
} from 'react';
import ReactFlow, {
	Background,
	Controls,
	MiniMap,
	ReactFlowProvider,
	applyNodeChanges,
	useReactFlow,
	type Connection,
	type Edge,
	type Node,
	type NodeChange,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Eye, Info, Maximize2, Pencil, RotateCcw, Unplug, Users, Waypoints } from 'lucide-react';
import type { Theme } from '../../types';
import {
	connectedAgentIds,
	delegationEdgeId,
	delegationEdgeRefusal,
	delegationGraphStats,
	edgeBetween,
	type DelegationGraphEdge,
	type DelegationGraphModel,
	type DelegationGraphScope,
} from '../../../shared/delegationGraph';
import {
	parseScopeStorageKey,
	scopeStorageKey,
	type DelegationNodePosition,
	type DelegationSavedPositions,
} from '../../../shared/delegationGraphLayout';
import { hasAnyPeerAccess } from '../../../shared/peerAgents';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { useElementWidth, useFreeHeightInFlexColumn } from '../../hooks/ui/useElementWidth';
import { MindMap } from '../DocumentGraph/MindMap';
import { openAgentSettings } from '../../services/agentNavigation';
import {
	DELEGATION_EDGE_NEEDS_ACCESS,
	deleteDelegationEdge,
	describeDelegationEdgeRemoval,
	excludeDelegationPeer,
	writeDelegationEdge,
	type DelegationEdgeDraft,
} from '../../services/delegationGraphEdits';
import { notifyToast } from '../../stores/notificationStore';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import { useUIStore } from '../../stores/uiStore';
import { ConfirmModal } from '../ConfirmModal';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { MiniBadge } from '../ui/MiniBadge';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import {
	DelegationEdgeEditor,
	DelegationEdgeRefusal,
	type DelegationEdgeEditorAnchor,
} from './DelegationEdgeEditor';
import { DelegationGraphDetail } from './DelegationGraphDetail';
import { DelegationGraphLegend } from './DelegationGraphLegend';
import {
	DelegationAddAgentSelect,
	DelegationDropOverlay,
	DelegationPlacedNotice,
	delegationGroupLabel,
	delegationScopeGroups,
	sectionAgentsForAdding,
} from './DelegationGraphPlacement';
import {
	arrangeDelegationGraph,
	computeDelegationLayout,
	delegationMindMapData,
} from './delegationLayouts';
import {
	DEFAULT_DELEGATION_LAYOUT,
	DEFAULT_GLOBAL_DELEGATION_LAYOUT,
	DELEGATION_ALGORITHM_LAYOUTS,
	DELEGATION_LAYOUT_LABELS,
	isDelegationAlgorithmLayout,
	type DelegationAlgorithmLayout,
	type DelegationLayoutType,
} from './delegationLayoutTypes';
import {
	delegationEdgeMarker,
	delegationEdgeTypes,
	type DelegationEdgeData,
} from './edges/DelegationEdge';
import {
	AGENT_DELEGATION_NODE_HEIGHT,
	AgentDelegationNode,
	agentDelegationNodeState,
	estimateAgentDelegationNodeWidth,
	type AgentDelegationNodeData,
} from './nodes/AgentDelegationNode';
import { useDelegationGraphLayout } from './useDelegationGraphLayout';
import { useAgentsOffDelegationGraph, useDelegationGraphModel } from './useDelegationGraphModel';

export interface DelegationGraphViewProps {
	theme: Theme;
	/** The scope the graph opens on. Every agent when absent. */
	initialScope?: DelegationGraphScope;
}

/**
 * What the canvas lets the user do. `view` looks and rearranges; `edit` also
 * changes relationships. See the file comment for why this is a switch.
 */
export type DelegationGraphMode = 'view' | 'edit';

/** The mode every open starts in. */
export const DEFAULT_DELEGATION_GRAPH_MODE: DelegationGraphMode = 'view';

type AgentNode = Node<AgentDelegationNodeData>;

/** A change the user must confirm, because it discards hand placement. */
type PendingChange = { kind: 'layout'; layout: DelegationAlgorithmLayout } | { kind: 'reset' };

/**
 * An edge the user dropped, or clicked, and has not confirmed. `edge` is a
 * question the editor asks; `refused` is a drop that makes no edge, with the
 * reason. Neither has written anything.
 */
type PendingEdge =
	| { kind: 'edge'; sourceId: string; targetId: string; anchor: DelegationEdgeEditorAnchor }
	| { kind: 'refused'; message: string; anchor: DelegationEdgeEditorAnchor };

/** The agent the user selected, and every agent one edge away from it. */
interface NeighborFocus {
	selectedId: string;
	neighborIds: ReadonlySet<string>;
}

const ALL_SCOPE: DelegationGraphScope = { kind: 'all' };
/** No agent placed by hand. One array, so the model is not rebuilt for it. */
const NONE_PLACED: readonly string[] = Object.freeze([]);

// Stable module-scope references, so reactflow does not see new props on
// every render of the canvas.
const NODE_TYPES = { agent: AgentDelegationNode };
const PRO_OPTIONS = { hideAttribution: true } as const;
const FIT_VIEW_OPTIONS = { padding: 0.2 } as const;

/** How long after a rearrangement the view is fitted: the nodes must be drawn first. */
const FIT_DELAY_MS = 180;
const FIT_DURATION_MS = 300;
/**
 * How far a node must travel before a press counts as a drag. A click that
 * slips a pixel must not turn the scope `manual`.
 */
const DRAG_THRESHOLD_PX = 3;
/** An agent that is neither selected nor its neighbor, while one is selected. */
const UNFOCUSED_NODE_STYLE = { opacity: 0.35 } as const;

const LAYOUT_OPTIONS: ReadonlyArray<SegmentedOption<DelegationLayoutType>> =
	DELEGATION_ALGORITHM_LAYOUTS.map((value) => ({
		value,
		label: DELEGATION_LAYOUT_LABELS[value].name,
		title: DELEGATION_LAYOUT_LABELS[value].description,
	}));

const MODE_OPTIONS: ReadonlyArray<SegmentedOption<DelegationGraphMode>> = [
	{
		value: 'view',
		label: 'View',
		icon: Eye,
		title: 'Look and rearrange. Nothing here changes who an agent can reach',
	},
	{
		value: 'edit',
		label: 'Edit',
		icon: Pencil,
		title:
			'Change who can reach whom. Every change is written to the Peers of the agent it starts from',
	},
];

function positionsOfNodes(nodes: readonly AgentNode[]): DelegationSavedPositions {
	const positions: DelegationSavedPositions = {};
	for (const node of nodes) positions[node.id] = { x: node.position.x, y: node.position.y };
	return positions;
}

/** The one selected agent, or `null` for none and for a multiple selection. */
function soleSelectedId(nodes: readonly AgentNode[]): string | null {
	const selected = nodes.filter((node) => node.selected);
	return selected.length === 1 ? selected[0].id : null;
}

function neighborFocusOf(
	model: DelegationGraphModel,
	selectedId: string | null
): NeighborFocus | null {
	if (selectedId === null) return null;
	const neighborIds = new Set([selectedId]);
	for (const edge of model.edges) {
		if (edge.sourceId === selectedId) neighborIds.add(edge.targetId);
		if (edge.targetId === selectedId) neighborIds.add(edge.sourceId);
	}
	return { selectedId, neighborIds };
}

/** Where in the window a connection ended, for a mouse and for a touch. */
function pointOfConnectEvent(event: MouseEvent | TouchEvent): DelegationEdgeEditorAnchor | null {
	const point = 'changedTouches' in event ? event.changedTouches[0] : event;
	return point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY)
		? { x: point.clientX, y: point.clientY }
		: null;
}

function openPeersTab(sessionId: string): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (session) openAgentSettings(session, { tab: 'peers' });
}

function DelegationGraphCanvas({ theme, initialScope }: DelegationGraphViewProps) {
	const { colors } = theme;
	const reactFlow = useReactFlow();
	const groups = useSessionStore((store) => store.groups);
	const activeSessionId = useSessionStore((store) => store.activeSessionId);

	// A group scope outlives its group only until the next render: the graph
	// then shows every agent, and never an empty picture of a group that is gone.
	const [requestedScope, setRequestedScope] = useState<DelegationGraphScope>(
		initialScope ?? ALL_SCOPE
	);
	const scopeAgentExists = useSessionStore(
		(store) =>
			requestedScope.kind !== 'agent' ||
			store.sessions.some((session) => session.id === requestedScope.sessionId)
	);
	const scope = useMemo(
		() =>
			!scopeAgentExists ||
			(requestedScope.kind === 'group' &&
				!groups.some((group) => group.id === requestedScope.groupId))
				? ALL_SCOPE
				: requestedScope,
		[requestedScope, groups, scopeAgentExists]
	);
	const scopeKey = scopeStorageKey(scope);
	const defaultLayout =
		scope.kind === 'all' ? DEFAULT_GLOBAL_DELEGATION_LAYOUT : DEFAULT_DELEGATION_LAYOUT;

	// Plain state, never persisted: see the file comment. It survives a change
	// of scope, because the user who switched it on is still the one editing.
	const [mode, setMode] = useState<DelegationGraphMode>(DEFAULT_DELEGATION_GRAPH_MODE);
	const isEditing = mode === 'edit';
	const sortedGroups = useMemo(() => delegationScopeGroups(groups), [groups]);

	// The agents the user put on this scope's canvas by hand. Never saved and
	// never written to an agent: see `DelegationGraphPlacement`.
	const [placedIds, setPlacedIds] = useState<readonly string[]>(NONE_PLACED);
	const model = useDelegationGraphModel(scope, placedIds);
	const mindMapData = useMemo(() => delegationMindMapData(model), [model]);
	const addableAgents = useAgentsOffDelegationGraph(model);
	const stats = useMemo(() => delegationGraphStats(model), [model]);
	const connectedIds = useMemo(() => connectedAgentIds(model), [model]);
	const isEmpty = stats.agents === 0;
	// An agent is placed to be connected, and an edge needs one end in the
	// scope: with no agent in it there is nothing to place an agent for.
	const canPlace = isEditing && stats.agents > stats.spill;
	const {
		layout,
		hasSavedLayout,
		positions,
		saveDraggedPositions,
		saveDroppedPositions,
		saveAlgorithmLayout,
		savePlacedPositions,
		resetLayout,
	} = useDelegationGraphLayout(scope);

	const arrangement = useMemo(
		() => arrangeDelegationGraph(model, layout, positions),
		[model, layout, positions]
	);
	// A new agent was put beside its neighbors: keep it there, so it is in the
	// same place on the next open. A no-op for a scope with nothing saved.
	useEffect(() => {
		savePlacedPositions(arrangement.newlyPlaced);
	}, [arrangement, savePlacedPositions]);

	const arrangedNodes = useMemo<AgentNode[]>(
		() =>
			model.nodes.map((node) => ({
				id: node.sessionId,
				type: 'agent',
				position: arrangement.positions[node.sessionId] ?? { x: 0, y: 0 },
				data: {
					sessionId: node.sessionId,
					state: agentDelegationNodeState(node, connectedIds),
					theme,
				},
			})),
		[model, connectedIds, arrangement, theme]
	);

	const [nodes, setNodes] = useState<AgentNode[]>(arrangedNodes);
	// What `nodes` will be after the pending render. reactflow can send several
	// changes before React renders once, and each must build on the one before.
	const nodesRef = useRef(nodes);
	const commitNodes = useCallback((next: AgentNode[]) => {
		nodesRef.current = next;
		setNodes(next);
	}, []);

	// The positions this canvas last sent to be saved, to tell its own save
	// coming back from an arrangement made somewhere else.
	const savedByCanvasRef = useRef<DelegationSavedPositions>({});

	// Copy a new arrangement onto the canvas. Within one scope a node keeps what
	// reactflow knows about it (its measured size, its selection), and a position
	// that is only the echo of this canvas's own save leaves the node where it is
	// now. A change of scope starts clean: the same agent is a different node in
	// another graph.
	const syncedScopeKeyRef = useRef(scopeKey);
	useEffect(() => {
		if (syncedScopeKeyRef.current !== scopeKey) {
			syncedScopeKeyRef.current = scopeKey;
			savedByCanvasRef.current = {};
			commitNodes(arrangedNodes);
			return;
		}
		const current = new Map(nodesRef.current.map((node) => [node.id, node]));
		const savedByCanvas = savedByCanvasRef.current;
		commitNodes(
			arrangedNodes.map((node) => {
				const onCanvas = current.get(node.id);
				if (!onCanvas) return node;
				const sent = savedByCanvas[node.id];
				const isEcho = sent?.x === node.position.x && sent?.y === node.position.y;
				return { ...onCanvas, ...node, position: isEcho ? onCanvas.position : node.position };
			})
		);
	}, [arrangedNodes, scopeKey, commitNodes]);

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			const next = applyNodeChanges(changes, nodesRef.current);
			commitNodes(next);
			// A position change that carries a position is the user moving a node,
			// with the pointer or with the arrow keys. Every node is saved, not only
			// the one that moved: the first move is what turns an algorithm's
			// arrangement into a saved one.
			if (changes.some((change) => change.type === 'position' && change.position)) {
				const moved = positionsOfNodes(next);
				savedByCanvasRef.current = moved;
				saveDraggedPositions(moved);
			}
		},
		[commitNodes, saveDraggedPositions]
	);

	const selectedId = soleSelectedId(nodes);
	const focus = useMemo(() => neighborFocusOf(model, selectedId), [model, selectedId]);

	const clearSelection = useCallback(() => {
		commitNodes(
			nodesRef.current.map((node) => (node.selected ? { ...node, selected: false } : node))
		);
	}, [commitNodes]);

	// Dimming is applied at draw time and kept out of `nodes`, so selecting an
	// agent never rewrites a position.
	const displayNodes = useMemo(
		() =>
			focus
				? nodes.map((node) =>
						focus.neighborIds.has(node.id) ? node : { ...node, style: UNFOCUSED_NODE_STYLE }
					)
				: nodes,
		[nodes, focus]
	);

	// An edge the user dropped or clicked, until it is confirmed or closed. It
	// belongs to the scope and the mode it was opened in, so a change of either
	// discards it.
	const [pendingEdge, setPendingEdge] = useState<PendingEdge | null>(null);
	const canvasRef = useRef<HTMLDivElement>(null);
	const canvasWidth = useElementWidth(canvasRef);
	const canvasHeight = useFreeHeightInFlexColumn(canvasRef);
	const canvasPositions = useMemo(() => {
		if (layout !== 'manual') return undefined;
		const names = new Map(model.nodes.map((node) => [node.sessionId, node.name]));
		return new Map(
			nodes.map((node) => [
				node.id,
				{
					x: node.position.x + estimateAgentDelegationNodeWidth(names.get(node.id) ?? '') / 2,
					y: node.position.y + AGENT_DELEGATION_NODE_HEIGHT / 2,
				},
			])
		);
	}, [layout, nodes, model]);
	// reactflow reports a connection first (`onConnect`, which has no pointer)
	// and the end of the gesture second (`onConnectEnd`, which has one). This
	// says the end that is coming belongs to a connection, and not to an edge
	// dropped on nothing.
	const awaitingDropPointRef = useRef(false);

	// Open an edge that is already drawn, where it was clicked. Only in Edit: in
	// View the canvas hands no edge a way in at all.
	const openEdgeEditor = useCallback(
		(sourceId: string, targetId: string, anchor: DelegationEdgeEditorAnchor) => {
			if (!isEditing) return;
			awaitingDropPointRef.current = false;
			setPendingEdge({ kind: 'edge', sourceId, targetId, anchor });
		},
		[isEditing]
	);
	// The line, from reactflow.
	const handleEdgeClick = useCallback(
		(event: ReactMouseEvent, edge: Edge) =>
			openEdgeEditor(edge.source, edge.target, { x: event.clientX, y: event.clientY }),
		[openEdgeEditor]
	);
	// The badge, from the edge itself: a click, Enter or Space.
	const handleEdgeOpen = useCallback(
		(edge: DelegationGraphEdge, anchor: DelegationEdgeEditorAnchor) =>
			openEdgeEditor(edge.sourceId, edge.targetId, anchor),
		[openEdgeEditor]
	);

	// The edge the open editor is about. It is raised, so the popover can be
	// matched to its line on a dense graph.
	const editedEdgeId =
		pendingEdge?.kind === 'edge'
			? delegationEdgeId(pendingEdge.sourceId, pendingEdge.targetId)
			: null;

	const edges = useMemo<Edge<DelegationEdgeData>[]>(() => {
		const edgeIds = new Set(model.edges.map((edge) => edge.id));
		const markerEnd = delegationEdgeMarker(theme);
		const emphasisOf = (edge: DelegationGraphEdge): DelegationEdgeData['emphasis'] => {
			if (edge.id === editedEdgeId) return 'highlighted';
			if (!focus) return undefined;
			return edge.sourceId === focus.selectedId || edge.targetId === focus.selectedId
				? 'highlighted'
				: 'dimmed';
		};
		return model.edges.map((edge) => {
			const emphasis = emphasisOf(edge);
			return {
				id: edge.id,
				source: edge.sourceId,
				target: edge.targetId,
				type: 'delegation',
				markerEnd,
				// Never selected and never focused through reactflow: the edges are
				// controlled and no change is applied to them, so a selection would
				// not show, and reactflow's own key handling opens nothing. An edge is
				// opened by a click on its line (`onEdgeClick`) and through its badge,
				// which is a button in Edit.
				selectable: false,
				focusable: false,
				data: {
					edge,
					hasReverse: edgeIds.has(delegationEdgeId(edge.targetId, edge.sourceId)),
					...(emphasis ? { emphasis } : {}),
					...(isEditing ? { onOpen: handleEdgeOpen } : {}),
					theme,
				},
			};
		});
	}, [model, theme, focus, editedEdgeId, isEditing, handleEdgeOpen]);

	// Fit after a rearrangement and after a change of scope. The delay lets the
	// moved nodes be drawn and measured, so the fit covers where they ARE.
	const [fitRequest, setFitRequest] = useState(0);
	const requestFit = useCallback(() => setFitRequest((count) => count + 1), []);
	useEffect(() => {
		const timer = setTimeout(
			() => reactFlow.fitView({ ...FIT_VIEW_OPTIONS, duration: FIT_DURATION_MS }),
			FIT_DELAY_MS
		);
		return () => clearTimeout(timer);
	}, [fitRequest, scopeKey, reactFlow]);

	// Select one agent and no other, which is how the graph points at an agent.
	const selectOnly = useCallback(
		(sessionId: string) => {
			commitNodes(
				nodesRef.current.map((node) =>
					Boolean(node.selected) === (node.id === sessionId)
						? node
						: { ...node, selected: node.id === sessionId }
				)
			);
		},
		[commitNodes]
	);

	// Put an agent on the canvas. `at` is where it was dropped; without it the
	// arrangement finds the agent a place. Nothing is written to any agent.
	const placeAgent = useCallback(
		(sessionId: string, at?: DelegationNodePosition) => {
			if (!canPlace) return;
			if (model.nodes.some((node) => node.sessionId === sessionId)) {
				// Already drawn, so there is nothing to add: show the user where.
				selectOnly(sessionId);
				return;
			}
			if (!selectSessionById(sessionId)(useSessionStore.getState())) return;
			if (at) {
				// A drop at a point is hand placement, saved the way a drag is: with
				// every node on the canvas, and before the agent is drawn, so its
				// first render reads the drop point back.
				const dropped = { ...positionsOfNodes(nodesRef.current), [sessionId]: at };
				savedByCanvasRef.current = dropped;
				saveDroppedPositions(dropped);
			} else {
				// The arrangement can put it outside the view. Bring it in.
				requestFit();
			}
			setPlacedIds((ids) => (ids.includes(sessionId) ? ids : [...ids, sessionId]));
		},
		[canPlace, model, selectOnly, saveDroppedPositions, requestFit]
	);
	const clearPlaced = useCallback(() => setPlacedIds(NONE_PLACED), []);

	const addableSections = useMemo(
		() => sectionAgentsForAdding(addableAgents, sortedGroups),
		[addableAgents, sortedGroups]
	);
	// The agents that are on the canvas only because the user put them there.
	const placedNames = useMemo(
		() =>
			model.nodes
				.filter((node) => agentDelegationNodeState(node, connectedIds) === 'placed')
				.map((node) => node.name),
		[model, connectedIds]
	);
	const scopeGroupName =
		scope.kind === 'group' ? groups.find((group) => group.id === scope.groupId)?.name : undefined;

	// An agent row dragged from the Left Bar. The row puts nothing in the drag's
	// data: the agent in the user's hand is `draggingSessionId`, the same field
	// the Left Bar's own drop targets read, and it is cleared when the drag ends.
	const draggingSessionId = useUIStore((store) => store.draggingSessionId);
	const draggingAgentName = useSessionStore((store) =>
		draggingSessionId ? selectSessionById(draggingSessionId)(store)?.name : undefined
	);
	const [isDragOver, setIsDragOver] = useState(false);
	// A drag that ends anywhere, dropped or cancelled, is over the canvas no more.
	useEffect(() => {
		if (!draggingSessionId) setIsDragOver(false);
	}, [draggingSessionId]);
	const handleCanvasDragOver = useCallback(
		(event: ReactDragEvent<HTMLDivElement>) => {
			// Read at the event: any other drag (a file, a tab) is none of this
			// canvas's business and is left to whoever owns it.
			if (!canPlace || !useUIStore.getState().draggingSessionId) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = 'copy';
			setIsDragOver(true);
		},
		[canPlace]
	);
	const handleCanvasDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
		// Crossing onto a child of the canvas fires this too.
		if (!event.currentTarget.contains(event.relatedTarget as Element | null)) {
			setIsDragOver(false);
		}
	}, []);
	const handleCanvasDrop = useCallback(
		(event: ReactDragEvent<HTMLDivElement>) => {
			setIsDragOver(false);
			const draggedId = useUIStore.getState().draggingSessionId;
			if (!canPlace || !draggedId) return;
			const agent = selectSessionById(draggedId)(useSessionStore.getState());
			if (!agent) return;
			event.preventDefault();
			const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
			// A node is positioned by its top left corner: put its middle under the
			// pointer.
			placeAgent(draggedId, {
				x: point.x - estimateAgentDelegationNodeWidth(agent.name) / 2,
				y: point.y - AGENT_DELEGATION_NODE_HEIGHT / 2,
			});
		},
		[canPlace, placeAgent, reactFlow]
	);

	const applyLayout = useCallback(
		(next: DelegationAlgorithmLayout) => {
			saveAlgorithmLayout(
				next,
				computeDelegationLayout(next, model, { centerId: selectedId ?? undefined })
			);
			requestFit();
		},
		[saveAlgorithmLayout, model, selectedId, requestFit]
	);
	const applyReset = useCallback(() => {
		resetLayout();
		requestFit();
	}, [resetLayout, requestFit]);

	// A named layout and a reset both discard hand placement, so both ask first,
	// but only when there IS hand placement. Moving between two algorithms
	// destroys nothing the user made.
	const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
	const handleLayoutChange = useCallback(
		(next: DelegationLayoutType) => {
			if (!isDelegationAlgorithmLayout(next)) return;
			if (layout === 'manual') setPendingChange({ kind: 'layout', layout: next });
			else applyLayout(next);
		},
		[layout, applyLayout]
	);
	const handleReset = useCallback(() => {
		if (layout === 'manual') setPendingChange({ kind: 'reset' });
		else applyReset();
	}, [layout, applyReset]);
	const confirmPendingChange = useCallback(() => {
		if (pendingChange?.kind === 'layout') applyLayout(pendingChange.layout);
		else if (pendingChange?.kind === 'reset') applyReset();
	}, [pendingChange, applyLayout, applyReset]);

	const handleConnect = useCallback(
		(connection: Connection) => {
			const { source, target } = connection;
			if (!isEditing || !source || !target) return;
			// Until the drop point arrives, and when it never does: the middle of
			// the canvas.
			const rect = canvasRef.current?.getBoundingClientRect();
			const anchor = rect
				? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
				: { x: 0, y: 0 };
			awaitingDropPointRef.current = true;
			const refusal = delegationEdgeRefusal(model, source, target);
			setPendingEdge(
				refusal
					? { kind: 'refused', message: refusal, anchor }
					: { kind: 'edge', sourceId: source, targetId: target, anchor }
			);
		},
		[isEditing, model]
	);
	const handleConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
		if (!awaitingDropPointRef.current) return;
		awaitingDropPointRef.current = false;
		const point = pointOfConnectEvent(event);
		if (point) setPendingEdge((pending) => (pending ? { ...pending, anchor: point } : pending));
	}, []);
	const closePendingEdge = useCallback(() => setPendingEdge(null), []);
	// The editor names both agents, so it is drawn only while both are on the
	// graph. An agent deleted under an open editor closes it.
	const edgeEditor = useMemo(() => {
		if (pendingEdge?.kind !== 'edge') return null;
		const nameOf = (sessionId: string) =>
			model.nodes.find((node) => node.sessionId === sessionId)?.name;
		const sourceName = nameOf(pendingEdge.sourceId);
		const targetName = nameOf(pendingEdge.targetId);
		if (sourceName === undefined || targetName === undefined) return null;
		return {
			...pendingEdge,
			sourceName,
			targetName,
			existing: edgeBetween(model, pendingEdge.sourceId, pendingEdge.targetId),
			reverse: edgeBetween(model, pendingEdge.targetId, pendingEdge.sourceId),
		};
	}, [pendingEdge, model]);

	const confirmPendingEdge = useCallback(
		(draft: DelegationEdgeDraft): string | null => {
			if (!edgeEditor) return null;
			const { sourceId, targetId, sourceName, targetName } = edgeEditor;
			if (hasAnyPeerAccess(draft)) {
				const written = writeDelegationEdge(sourceId, targetId, draft);
				if (!written.ok) return written.error;
			} else {
				// Neither bit. On an edge that exists it is the exclusion row, and
				// the user is told that it was not a delete. A new edge with neither
				// bit is not a relationship, and the editor does not offer it.
				if (!edgeEditor.existing) return DELEGATION_EDGE_NEEDS_ACCESS;
				const excluded = excludeDelegationPeer(sourceId, targetId, draft.description);
				if (!excluded.ok) return excluded.error;
				notifyToast(describeDelegationEdgeRemoval(excluded, sourceName, targetName));
			}
			setPendingEdge(null);
			return null;
		},
		[edgeEditor]
	);
	// The delete action of the editor. What it writes depends on where the edge
	// comes from, so the result is said in words at the moment it happens: a
	// derived edge is excluded and not deleted, and a deleted row can leave an
	// edge that a grant still draws.
	const deletePendingEdge = useCallback((): string | null => {
		if (!edgeEditor?.existing) return null;
		const { sourceId, targetId, sourceName, targetName } = edgeEditor;
		const removal = deleteDelegationEdge(sourceId, targetId);
		if (!removal.ok) return removal.error;
		notifyToast(describeDelegationEdgeRemoval(removal, sourceName, targetName));
		setPendingEdge(null);
		return null;
	}, [edgeEditor]);

	const handleModeChange = useCallback((next: DelegationGraphMode) => {
		setMode(next);
		setPendingEdge(null);
	}, []);
	const changeScope = useCallback((next: DelegationGraphScope) => {
		setRequestedScope(next);
		setPendingEdge(null);
		// An agent was placed on ONE scope's canvas. Another scope starts without it.
		setPlacedIds(NONE_PLACED);
	}, []);
	const handleScopeChange = useCallback(
		(event: ChangeEvent<HTMLSelectElement>) => {
			changeScope(parseScopeStorageKey(event.target.value) ?? ALL_SCOPE);
		},
		[changeScope]
	);

	const legend = usePersistedToggle('delegationGraph.legend.open', true);

	const reactFlowStyle = useMemo(() => ({ backgroundColor: colors.bgMain }), [colors.bgMain]);
	const connectionLineStyle = useMemo(
		() => ({ stroke: colors.accent, strokeWidth: 2 }),
		[colors.accent]
	);
	const controlsStyle = useMemo(
		() => ({ backgroundColor: colors.bgActivity, borderColor: colors.border }),
		[colors.bgActivity, colors.border]
	);
	const miniMapStyle = useMemo(
		() => ({ backgroundColor: colors.bgActivity, border: `1px solid ${colors.border}` }),
		[colors.bgActivity, colors.border]
	);
	const miniMapNodeColor = useCallback(
		(node: Node) => {
			const state = (node as AgentNode).data?.state;
			return state === 'isolated'
				? colors.warning
				: state === 'spill' || state === 'placed'
					? colors.border
					: colors.accent;
		},
		[colors.warning, colors.border, colors.accent]
	);

	const noEdges = !isEmpty && stats.edges === 0;
	// The agent the "nobody is connected" notice sends the user to: the one they
	// selected, else the one they are working in, else the first on the graph.
	const peersTargetId =
		selectedId ??
		(model.nodes.some((node) => node.sessionId === activeSessionId)
			? activeSessionId
			: model.nodes[0]?.sessionId);
	const peersTargetName = model.nodes.find((node) => node.sessionId === peersTargetId)?.name;

	return (
		<div className="flex flex-col h-full w-full min-h-0" data-testid="delegation-graph-view">
			{/* Toolbar */}
			<div
				className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
				style={{ borderColor: colors.border, backgroundColor: colors.bgSidebar }}
			>
				<select
					value={scopeKey}
					onChange={handleScopeChange}
					aria-label="Scope"
					title="Which agents the graph is about"
					data-testid="delegation-graph-scope"
					className="px-2 py-1 rounded text-xs border cursor-pointer outline-none max-w-[220px]"
					style={{
						backgroundColor: colors.bgMain,
						borderColor: colors.border,
						color: colors.textMain,
					}}
				>
					<option value={scopeStorageKey(ALL_SCOPE)}>All agents</option>
					{scope.kind === 'agent' && (
						<option value={scopeKey}>
							Cluster:{' '}
							{model.nodes.find((node) => node.sessionId === scope.sessionId)?.name ??
								'Removed agent'}
						</option>
					)}
					{sortedGroups.map((group) => {
						const value = scopeStorageKey({ kind: 'group', groupId: group.id });
						return (
							<option key={value} value={value}>
								{delegationGroupLabel(group)}
							</option>
						);
					})}
				</select>
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={() =>
						scope.kind === 'all'
							? selectedId && changeScope({ kind: 'agent', sessionId: selectedId })
							: changeScope(ALL_SCOPE)
					}
					icon={<Users />}
					disabled={scope.kind === 'all' && (!selectedId || !connectedIds.has(selectedId))}
					title={
						scope.kind === 'all'
							? 'Show the selected agent and its connected cluster'
							: 'Show every agent, clustered in Lobes by default'
					}
					testId="delegation-graph-toggle-cluster"
				>
					{scope.kind === 'all' ? 'Show cluster' : 'Show all agents'}
				</HeaderActionButton>

				<SegmentedControl
					value={mode}
					onChange={handleModeChange}
					options={MODE_OPTIONS}
					theme={theme}
					ariaLabel="Mode"
					testId="delegation-graph-mode"
				/>
				{isEditing && (
					<DelegationAddAgentSelect
						theme={theme}
						sections={addableSections}
						disabledReason={
							!canPlace
								? 'This group has no agent that an added agent could be connected to'
								: addableAgents.length === 0
									? 'Every agent is already on this graph'
									: undefined
						}
						onAdd={placeAgent}
					/>
				)}

				<SegmentedControl
					value={layout}
					onChange={handleLayoutChange}
					options={LAYOUT_OPTIONS}
					theme={theme}
					ariaLabel="Layout"
					testId="delegation-graph-layout"
				/>
				{layout === 'manual' && (
					<MiniBadge
						theme={theme}
						label={DELEGATION_LAYOUT_LABELS.manual.name}
						title={`${DELEGATION_LAYOUT_LABELS.manual.description}. Pick a layout to rearrange.`}
						testId="delegation-graph-layout-manual"
					/>
				)}

				<div className="flex-1" />

				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={requestFit}
					icon={<Maximize2 />}
					title="Fit the whole graph in view"
					disabled={isEmpty}
					testId="delegation-graph-fit"
				>
					Fit
				</HeaderActionButton>
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={handleReset}
					icon={<RotateCcw />}
					title={`Forget where the agents in this scope were placed and go back to the ${DELEGATION_LAYOUT_LABELS[defaultLayout].name} layout`}
					disabled={!hasSavedLayout}
					testId="delegation-graph-reset"
				>
					Reset layout
				</HeaderActionButton>
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={legend.toggle}
					icon={<Info />}
					title={legend.value ? 'Hide the legend' : 'Show the legend'}
					testId="delegation-graph-legend-toggle"
				>
					Legend
				</HeaderActionButton>
			</div>

			{/* Canvas */}
			<div
				ref={canvasRef}
				className="flex-1 relative overflow-hidden min-h-0"
				data-testid="delegation-graph-canvas"
				data-mode={mode}
				// The drop zone of an agent row. In View, and for any other drag, the
				// three handlers do nothing.
				onDragOver={handleCanvasDragOver}
				onDragLeave={handleCanvasDragLeave}
				onDrop={handleCanvasDrop}
			>
				{isEmpty ? (
					<EmptyStatePlaceholder
						theme={theme}
						className="h-full"
						icon={<Waypoints className="w-12 h-12" />}
						title={scope.kind === 'group' ? 'No agents in this group' : 'No agents yet'}
						description={
							scope.kind === 'group'
								? 'Pick another scope, or move an agent into this group. Who an agent can consult or delegate to is set on the Peers tab of its settings.'
								: 'This graph draws which agent can consult or delegate to which. Create an agent, then give it peers on the Peers tab of its settings.'
						}
					/>
				) : !isEditing ? (
					<MindMap
						key={scopeKey}
						theme={theme}
						nodes={mindMapData.nodes}
						links={mindMapData.links}
						centerFilePath={scope.kind === 'agent' ? scope.sessionId : model.nodes[0].sessionId}
						width={canvasWidth || 960}
						height={canvasHeight || 640}
						maxDepth={Math.max(1, model.nodes.length - 1)}
						showExternalLinks={false}
						showOrphans
						clusterAllNodes
						showClusters={layout !== 'manual'}
						nodeLabel="agent"
						selectCenterOnOpen={false}
						previewCharLimit={0}
						layoutType={isDelegationAlgorithmLayout(layout) ? layout : defaultLayout}
						nodePositions={canvasPositions}
						selectedNodeId={selectedId}
						onNodeSelect={(node) =>
							node
								? selectOnly(node.id)
								: commitNodes(nodesRef.current.map((item) => ({ ...item, selected: false })))
						}
						onNodeDoubleClick={(node) => changeScope({ kind: 'agent', sessionId: node.id })}
						onNodeContextMenu={(node, event) => {
							event.preventDefault();
							changeScope({ kind: 'agent', sessionId: node.id });
						}}
						onOpenFile={openPeersTab}
						onNodePositionChange={(_id, _position, allPositions) =>
							onNodesChange(
								model.nodes.flatMap((node): NodeChange[] => {
									const position = allPositions.get(node.sessionId);
									return position
										? [
												{
													id: node.sessionId,
													type: 'position',
													position: {
														x: position.x - estimateAgentDelegationNodeWidth(node.name) / 2,
														y: position.y - AGENT_DELEGATION_NODE_HEIGHT / 2,
													},
												},
											]
										: [];
								})
							)
						}
						searchQuery=""
						fitToken={fitRequest}
						legendExpanded={legend.value}
					/>
				) : (
					<ReactFlow
						nodes={displayNodes}
						edges={edges}
						nodeTypes={NODE_TYPES}
						edgeTypes={delegationEdgeTypes}
						onNodesChange={onNodesChange}
						// In View no edge can be started, and reactflow tells each node so
						// (`isConnectable`), which is what hides its handles.
						nodesConnectable={isEditing}
						// A connection is a question, not a change: it opens the editor
						// where it was dropped. A drag ends in `onConnectEnd`, and two
						// clicks on two handles end in `onClickConnectEnd`.
						onConnect={handleConnect}
						onConnectEnd={handleConnectEnd}
						onClickConnectEnd={handleConnectEnd}
						// An edge already drawn opens the same editor. In View no handler
						// is passed, and reactflow then takes no pointer event on an edge.
						onEdgeClick={isEditing ? handleEdgeClick : undefined}
						connectionLineStyle={connectionLineStyle}
						// In neither mode does a key remove anything: a node is an agent,
						// and an edge is removed through its editor, which says what the
						// removal writes.
						deleteKeyCode={null}
						// Dragging rearranges and clicking selects. A drag that also
						// selected would dim the rest of the graph under the pointer.
						selectNodesOnDrag={false}
						nodeDragThreshold={DRAG_THRESHOLD_PX}
						minZoom={0.1}
						maxZoom={2}
						fitView
						fitViewOptions={FIT_VIEW_OPTIONS}
						proOptions={PRO_OPTIONS}
						style={reactFlowStyle}
					>
						<Background color={colors.border} gap={20} />
						<Controls style={controlsStyle} showInteractive={false} />
						<MiniMap
							pannable
							zoomable
							style={miniMapStyle}
							maskColor={`${colors.bgMain}cc`}
							nodeColor={miniMapNodeColor}
						/>
					</ReactFlow>
				)}

				{/* Edit is armed: frame the canvas, so the mode shows where the pointer is. */}
				{isEditing && !isEmpty && (
					<div
						data-testid="delegation-graph-edit-frame"
						aria-hidden="true"
						className="absolute inset-0 pointer-events-none"
						style={{ zIndex: 4, boxShadow: `inset 0 0 0 2px ${colors.accent}` }}
					/>
				)}

				{!isEmpty && legend.value && (
					<DelegationGraphLegend theme={theme} stats={stats} onClose={legend.toggle} mode={mode} />
				)}

				{placedNames.length > 0 && (
					<DelegationPlacedNotice
						theme={theme}
						agentNames={placedNames}
						groupName={scopeGroupName}
						onClear={clearPlaced}
					/>
				)}
				{isDragOver && canPlace && draggingAgentName !== undefined && (
					<DelegationDropOverlay
						theme={theme}
						agentName={draggingAgentName}
						alreadyDrawn={model.nodes.some((node) => node.sessionId === draggingSessionId)}
						groupName={scopeGroupName}
					/>
				)}

				{/* Every agent is isolated: say so, and point at where peers are set. */}
				{noEdges && (
					<div
						data-testid="delegation-graph-no-edges"
						role="status"
						className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-start gap-2 rounded-lg shadow-lg px-3 py-2 text-xs select-text"
						style={{
							maxWidth: 420,
							zIndex: 5,
							backgroundColor: `${colors.bgActivity}f5`,
							border: `1px solid ${colors.warning}`,
							color: colors.textMain,
						}}
					>
						<Unplug className="w-4 h-4 shrink-0 mt-0.5" style={{ color: colors.warning }} />
						<div className="space-y-2">
							<p>
								No agent here can reach another, so there is nothing to draw between them. Who an
								agent can consult or delegate to is set on the Peers tab of its settings.
							</p>
							{peersTargetId && (
								<HeaderActionButton
									theme={theme}
									onClick={() => openPeersTab(peersTargetId)}
									icon={<Users />}
									testId="delegation-graph-no-edges-open-peers"
								>
									{peersTargetName ? `Open Peers tab of ${peersTargetName}` : 'Open Peers tab'}
								</HeaderActionButton>
							)}
						</div>
					</div>
				)}

				{edgeEditor && (
					<DelegationEdgeEditor
						// Keyed by the pair, so a second drop on another pair starts clean.
						key={delegationEdgeId(edgeEditor.sourceId, edgeEditor.targetId)}
						theme={theme}
						anchor={edgeEditor.anchor}
						sourceName={edgeEditor.sourceName}
						targetName={edgeEditor.targetName}
						existing={edgeEditor.existing}
						reverse={edgeEditor.reverse}
						onConfirm={confirmPendingEdge}
						onDelete={edgeEditor.existing ? deletePendingEdge : undefined}
						onClose={closePendingEdge}
					/>
				)}
				{pendingEdge?.kind === 'refused' && (
					<DelegationEdgeRefusal
						theme={theme}
						anchor={pendingEdge.anchor}
						message={pendingEdge.message}
						onClose={closePendingEdge}
					/>
				)}

				{!isEmpty && selectedId && (
					<DelegationGraphDetail
						theme={theme}
						model={model}
						sessionId={selectedId}
						onOpenPeers={openPeersTab}
						onClose={clearSelection}
					/>
				)}
			</div>

			{pendingChange && (
				<ConfirmModal
					theme={theme}
					title={pendingChange.kind === 'layout' ? 'Apply layout' : 'Reset layout'}
					message={
						pendingChange.kind === 'layout'
							? `Arrange this scope with the ${DELEGATION_LAYOUT_LABELS[pendingChange.layout].name} layout? Every agent moves, and the places you dragged them to are lost.`
							: `Forget where you placed the agents in this scope? The graph goes back to the ${DELEGATION_LAYOUT_LABELS[defaultLayout].name} layout.`
					}
					headerIcon={<RotateCcw className="w-4 h-4" style={{ color: colors.warning }} />}
					destructive={false}
					confirmLabel={
						pendingChange.kind === 'layout'
							? `Apply ${DELEGATION_LAYOUT_LABELS[pendingChange.layout].name}`
							: 'Reset'
					}
					onConfirm={confirmPendingChange}
					onClose={() => setPendingChange(null)}
					testId="delegation-graph-confirm"
				/>
			)}
		</div>
	);
}

export function DelegationGraphView(props: DelegationGraphViewProps) {
	return (
		<ReactFlowProvider>
			<DelegationGraphCanvas {...props} />
		</ReactFlowProvider>
	);
}
