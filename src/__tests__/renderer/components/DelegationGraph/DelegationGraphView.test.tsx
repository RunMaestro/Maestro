/**
 * Tests for DelegationGraphView - the Delegation Graph's canvas.
 *
 * The modules under the view have their own tests: the model
 * (`useDelegationGraphModel`), the arrangement (`delegationLayouts`), the saved
 * record (`useDelegationGraphLayout`), the node, the edge, the legend and the
 * selected-agent panel. What is pinned here is the wiring between them: what the
 * view hands the canvas, what a drag, a layout pick and a scope change write,
 * and what a remount reads back.
 *
 * reactflow cannot lay itself out in jsdom, so `<ReactFlow>` is replaced by a
 * stand-in that draws each node through the view's own `nodeTypes` (the real
 * `AgentDelegationNode`), draws each edge as a marker, and keeps the props it
 * was handed. A drag or a selection is then one call to the `onNodesChange` the
 * view passed, with the change reactflow would send. `applyNodeChanges` is the
 * real one. The stand-in tells each node whether it is connectable, as
 * reactflow does from `nodesConnectable`, and a handle is drawn as a marker that
 * carries what it was told. An edge dropped on an agent is the two calls
 * reactflow makes for one: `onConnect` with the pair, then `onConnectEnd` with
 * the pointer. A click on an edge is a click on its marker, which calls the
 * `onEdgeClick` the view passed, when it passed one.
 *
 * An agent row dragged from the Left Bar is `draggingSessionId` in the UI
 * store, which is all the Left Bar sets, and `dragover` / `drop` events on the
 * canvas. jsdom has no `DragEvent`, so the pointer is put on the event by hand.
 * The stand-in's `screenToFlowPosition` moves a point by `FLOW_OFFSET`, so a
 * position that skipped the conversion is not the one expected.
 */

import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { Connection, Edge, Node, NodeChange, NodeProps } from 'reactflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationEdgeData } from '../../../../renderer/components/DelegationGraph/edges/DelegationEdge';
import type { AgentDelegationNodeData } from '../../../../renderer/components/DelegationGraph/nodes/AgentDelegationNode';
import type { MindMapProps } from '../../../../renderer/components/DocumentGraph/MindMap';

const sharedCanvas = vi.hoisted(() => ({
	props: null as MindMapProps | null,
	positions: new Map<string, { x: number; y: number }>(),
}));

vi.mock('../../../../renderer/components/DocumentGraph/MindMap', async () => {
	const { calculateLayout, buildAdjacencyMap } =
		await import('../../../../renderer/components/DocumentGraph/mindMapLayouts');
	return {
		MindMap: (props: MindMapProps) => {
			if (!Number.isFinite(props.maxDepth)) throw new Error('Graph depth must be finite');
			sharedCanvas.props = props;
			flow.props = null;
			const result = calculateLayout(
				props.layoutType ?? 'hierarchical',
				props.nodes,
				props.links,
				buildAdjacencyMap(props.links),
				props.centerFilePath,
				props.maxDepth,
				props.width,
				props.height,
				props.showExternalLinks,
				props.previewCharLimit ?? 100,
				props.spacingScale ?? 1,
				props.showOrphans,
				props.clusterAllNodes
			);
			sharedCanvas.positions = new Map(
				result.nodes.map((node) => [
					node.id,
					props.nodePositions?.get(node.id) ?? { x: node.x, y: node.y },
				])
			);
			return (
				<div
					ref={props.containerRef}
					tabIndex={0}
					data-testid="document-graph-canvas"
					data-layout={props.layoutType}
				>
					{props.nodes.map((node) => (
						<button
							key={node.id}
							data-testid="flow-node"
							data-node-id={node.id}
							onClick={() => props.onNodeSelect(node)}
						>
							{node.label}
						</button>
					))}
					{props.links.map((link) => (
						<div
							key={`${link.source}->${link.target}`}
							data-testid="flow-edge"
							data-edge-id={`${link.source}->${link.target}`}
							data-source={link.source}
							data-target={link.target}
							data-openable="false"
						/>
					))}
				</div>
			);
		},
	};
});

/** What the view handed `<ReactFlow>` on its last render. */
interface FlowProps {
	nodes: Node<AgentDelegationNodeData>[];
	edges: Edge<DelegationEdgeData>[];
	nodeTypes: Record<string, ComponentType<NodeProps<AgentDelegationNodeData>>>;
	onNodesChange: (changes: NodeChange[]) => void;
	onConnect?: (connection: Connection) => void;
	onConnectEnd?: (event: MouseEvent | TouchEvent) => void;
	onClickConnectEnd?: (event: MouseEvent | TouchEvent) => void;
	onEdgeClick?: (event: ReactMouseEvent, edge: Edge<DelegationEdgeData>) => void;
	nodesConnectable?: boolean;
	deleteKeyCode?: string | null;
	zoomOnScroll?: boolean;
	panOnScroll?: boolean;
	// The ways reactflow removes a node or an edge. The view passes none of them.
	onNodesDelete?: unknown;
	onEdgesDelete?: unknown;
	onEdgesChange?: unknown;
	onEdgeUpdate?: unknown;
	onReconnect?: unknown;
	children?: ReactNode;
}

/**
 * The props through which reactflow takes a node or an edge away: the two
 * delete callbacks, the edge changes a controlled canvas applies, and the two
 * names of the handler that lets the end of an edge be dragged off its agent.
 */
const REMOVAL_PROPS = [
	'onNodesDelete',
	'onEdgesDelete',
	'onEdgesChange',
	'onEdgeUpdate',
	'onReconnect',
] as const;

const flow = vi.hoisted(() => ({
	props: null as FlowProps | null,
	fitView: vi.fn(),
	// Window to canvas coordinates: moved by FLOW_OFFSET.
	screenToFlowPosition: vi.fn((point: { x: number; y: number }) => ({
		x: point.x + 1000,
		y: point.y + 2000,
	})),
}));

const toast = vi.hoisted(() => ({ notify: vi.fn() }));

// The toast is what tells the user which of two writes a removal made. Its
// input is read here; the store behind it has its own test.
vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/stores/notificationStore')>()),
	notifyToast: toast.notify,
}));

vi.mock('reactflow', async (importOriginal) => {
	const actual = await importOriginal<typeof import('reactflow')>();
	// One object for the life of the file: the view re-arms its fit timer when
	// this reference changes.
	const api = { fitView: flow.fitView, screenToFlowPosition: flow.screenToFlowPosition };

	const ReactFlowStandIn = (props: FlowProps) => {
		flow.props = props;
		sharedCanvas.props = null;
		return (
			<div data-testid="react-flow">
				{props.nodes.map((node) => {
					const NodeComponent = props.nodeTypes[node.type ?? ''];
					const nodeProps = {
						id: node.id,
						type: node.type,
						data: node.data,
						selected: Boolean(node.selected),
						// reactflow derives a node's `isConnectable` from the canvas prop.
						isConnectable: props.nodesConnectable ?? true,
						xPos: node.position.x,
						yPos: node.position.y,
						zIndex: 0,
						dragging: false,
					} as NodeProps<AgentDelegationNodeData>;
					return (
						<div
							key={node.id}
							data-testid="flow-node"
							data-node-id={node.id}
							data-node-type={node.type}
							style={node.style}
						>
							<NodeComponent {...nodeProps} />
						</div>
					);
				})}
				{props.edges.map((edge) => (
					<div
						key={edge.id}
						data-testid="flow-edge"
						data-edge-id={edge.id}
						data-edge-type={edge.type}
						data-source={edge.source}
						data-target={edge.target}
						data-has-reverse={String(edge.data?.hasReverse)}
						data-emphasis={edge.data?.emphasis ?? 'none'}
						// The badge of the real edge is a button only while it has this.
						data-openable={String(Boolean(edge.data?.onOpen))}
						onClick={(event) => props.onEdgeClick?.(event, edge)}
					/>
				))}
				{props.children}
			</div>
		);
	};

	return {
		...actual,
		default: ReactFlowStandIn,
		ReactFlowProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
		useReactFlow: () => api,
		Background: () => null,
		Controls: () => null,
		MiniMap: () => null,
		// The real handle reads the node it belongs to from a mounted <ReactFlow>.
		Handle: ({ type, isConnectable }: { type: string; isConnectable?: boolean }) => (
			<span
				data-testid="flow-handle"
				data-handle-type={type}
				data-connectable={String(Boolean(isConnectable))}
			/>
		),
	};
});

import { DelegationGraphView } from '../../../../renderer/components/DelegationGraph/DelegationGraphView';
import { DELEGATION_LAYOUT_LABELS } from '../../../../renderer/components/DelegationGraph/delegationLayoutTypes';
import { placedAgentHint } from '../../../../renderer/components/DelegationGraph/DelegationGraphPlacement';
import {
	AGENT_DELEGATION_NODE_BORDER_STYLE,
	AGENT_DELEGATION_NODE_HEIGHT,
	AGENT_DELEGATION_SPILL_OPACITY,
	estimateAgentDelegationNodeWidth,
} from '../../../../renderer/components/DelegationGraph/nodes/AgentDelegationNode';
import { DELEGATION_POSITION_SAVE_DEBOUNCE_MS } from '../../../../renderer/components/DelegationGraph/useDelegationGraphLayout';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { DelegationGraphLayouts } from '../../../../renderer/stores/settingsDelegationGraphSlice';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import type { Group, Session } from '../../../../renderer/types';
import {
	buildDelegationGraph,
	delegationEdgeId,
	edgeBetween,
	isMutual,
	type DelegationGraphScope,
} from '../../../../shared/delegationGraph';
import {
	DELEGATION_GRAPH_LAYOUTS_SETTING,
	scopeStorageKey,
	type DelegationNodePosition,
	type DelegationSavedPositions,
} from '../../../../shared/delegationGraphLayout';
import {
	PEER_ACCESS_CONTROLS,
	PEER_GRANT_LABELS,
	PEER_NOTE_PLACEHOLDER,
	SELF_PEER_ERROR,
} from '../../../../shared/peerAgents';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

const PLATFORM: Group = { id: 'g-1', name: 'Platform', emoji: '', collapsed: false };
const RESEARCH: Group = { id: 'g-2', name: 'Research', emoji: '', collapsed: false };
/** A group with no agent in it. */
const VACANT: Group = { id: 'g-3', name: 'Vacant', emoji: '', collapsed: false };

const ALL: DelegationGraphScope = { kind: 'all' };
const PLATFORM_SCOPE: DelegationGraphScope = { kind: 'group', groupId: PLATFORM.id };
const RESEARCH_SCOPE: DelegationGraphScope = { kind: 'group', groupId: RESEARCH.id };
const ALL_KEY = scopeStorageKey(ALL);
const PLATFORM_KEY = scopeStorageKey(PLATFORM_SCOPE);

/**
 * Five agents and three edges:
 *
 *   Alpha (Platform) <-> Beta (Research)   a mutual pair
 *   Delta (no group)  -> Epsilon (Platform)
 *   Gamma (Research)                       reaches nobody, reached by nobody
 */
function fleet(): Session[] {
	return [
		createMockSession({
			id: 'a',
			name: 'Alpha',
			groupId: PLATFORM.id,
			peerAgents: [{ sessionId: 'b', read: true, write: true }],
		}),
		createMockSession({
			id: 'b',
			name: 'Beta',
			groupId: RESEARCH.id,
			peerAgents: [{ sessionId: 'a', read: true, write: false }],
		}),
		createMockSession({ id: 'c', name: 'Gamma', groupId: RESEARCH.id }),
		createMockSession({
			id: 'd',
			name: 'Delta',
			peerAgents: [{ sessionId: 'e', read: false, write: true }],
		}),
		createMockSession({ id: 'e', name: 'Epsilon', groupId: PLATFORM.id }),
	];
}

const ALL_IDS = ['a', 'b', 'c', 'd', 'e'];
/** The Platform graph: its two agents, and the two outside it that an edge reaches. */
const PLATFORM_IDS = ['a', 'b', 'd', 'e'];

/** Where the user left every agent on the graph of every agent. Far from the origin on purpose. */
const ALL_POSITIONS: DelegationSavedPositions = {
	a: { x: 2000, y: 2000 },
	b: { x: 2400, y: 2000 },
	c: { x: 2800, y: 2000 },
	d: { x: 2000, y: 2400 },
	e: { x: 2400, y: 2400 },
};
/** The same agents, somewhere else, on the Platform graph. */
const PLATFORM_POSITIONS: DelegationSavedPositions = {
	a: { x: 900, y: 900 },
	b: { x: 1300, y: 900 },
	d: { x: 900, y: 1200 },
	e: { x: 1300, y: 1200 },
};

const ORIGIN: DelegationNodePosition = { x: 0, y: 0 };
/** A place no layout puts an agent, so a node found there was dragged there. */
const DRAGGED: DelegationNodePosition = { x: 5120, y: 3840 };
/** Where in the window an edge is dropped. Inside the jsdom viewport, so it is not clamped. */
const DROP = { x: 300, y: 200 };
/** What the stand-in's `screenToFlowPosition` adds to a point of the window. */
const FLOW_OFFSET = { x: 1000, y: 2000 };

let initialMode: 'edit' | 'view' = 'edit';

function renderView(initialScope?: DelegationGraphScope) {
	const result = render(
		<LayerStackProvider>
			<DelegationGraphView theme={mockTheme} initialScope={initialScope} />
		</LayerStackProvider>
	);
	if (initialMode === 'edit') switchMode('edit');
	return result;
}

function layouts(): DelegationGraphLayouts {
	return useSettingsStore.getState().delegationGraphLayouts;
}

function saveLayouts(next: DelegationGraphLayouts): void {
	useSettingsStore.setState({ delegationGraphLayouts: next });
}

/** Every record sent to disk, oldest first. */
function diskWrites(): unknown[] {
	return vi
		.mocked(window.maestro.settings.set)
		.mock.calls.filter(([key]) => key === DELEGATION_GRAPH_LAYOUTS_SETTING)
		.map(([, value]) => value);
}

/** How many times the record was written to disk. */
function writeCount(): number {
	return diskWrites().length;
}

function nodeEl(id: string): HTMLElement {
	const el = screen
		.queryAllByTestId('flow-node')
		.find((candidate) => candidate.dataset.nodeId === id);
	if (!el) throw new Error(`no node is drawn for agent ${id}`);
	return el;
}

/** The node component's own root, inside the stand-in's wrapper. */
function nodeBody(id: string): HTMLElement {
	return within(nodeEl(id)).getByTestId('agent-delegation-node');
}

function edgeEl(id: string): HTMLElement {
	const el = screen
		.queryAllByTestId('flow-edge')
		.find((candidate) => candidate.dataset.edgeId === id);
	if (!el) throw new Error(`no edge is drawn for ${id}`);
	return el;
}

function drawnNodeIds(): string[] {
	return screen
		.queryAllByTestId('flow-node')
		.map((el) => el.dataset.nodeId ?? '')
		.sort();
}

function drawnEdgeIds(): string[] {
	return screen
		.queryAllByTestId('flow-edge')
		.map((el) => el.dataset.edgeId ?? '')
		.sort();
}

/**
 * Where the canvas was told to draw an agent. Read from the props and not from
 * the DOM, so the numbers are the ones the view passed and not a string of them.
 */
function positionOf(id: string): DelegationNodePosition {
	// Throws when the agent is not on screen, so a stale prop is never read.
	nodeEl(id);
	if (sharedCanvas.props) {
		const node = sharedCanvas.props.nodes.find((node) => node.id === id)!;
		const position = sharedCanvas.positions.get(id)!;
		return {
			x: position.x - estimateAgentDelegationNodeWidth(node.label) / 2,
			y: position.y - AGENT_DELEGATION_NODE_HEIGHT / 2,
		};
	}
	const node = flow.props?.nodes.find((candidate) => candidate.id === id);
	if (!node) throw new Error(`the canvas was handed no node for agent ${id}`);
	return { x: node.position.x, y: node.position.y };
}

function positionsOnCanvas(): DelegationSavedPositions {
	const positions: DelegationSavedPositions = {};
	for (const id of drawnNodeIds()) positions[id] = positionOf(id);
	return positions;
}

/** Move a node, with the change reactflow sends while one is dragged. */
function drag(id: string, to: DelegationNodePosition): void {
	act(() => {
		if (sharedCanvas.props) {
			const node = sharedCanvas.props.nodes.find((node) => node.id === id)!;
			const position = {
				x: to.x + estimateAgentDelegationNodeWidth(node.label) / 2,
				y: to.y + AGENT_DELEGATION_NODE_HEIGHT / 2,
			};
			const positions = new Map(sharedCanvas.positions);
			positions.set(id, position);
			sharedCanvas.props.onNodePositionChange?.(id, position, positions);
			return;
		}
		flow.props?.onNodesChange([{ type: 'position', id, position: to, dragging: true }]);
	});
}

/** Select a node, with the change reactflow sends for a click on one. */
function select(id: string): void {
	act(() => {
		if (sharedCanvas.props) {
			sharedCanvas.props.onNodeSelect(sharedCanvas.props.nodes.find((node) => node.id === id)!);
			return;
		}
		flow.props?.onNodesChange([{ type: 'select', id, selected: true }]);
	});
}

/** Let a waiting drag write land. */
function rest(): void {
	act(() => {
		vi.advanceTimersByTime(DELEGATION_POSITION_SAVE_DEBOUNCE_MS);
	});
}

function changeScope(key: string): void {
	fireEvent.change(screen.getByTestId('delegation-graph-scope'), { target: { value: key } });
}

function modeSegment(mode: 'view' | 'edit'): HTMLElement {
	return screen.getByTestId(`delegation-graph-mode-${mode}`);
}

function switchMode(mode: 'view' | 'edit'): void {
	fireEvent.click(modeSegment(mode));
}

/** Whether each handle drawn on the canvas was told an edge can start from it. */
function handleConnectability(): string[] {
	return screen.queryAllByTestId('flow-handle').map((el) => el.dataset.connectable ?? '');
}

/**
 * Drop an edge that was dragged from one agent onto another, with the two
 * calls reactflow makes: the connection, then the end of the gesture.
 */
function connect(source: string, target: string): void {
	act(() => {
		flow.props?.onConnect?.({ source, target, sourceHandle: null, targetHandle: null });
		flow.props?.onConnectEnd?.(new MouseEvent('mouseup', { clientX: DROP.x, clientY: DROP.y }));
	});
}

function edgeEditor(): HTMLElement | null {
	return screen.queryByTestId('delegation-edge-editor');
}

function accessSquare(bit: 'read' | 'write'): HTMLElement {
	return screen.getByRole('switch', { name: PEER_ACCESS_CONTROLS[bit].title });
}

function confirmEdge(): void {
	fireEvent.click(screen.getByTestId('delegation-edge-editor-confirm'));
}

/** Click the line of an edge that is drawn, at the drop point. */
function clickEdge(id: string): void {
	fireEvent.click(edgeEl(id), { clientX: DROP.x, clientY: DROP.y });
}

/** Open an edge through its badge, with the call the real edge makes. */
function openEdgeBadge(id: string): void {
	const edge = flow.props?.edges.find((candidate) => candidate.id === id);
	if (!edge?.data) throw new Error(`the canvas was handed no edge ${id}`);
	const { data } = edge;
	act(() => {
		data.onOpen?.(data.edge, DROP);
	});
}

function deleteEdgeButton(): HTMLElement | null {
	return screen.queryByTestId('delegation-edge-editor-delete');
}

/** The one toast a removal raised. */
function removalToast(): { color: string; title: string; message: string } {
	expect(toast.notify).toHaveBeenCalledTimes(1);
	return toast.notify.mock.calls[0][0];
}

function addAgentSelect(): HTMLSelectElement | null {
	return screen.queryByTestId('delegation-graph-add-agent') as HTMLSelectElement | null;
}

/** Pick an agent in the "Add agent" control. */
function addAgent(id: string): void {
	fireEvent.change(screen.getByTestId('delegation-graph-add-agent'), { target: { value: id } });
}

/** The agents the "Add agent" control offers, in its order. */
function addableIds(): string[] {
	return Array.from(addAgentSelect()?.querySelectorAll('option') ?? [])
		.map((option) => option.value)
		.filter(Boolean);
}

function canvas(): HTMLElement {
	return screen.getByTestId('delegation-graph-canvas');
}

/** What the Left Bar does when one of its agent rows starts to move, and when it stops. */
function startAgentDrag(id: string): void {
	act(() => useUIStore.setState({ draggingSessionId: id }));
}

function endAgentDrag(): void {
	act(() => useUIStore.setState({ draggingSessionId: null }));
}

/**
 * Fire a drag event on the canvas, with the pointer at `at`. Returns `false`
 * when the canvas took the event (it called `preventDefault`).
 */
function fireCanvasDrag(type: 'dragOver' | 'dragLeave' | 'drop', at = DROP): boolean {
	const event = createEvent[type](canvas(), { dataTransfer: {} });
	Object.defineProperties(event, { clientX: { value: at.x }, clientY: { value: at.y } });
	return fireEvent(canvas(), event);
}

function dropOverlay(): HTMLElement | null {
	return screen.queryByTestId('delegation-graph-drop-overlay');
}

function placedNotice(): HTMLElement | null {
	return screen.queryByTestId('delegation-graph-placed');
}

/** Let the fit that follows a rearrangement run. */
function settle(): void {
	act(() => {
		vi.advanceTimersByTime(1000);
	});
}

function patchSession(id: string, patch: Partial<Session>): void {
	setSessions((sessions) =>
		sessions.map((session) => (session.id === id ? { ...session, ...patch } : session))
	);
}

function sessionOf(id: string): Session {
	const session = useSessionStore.getState().sessions.find((candidate) => candidate.id === id);
	if (!session) throw new Error(`no agent ${id}`);
	return session;
}

/** The agents whose object is not the one in `before`: the agents a write replaced. */
function changedAgentIds(before: Session[]): string[] {
	return before
		.filter((session) => sessionOf(session.id) !== session)
		.map((session) => session.id)
		.sort();
}

function setSessions(update: (sessions: Session[]) => Session[]): void {
	act(() => {
		useSessionStore.setState((state) => ({ sessions: update(state.sessions) }));
	});
}

function distance(from: DelegationNodePosition, to: DelegationNodePosition): number {
	return Math.hypot(from.x - to.x, from.y - to.y);
}

describe('DelegationGraphView', () => {
	beforeEach(() => {
		initialMode = 'edit';
		sharedCanvas.props = null;
		vi.useFakeTimers();
		// The legend's open state is kept in localStorage. Without a Storage the
		// result differs between a local run and CI.
		installLocalStorageMock();
		flow.props = null;
		saveLayouts({});
		useSessionStore.setState({
			sessions: fleet(),
			groups: [PLATFORM, RESEARCH, VACANT],
			activeSessionId: 'a',
		});
		useModalStore.getState().closeAll();
		useUIStore.setState({ draggingSessionId: null });
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Document Graph shortcuts', () => {
		it.each(['metaKey', 'ctrlKey'] as const)(
			'toggles View and Edit with %s+E, consumes the chord and focuses the canvas',
			(modifier) => {
				initialMode = 'view';
				const sessionsBefore = useSessionStore.getState().sessions;
				renderView();
				const canvas = screen.getByTestId('document-graph-canvas');
				const event = createEvent.keyDown(canvas, { key: 'e', [modifier]: true });
				fireEvent(canvas, event);
				expect(event.defaultPrevented).toBe(true);
				expect(modeSegment('edit')).toHaveAttribute('aria-checked', 'true');
				expect(screen.getByTestId('delegation-graph-view')).toHaveFocus();
				fireEvent.keyDown(screen.getByTestId('delegation-graph-scope'), {
					key: 'E',
					[modifier]: true,
				});
				expect(modeSegment('view')).toHaveAttribute('aria-checked', 'true');
				expect(screen.getByTestId('document-graph-canvas')).toHaveFocus();
				expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			}
		);

		it('ignores plain E, repeated chords, other modifiers, composition and text editing', () => {
			renderView();
			const view = screen.getByTestId('delegation-graph-view');
			fireEvent.keyDown(view, { key: 'e' });
			for (const flag of ['repeat', 'shiftKey', 'altKey', 'isComposing']) {
				fireEvent.keyDown(view, { key: 'e', metaKey: true, [flag]: true });
			}
			const input = document.createElement('input');
			view.append(input);
			fireEvent.keyDown(input, { key: 'e', metaKey: true });
			expect(modeSegment('edit')).toHaveAttribute('aria-checked', 'true');
		});

		it('leaves a pending relationship open on Cmd+E', () => {
			renderView();
			connect('a', 'e');
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: 'e', metaKey: true });
			expect(edgeEditor()).toBeInTheDocument();
			expect(modeSegment('edit')).toHaveAttribute('aria-checked', 'true');
		});

		it('leaves a layout confirmation open on Cmd+E', () => {
			renderView();
			drag('a', DRAGGED);
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: 'l' });
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: 'e', metaKey: true });
			expect(screen.getByTestId('delegation-graph-confirm')).toBeInTheDocument();
			expect(modeSegment('edit')).toHaveAttribute('aria-checked', 'true');
		});

		it('focuses the replacement canvas after switching mode or scope', () => {
			renderView();
			expect(screen.getByTestId('delegation-graph-view')).toHaveFocus();
			switchMode('view');
			expect(screen.getByTestId('document-graph-canvas')).toHaveFocus();
			changeScope(PLATFORM_KEY);
			expect(screen.getByTestId('document-graph-canvas')).toHaveFocus();
		});

		it.each(['view', 'edit'] as const)('cycles all layouts and wraps in %s mode', (mode) => {
			initialMode = mode;
			renderView();
			const view = screen.getByTestId('delegation-graph-view');
			for (const layout of ['hierarchical', 'force', 'radial', 'mindmap', 'lobes']) {
				fireEvent.keyDown(view, { key: 'l' });
				expect(layouts()[ALL_KEY].layout).toBe(layout);
			}
		});

		it('uses the same hand-placement confirmation for L as the layout buttons', () => {
			renderView();
			drag('a', DRAGGED);
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: 'L' });
			expect(screen.getByTestId('delegation-graph-confirm')).toBeInTheDocument();
			expect(layouts()[ALL_KEY].layout).toBe('manual');
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: 'l' });
			expect(layouts()[ALL_KEY].positions.a).toEqual(DRAGGED);
		});

		it('leaves selectors, text inputs, modified keys and composition alone', () => {
			renderView();
			const view = screen.getByTestId('delegation-graph-view');
			fireEvent.keyDown(screen.getByTestId('delegation-graph-scope'), { key: 'l' });
			const input = document.createElement('input');
			view.append(input);
			fireEvent.keyDown(input, { key: 'l' });
			for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'isComposing']) {
				fireEvent.keyDown(view, { key: 'l', [modifier]: true });
			}
			expect(layouts()[ALL_KEY]).toBeUndefined();
		});

		it('fits on F and persists scroll mode across view and edit', () => {
			renderView();
			act(() => vi.advanceTimersByTime(200));
			flow.fitView.mockClear();
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: 'f' });
			act(() => vi.advanceTimersByTime(200));
			expect(flow.fitView).toHaveBeenCalledTimes(1);
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: 's' });
			expect(flow.props?.panOnScroll).toBe(true);
			expect(flow.props?.zoomOnScroll).toBe(false);
			switchMode('view');
			expect(sharedCanvas.props?.scrollMode).toBe('pan');
			const before = sharedCanvas.props?.fitToken;
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: 'F' });
			expect(sharedCanvas.props?.fitToken).toBe((before ?? 0) + 1);
		});

		it('reverses scroll behavior on Shift inside the modal and clears it on blur', () => {
			renderView();
			const view = screen.getByTestId('delegation-graph-view');
			expect(flow.props?.zoomOnScroll).toBe(true);
			fireEvent.keyDown(view, { key: 'Shift', shiftKey: true });
			expect(flow.props?.panOnScroll).toBe(true);
			fireEvent.keyUp(view, { key: 'Shift', shiftKey: false });
			expect(flow.props?.zoomOnScroll).toBe(true);
			fireEvent.keyDown(view, { key: 's' });
			fireEvent.keyDown(view, { key: 'Shift', shiftKey: true });
			expect(flow.props?.zoomOnScroll).toBe(true);
			fireEvent.blur(window);
			expect(flow.props?.panOnScroll).toBe(true);
		});

		it('changes spacing in View and Edit without changing peer rosters', () => {
			initialMode = 'view';
			renderView();
			const sessions = useSessionStore.getState().sessions;
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: '+' });
			expect(sharedCanvas.props?.spacingScale).toBe(1.1);
			switchMode('edit');
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: '=' });
			expect(layouts()[ALL_KEY].layout).toBe('lobes');
			expect(Object.keys(layouts()[ALL_KEY].positions).sort()).toEqual(ALL_IDS);
			expect(useSessionStore.getState().sessions).toBe(sessions);
		});

		it('resizes manual placement without replacing it with an algorithm', () => {
			renderView();
			drag('a', DRAGGED);
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: '+' });
			rest();
			expect(layouts()[ALL_KEY].layout).toBe('manual');
			expect(layouts()[ALL_KEY].positions.a.x).toBeGreaterThan(DRAGGED.x);
			fireEvent.keyDown(screen.getByTestId('delegation-graph-view'), { key: '-' });
			rest();
			expect(layouts()[ALL_KEY].positions.a.x).toBeCloseTo(DRAGGED.x);
		});
	});

	describe('what it draws', () => {
		it('draws one node per model node and one edge per model edge', () => {
			const model = buildDelegationGraph(ALL, useSessionStore.getState().sessions);

			renderView();

			expect(drawnNodeIds()).toEqual(model.nodes.map((node) => node.sessionId).sort());
			expect(drawnEdgeIds()).toEqual(model.edges.map((edge) => edge.id).sort());
			expect(drawnNodeIds()).toEqual(ALL_IDS);
			expect(drawnEdgeIds()).toEqual(['a->b', 'b->a', 'd->e']);
		});

		it('draws the graph of one group: its agents, and the agents its edges reach', () => {
			const model = buildDelegationGraph(PLATFORM_SCOPE, useSessionStore.getState().sessions);

			renderView(PLATFORM_SCOPE);

			expect(drawnNodeIds()).toEqual(model.nodes.map((node) => node.sessionId).sort());
			expect(drawnEdgeIds()).toEqual(model.edges.map((edge) => edge.id).sort());
			// Gamma is in Research and no edge joins it to Platform.
			expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
		});

		it('joins each edge to the agents it runs between', () => {
			renderView();

			expect(edgeEl('d->e').dataset.source).toBe('d');
			expect(edgeEl('d->e').dataset.target).toBe('e');
			expect(edgeEl('b->a').dataset.source).toBe('b');
			expect(edgeEl('b->a').dataset.target).toBe('a');
		});

		// The edge component draws a mutual pair as two lanes, and it is told
		// which edges are half of one by this flag alone.
		it('tells both edges of a mutual pair that the other exists, and a one-way edge that it is alone', () => {
			renderView();

			expect(edgeEl('a->b').dataset.hasReverse).toBe('true');
			expect(edgeEl('b->a').dataset.hasReverse).toBe('true');
			expect(edgeEl('d->e').dataset.hasReverse).toBe('false');
		});

		it('draws every node and edge with the delegation components', () => {
			renderView();

			for (const el of screen.getAllByTestId('flow-node')) {
				expect(el.dataset.nodeType).toBe('agent');
			}
			for (const el of screen.getAllByTestId('flow-edge')) {
				expect(el.dataset.edgeType).toBe('delegation');
			}
		});
	});

	describe('hiding unconnected agents', () => {
		it.each(['view', 'edit'] as const)(
			'filters and restores agents in %s without changing relationships',
			(mode) => {
				initialMode = mode;
				const sessions = useSessionStore.getState().sessions;
				renderView();
				const toggle = screen.getByRole('switch', { name: 'Hide unconnected' });
				expect(toggle).toHaveAttribute('aria-checked', 'false');

				fireEvent.click(toggle);

				expect(toggle).toHaveAttribute('aria-checked', 'true');
				expect(drawnNodeIds()).toEqual(['a', 'b', 'd', 'e']);
				expect(drawnEdgeIds()).toEqual(['a->b', 'b->a', 'd->e']);
				if (mode === 'view') expect(sharedCanvas.props?.fitToken).toBeGreaterThan(0);
				expect(useSessionStore.getState().sessions).toBe(sessions);
				expect(writeCount()).toBe(0);

				fireEvent.click(toggle);
				expect(drawnNodeIds()).toEqual(ALL_IDS);
			}
		);

		it('remembers the filter across scopes and reopening', () => {
			const first = renderView();
			fireEvent.click(screen.getByRole('switch', { name: 'Hide unconnected' }));
			changeScope(scopeStorageKey(RESEARCH_SCOPE));
			expect(drawnNodeIds()).toEqual(['a', 'b']);
			first.unmount();

			renderView();
			expect(screen.getByRole('switch', { name: 'Hide unconnected' })).toHaveAttribute(
				'aria-checked',
				'true'
			);
			expect(drawnNodeIds()).toEqual(['a', 'b', 'd', 'e']);
		});

		it('updates the filter when incoming relationships are added and removed', () => {
			renderView();
			fireEvent.click(screen.getByRole('switch', { name: 'Hide unconnected' }));
			patchSession('a', {
				peerAgents: [...sessionOf('a').peerAgents!, { sessionId: 'c', read: true, write: false }],
			});
			expect(drawnNodeIds()).toEqual(ALL_IDS);
			patchSession('a', { peerAgents: [{ sessionId: 'b', read: true, write: true }] });
			expect(drawnNodeIds()).toEqual(['a', 'b', 'd', 'e']);
		});

		it('keeps an agent added in Edit visible until switching to View', () => {
			renderView();
			fireEvent.click(screen.getByRole('switch', { name: 'Hide unconnected' }));
			expect(addableIds()).toEqual(['c']);
			fireEvent.change(addAgentSelect()!, { target: { value: 'c' } });
			expect(drawnNodeIds()).toEqual(ALL_IDS);
			switchMode('view');
			expect(drawnNodeIds()).toEqual(['a', 'b', 'd', 'e']);
		});

		it('lets the user add an endpoint in Edit when every agent is hidden', () => {
			useSessionStore.setState({ sessions: [createMockSession({ id: 'c', name: 'Gamma' })] });
			renderView();
			fireEvent.click(screen.getByRole('switch', { name: 'Hide unconnected' }));
			expect(drawnNodeIds()).toEqual([]);
			expect(addableIds()).toEqual(['c']);
			expect(addAgentSelect()).not.toBeDisabled();

			fireEvent.change(addAgentSelect()!, { target: { value: 'c' } });

			expect(drawnNodeIds()).toEqual(['c']);
			expect(drawnEdgeIds()).toEqual([]);
			expect(writeCount()).toBe(0);
		});

		it('explains when every agent is hidden and lets the user restore them', () => {
			useSessionStore.setState({ sessions: [createMockSession({ id: 'c', name: 'Gamma' })] });
			renderView();
			fireEvent.click(screen.getByRole('switch', { name: 'Hide unconnected' }));
			expect(screen.getByText('No connected agents')).toBeInTheDocument();
			expect(screen.getByText(/Turn off Hide unconnected/)).toBeInTheDocument();
			expect(screen.getByTestId('delegation-graph-fit')).toBeDisabled();
			expect(drawnNodeIds()).toEqual([]);
			fireEvent.click(screen.getByRole('switch', { name: 'Hide unconnected' }));
			expect(drawnNodeIds()).toEqual(['c']);
		});
	});

	describe('shared Document Graph canvas', () => {
		beforeEach(() => {
			initialMode = 'view';
		});

		it('opens the global graph in Lobes with directed agent links and disconnected clusters', () => {
			renderView();
			expect(screen.getByTestId('document-graph-canvas')).toHaveAttribute('data-layout', 'lobes');
			expect(screen.queryByTestId('react-flow')).toBeNull();
			expect(sharedCanvas.props?.clusterAllNodes).toBe(true);
			expect(sharedCanvas.props?.maxDepth).toBe(ALL_IDS.length - 1);
			expect(sharedCanvas.props?.nodeLabel).toBe('agent');
			expect(sharedCanvas.props?.links.every((link) => link.directed)).toBe(true);
			expect(drawnNodeIds()).toEqual(ALL_IDS);
		});

		it('opens an agent cluster in Hierarchical and returns to the global Lobes view', () => {
			renderView({ kind: 'agent', sessionId: 'a' });
			expect(drawnNodeIds()).toEqual(['a', 'b']);
			expect(sharedCanvas.props?.layoutType).toBe('hierarchical');
			fireEvent.click(screen.getByRole('button', { name: 'Show all agents' }));
			expect(drawnNodeIds()).toEqual(ALL_IDS);
			expect(sharedCanvas.props?.layoutType).toBe('lobes');
		});

		it('can isolate the selected cluster from the global view', () => {
			renderView();
			select('d');
			fireEvent.click(screen.getByRole('button', { name: 'Show cluster' }));
			expect(drawnNodeIds()).toEqual(['d', 'e']);
			expect(sharedCanvas.props?.layoutType).toBe('hierarchical');
		});
		it('returns to all agents if the cluster anchor is deleted', () => {
			renderView({ kind: 'agent', sessionId: 'a' });
			setSessions((sessions) => sessions.filter((session) => session.id !== 'a'));
			expect(drawnNodeIds()).toEqual(ALL_IDS.filter((id) => id !== 'a'));
			expect(sharedCanvas.props?.layoutType).toBe('lobes');
		});

		it('offers the shared layout choices and keeps the chosen layout per scope', () => {
			renderView();
			fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), {
				target: { value: 'mindmap' },
			});
			expect(sharedCanvas.props?.layoutType).toBe('mindmap');
			changeScope(PLATFORM_KEY);
			expect(sharedCanvas.props?.layoutType).toBe('hierarchical');
			changeScope(ALL_KEY);
			expect(sharedCanvas.props?.layoutType).toBe('mindmap');
		});
	});

	// The guard between looking at the graph and rewriting an agent's permissions.
	describe('mode', () => {
		beforeEach(() => {
			initialMode = 'view';
		});
		it('opens in View: no edge can be started and no key removes anything', () => {
			renderView();

			expect(modeSegment('view')).toHaveAttribute('aria-checked', 'true');
			expect(modeSegment('edit')).toHaveAttribute('aria-checked', 'false');
			expect(screen.getByTestId('delegation-graph-canvas')).toHaveAttribute('data-mode', 'view');
			expect(sharedCanvas.props).not.toBeNull();
			expect(screen.queryByTestId('react-flow')).toBeNull();
		});

		it('gives no node a connectable handle in View', () => {
			renderView();

			expect(handleConnectability()).toEqual([]);
		});

		it('lets an edge be started in Edit, from every node', () => {
			renderView();

			switchMode('edit');

			expect(modeSegment('edit')).toHaveAttribute('aria-checked', 'true');
			expect(modeSegment('view')).toHaveAttribute('aria-checked', 'false');
			expect(screen.getByTestId('delegation-graph-canvas')).toHaveAttribute('data-mode', 'edit');
			expect(flow.props?.nodesConnectable).toBe(true);
			expect(new Set(handleConnectability())).toEqual(new Set(['true']));
		});

		// A node is an agent. An edge is removed through its editor, never by a key.
		it('lets no key remove anything in Edit either', () => {
			renderView();

			switchMode('edit');

			expect(flow.props?.deleteKeyCode).toBeNull();
		});

		// reactflow lets the end of an edge be dragged off its agent, which deletes
		// the edge, only when it is handed a handler for it. It is handed none, and
		// no delete callback either, so an edge has one way out: its editor.
		it('hands the canvas no way to drag an edge off or delete anything, in either mode', () => {
			renderView();

			for (const mode of ['view', 'edit', 'view'] as const) {
				switchMode(mode);
				for (const prop of REMOVAL_PROPS) {
					expect(flow.props?.[prop], `${prop} in ${mode}`).toBeUndefined();
				}
				expect(flow.props?.deleteKeyCode ?? null).toBeNull();
			}
		});

		// A drag in View is a layout gesture and nothing else.
		it('moves an agent in View and writes to no roster', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();

			drag('a', DRAGGED);
			rest();

			expect(layouts()[ALL_KEY].positions.a).toEqual(DRAGGED);
			expect(sharedCanvas.props?.showClusters).toBe(false);
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			expect(drawnEdgeIds()).toEqual(['a->b', 'b->a', 'd->e']);
			expect(edgeEditor()).not.toBeInTheDocument();
		});

		it('disarms the canvas on the way back to View', () => {
			renderView();

			switchMode('edit');
			switchMode('view');

			expect(modeSegment('view')).toHaveAttribute('aria-checked', 'true');
			expect(sharedCanvas.props).not.toBeNull();
			expect(handleConnectability()).toEqual([]);
		});

		it('frames the canvas only while Edit is on', () => {
			renderView();
			expect(screen.queryByTestId('delegation-graph-edit-frame')).not.toBeInTheDocument();

			switchMode('edit');
			expect(screen.getByTestId('delegation-graph-edit-frame')).toBeInTheDocument();

			switchMode('view');
			expect(screen.queryByTestId('delegation-graph-edit-frame')).not.toBeInTheDocument();
		});

		it('changes no roster and no saved arrangement when the mode changes', () => {
			saveLayouts({ [ALL_KEY]: { layout: 'manual', positions: ALL_POSITIONS } });
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();

			switchMode('edit');
			switchMode('view');
			rest();

			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			expect(layouts()).toEqual({ [ALL_KEY]: { layout: 'manual', positions: ALL_POSITIONS } });
			expect(writeCount()).toBe(0);
			expect(positionsOnCanvas()).toEqual(ALL_POSITIONS);
		});

		it('still rearranges in Edit: a drag saves where the agent was left', () => {
			renderView();

			switchMode('edit');
			drag('a', DRAGGED);
			rest();

			expect(layouts()[ALL_KEY].layout).toBe('manual');
			expect(layouts()[ALL_KEY].positions.a).toEqual(DRAGGED);
		});

		it('keeps the mode across a change of scope', () => {
			renderView();

			switchMode('edit');
			changeScope(PLATFORM_KEY);

			expect(modeSegment('edit')).toHaveAttribute('aria-checked', 'true');
			expect(flow.props?.nodesConnectable).toBe(true);
		});

		// The mode is not saved, so a graph can never open already armed.
		it('opens in View again after it was closed in Edit', () => {
			const first = renderView();
			switchMode('edit');
			first.unmount();

			renderView();

			expect(modeSegment('view')).toHaveAttribute('aria-checked', 'true');
			expect(sharedCanvas.props).not.toBeNull();
		});

		it('offers the switch on a scope with no agents, with nothing to frame', () => {
			renderView({ kind: 'group', groupId: VACANT.id });

			switchMode('edit');

			expect(screen.getByTestId('delegation-graph-canvas')).toHaveAttribute('data-mode', 'edit');
			expect(screen.queryByTestId('delegation-graph-edit-frame')).not.toBeInTheDocument();
		});
	});

	describe('drawing an edge', () => {
		it('opens the editor where the edge was dropped, and writes nothing yet', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('edit');

			connect('c', 'e');

			const editor = screen.getByRole('dialog', { name: 'Edge from Gamma to Epsilon' });
			expect(editor.style.left).toBe(`${DROP.x}px`);
			expect(editor.style.top).toBe(`${DROP.y}px`);
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			expect(drawnEdgeIds()).not.toContain(delegationEdgeId('c', 'e'));
		});

		it('writes exactly one row, into the agent the edge starts from, on confirm', () => {
			renderView();
			switchMode('edit');
			const epsilonBefore = sessionOf('e');
			const before = useSessionStore.getState().sessions;

			connect('c', 'e');
			confirmEdge();

			expect(sessionOf('c').peerAgents).toEqual([{ sessionId: 'e', read: true, write: false }]);
			// The agent the edge ends on is the same object: nothing was written to it.
			expect(sessionOf('e')).toBe(epsilonBefore);
			// Nor to any other agent. Gamma is the one object that was replaced.
			expect(changedAgentIds(before)).toEqual(['c']);
			expect(drawnEdgeIds()).toContain(delegationEdgeId('c', 'e'));
			expect(edgeEditor()).not.toBeInTheDocument();
			// Gamma was isolated until this edge.
			expect(nodeBody('c')).toHaveAttribute('data-node-state', 'in-scope');
		});

		it('writes the bits and the note the editor holds', () => {
			renderView();
			switchMode('edit');

			connect('c', 'e');
			fireEvent.click(accessSquare('write'));
			fireEvent.click(accessSquare('read'));
			fireEvent.change(screen.getByPlaceholderText(PEER_NOTE_PLACEHOLDER), {
				target: { value: 'Runs the deploys' },
			});
			confirmEdge();

			expect(sessionOf('c').peerAgents).toEqual([
				{ sessionId: 'e', read: false, write: true, description: 'Runs the deploys' },
			]);
		});

		it('writes nothing when the editor is cancelled', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('edit');

			connect('c', 'e');
			fireEvent.click(screen.getByTestId('delegation-edge-editor-cancel'));

			expect(edgeEditor()).not.toBeInTheDocument();
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
		});

		it('will not commit an edge with neither bit', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('edit');

			connect('c', 'e');
			fireEvent.click(accessSquare('read'));

			expect(screen.getByTestId('delegation-edge-editor-confirm')).toBeDisabled();
			confirmEdge();
			expect(edgeEditor()).toBeInTheDocument();
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
		});

		it('refuses an agent dropped on itself, in words, and writes no row', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('edit');

			connect('c', 'c');

			expect(screen.getByTestId('delegation-edge-refusal')).toHaveTextContent(SELF_PEER_ERROR);
			expect(edgeEditor()).not.toBeInTheDocument();
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);

			fireEvent.click(screen.getByRole('button', { name: 'Close' }));
			expect(screen.queryByTestId('delegation-edge-refusal')).not.toBeInTheDocument();
		});

		it('edits the edge in place when the direction is drawn again', () => {
			renderView();
			switchMode('edit');

			connect('a', 'b');

			// Alpha already consults and delegates to Beta: the editor opens on that.
			expect(accessSquare('read')).toHaveAttribute('aria-checked', 'true');
			expect(accessSquare('write')).toHaveAttribute('aria-checked', 'true');
			expect(screen.getByTestId('delegation-edge-editor-confirm')).toHaveTextContent('Save edge');

			fireEvent.click(accessSquare('write'));
			confirmEdge();

			expect(sessionOf('a').peerAgents).toEqual([{ sessionId: 'b', read: true, write: false }]);
			expect(drawnEdgeIds().filter((id) => id === delegationEdgeId('a', 'b'))).toHaveLength(1);
		});

		it('says the reverse edge exists, mirrors nothing, and keeps both edges', () => {
			renderView();
			switchMode('edit');
			const deltaBefore = sessionOf('d');

			connect('e', 'd');

			expect(screen.getByTestId('delegation-edge-editor-reverse')).toHaveTextContent(
				'Delta may already delegate to Epsilon'
			);
			// Delta delegates. The new edge is not handed that bit.
			expect(accessSquare('write')).toHaveAttribute('aria-checked', 'false');

			confirmEdge();

			expect(sessionOf('d')).toBe(deltaBefore);
			expect(sessionOf('e').peerAgents).toEqual([{ sessionId: 'd', read: true, write: false }]);
			const model = buildDelegationGraph(ALL, useSessionStore.getState().sessions);
			expect(isMutual(model, 'd', 'e')).toBe(true);
			expect(edgeEl(delegationEdgeId('d', 'e')).dataset.hasReverse).toBe('true');
			expect(edgeEl(delegationEdgeId('e', 'd')).dataset.hasReverse).toBe('true');
		});

		// The manager delegates down and the employee only consults up. Two
		// gestures, two rows, and the second gesture leaves the first row alone.
		it('builds a manager and employee pair in two gestures, and neither undoes the other', () => {
			renderView();
			switchMode('edit');
			const before = useSessionStore.getState().sessions;

			// Gamma, the manager, delegates to Epsilon and does not consult it.
			connect('c', 'e');
			fireEvent.click(accessSquare('write'));
			fireEvent.click(accessSquare('read'));
			confirmEdge();
			const managerAfterFirst = sessionOf('c');
			expect(changedAgentIds(before)).toEqual(['c']);

			// Epsilon, the employee, consults Gamma and does not delegate to it.
			connect('e', 'c');
			expect(screen.getByTestId('delegation-edge-editor-reverse')).toHaveTextContent(
				'Gamma may already delegate to Epsilon'
			);
			confirmEdge();

			// The second gesture wrote to Epsilon only: Gamma is the object the first one left.
			expect(sessionOf('c')).toBe(managerAfterFirst);
			expect(sessionOf('c').peerAgents).toEqual([{ sessionId: 'e', read: false, write: true }]);
			expect(sessionOf('e').peerAgents).toEqual([{ sessionId: 'c', read: true, write: false }]);
			expect(changedAgentIds(before)).toEqual(['c', 'e']);

			const model = buildDelegationGraph(ALL, useSessionStore.getState().sessions);
			expect(isMutual(model, 'c', 'e')).toBe(true);
			expect(edgeBetween(model, 'c', 'e')).toMatchObject({ read: false, write: true });
			expect(edgeBetween(model, 'e', 'c')).toMatchObject({ read: true, write: false });
			expect(drawnEdgeIds()).toEqual(['a->b', 'b->a', 'c->e', 'd->e', 'e->c']);
		});

		it('turns an edge a grant derived into a row, and leaves the grant alone', () => {
			setSessions((sessions) =>
				sessions.map((session) =>
					session.id === 'e'
						? { ...session, groupPeerAccess: { read: true, write: false } }
						: session
				)
			);
			renderView();
			switchMode('edit');

			// Epsilon reaches Alpha through its group grant.
			connect('e', 'a');

			expect(screen.getByTestId('delegation-edge-editor-existing')).toHaveTextContent(
				PEER_GRANT_LABELS.group
			);
			fireEvent.click(accessSquare('write'));
			confirmEdge();

			expect(sessionOf('e').peerAgents).toEqual([{ sessionId: 'a', read: true, write: true }]);
			expect(sessionOf('e').groupPeerAccess).toEqual({ read: true, write: false });
		});

		it('draws an edge to an agent outside the group without moving that agent into it', () => {
			renderView(PLATFORM_SCOPE);
			switchMode('edit');

			connect('e', 'b');
			confirmEdge();

			expect(drawnEdgeIds()).toContain(delegationEdgeId('e', 'b'));
			expect(nodeBody('b')).toHaveAttribute('data-node-state', 'spill');
			expect(sessionOf('b').groupId).toBe(RESEARCH.id);
		});

		it('refuses an edge between two agents outside the group, which this graph would not draw', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView(PLATFORM_SCOPE);
			switchMode('edit');

			connect('b', 'd');

			expect(screen.getByTestId('delegation-edge-refusal')).toHaveTextContent('outside this group');
			expect(edgeEditor()).not.toBeInTheDocument();
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
		});

		it('opens nothing and writes nothing for a connection made in View', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('view');

			connect('c', 'e');

			expect(edgeEditor()).not.toBeInTheDocument();
			expect(screen.queryByTestId('delegation-edge-refusal')).not.toBeInTheDocument();
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
		});

		it('ignores the end of a gesture that connected nothing', () => {
			renderView();
			switchMode('edit');

			act(() => {
				flow.props?.onConnectEnd?.(new MouseEvent('mouseup', { clientX: DROP.x, clientY: DROP.y }));
			});

			expect(edgeEditor()).not.toBeInTheDocument();
		});

		it('discards an unconfirmed edge on the way back to View', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('edit');

			connect('c', 'e');
			switchMode('view');

			expect(edgeEditor()).not.toBeInTheDocument();
			switchMode('edit');
			expect(edgeEditor()).not.toBeInTheDocument();
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
		});

		it('discards an unconfirmed edge when the scope changes', () => {
			renderView();
			switchMode('edit');

			connect('a', 'e');
			changeScope(PLATFORM_KEY);

			expect(edgeEditor()).not.toBeInTheDocument();
		});

		it('closes the editor when one of its two agents is deleted', () => {
			renderView();
			switchMode('edit');

			connect('c', 'e');
			setSessions((sessions) => sessions.filter((session) => session.id !== 'e'));

			expect(edgeEditor()).not.toBeInTheDocument();
		});

		it('closes the editor on Escape and leaves the graph in Edit', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('edit');

			connect('c', 'e');
			fireEvent.keyDown(window, { key: 'Escape' });

			expect(edgeEditor()).not.toBeInTheDocument();
			expect(modeSegment('edit')).toHaveAttribute('aria-checked', 'true');
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
		});
	});

	describe('editing and deleting an edge', () => {
		it('opens the editor on a clicked edge, pre-filled, where it was clicked, and writes nothing', () => {
			patchSession('a', {
				peerAgents: [{ sessionId: 'b', read: true, write: true, description: 'Owns research' }],
			});
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('edit');

			clickEdge('a->b');

			const editor = screen.getByRole('dialog', { name: 'Edge from Alpha to Beta' });
			expect(editor.style.left).toBe(`${DROP.x}px`);
			expect(editor.style.top).toBe(`${DROP.y}px`);
			expect(accessSquare('read')).toHaveAttribute('aria-checked', 'true');
			expect(accessSquare('write')).toHaveAttribute('aria-checked', 'true');
			expect(screen.getByPlaceholderText(PEER_NOTE_PLACEHOLDER)).toHaveValue('Owns research');
			expect(screen.getByTestId('delegation-edge-editor-confirm')).toHaveTextContent('Save edge');
			expect(deleteEdgeButton()).toHaveTextContent('Delete edge');
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			expect(toast.notify).not.toHaveBeenCalled();
		});

		it('opens the same editor from the badge of an edge', () => {
			renderView();
			switchMode('edit');

			openEdgeBadge('d->e');

			expect(
				screen.getByRole('dialog', { name: 'Edge from Delta to Epsilon' })
			).toBeInTheDocument();
			expect(accessSquare('read')).toHaveAttribute('aria-checked', 'false');
			expect(accessSquare('write')).toHaveAttribute('aria-checked', 'true');
		});

		// The guard: in View an edge has no way in at all.
		it('gives no edge a way in while the graph is in View', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('view');

			expect(flow.props?.onEdgeClick).toBeUndefined();
			for (const el of screen.getAllByTestId('flow-edge')) {
				expect(el.dataset.openable).toBe('false');
			}
			clickEdge('a->b');

			expect(edgeEditor()).not.toBeInTheDocument();
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
		});

		it('takes the way in away again on the way back to View', () => {
			renderView();
			switchMode('edit');
			expect(flow.props?.onEdgeClick).toBeTypeOf('function');
			expect(edgeEl('a->b').dataset.openable).toBe('true');

			switchMode('view');

			expect(flow.props?.onEdgeClick).toBeUndefined();
			expect(edgeEl('a->b').dataset.openable).toBe('false');
		});

		it('raises the edge the editor is about, and lets it go when the editor closes', () => {
			renderView();
			switchMode('edit');

			clickEdge('a->b');

			expect(edgeEl('a->b').dataset.emphasis).toBe('highlighted');
			expect(edgeEl('b->a').dataset.emphasis).toBe('none');
			expect(edgeEl('d->e').dataset.emphasis).toBe('none');

			fireEvent.click(screen.getByTestId('delegation-edge-editor-cancel'));

			expect(edgeEl('a->b').dataset.emphasis).toBe('none');
		});

		it('starts clean when another edge is clicked under an open editor', () => {
			renderView();
			switchMode('edit');

			clickEdge('a->b');
			fireEvent.click(accessSquare('read'));
			clickEdge('d->e');

			expect(
				screen.getByRole('dialog', { name: 'Edge from Delta to Epsilon' })
			).toBeInTheDocument();
			expect(screen.queryByRole('dialog', { name: 'Edge from Alpha to Beta' })).toBeNull();
			expect(accessSquare('read')).toHaveAttribute('aria-checked', 'false');
			expect(accessSquare('write')).toHaveAttribute('aria-checked', 'true');
		});

		it('saves a changed edge in place, with no toast', () => {
			renderView();
			switchMode('edit');
			const betaBefore = sessionOf('b');

			clickEdge('a->b');
			fireEvent.click(accessSquare('read'));
			confirmEdge();

			expect(sessionOf('a').peerAgents).toEqual([{ sessionId: 'b', read: false, write: true }]);
			expect(sessionOf('b')).toBe(betaBefore);
			expect(drawnEdgeIds().filter((id) => id === 'a->b')).toHaveLength(1);
			expect(edgeEditor()).not.toBeInTheDocument();
			expect(toast.notify).not.toHaveBeenCalled();
		});

		describe('deleting an edge the user wrote', () => {
			it('removes the row entirely, from the agent the edge starts from only', () => {
				renderView();
				switchMode('edit');
				const epsilonBefore = sessionOf('e');

				clickEdge('d->e');
				fireEvent.click(deleteEdgeButton()!);

				expect(sessionOf('d').peerAgents).toBeUndefined();
				expect(sessionOf('e')).toBe(epsilonBefore);
				expect(drawnEdgeIds()).not.toContain('d->e');
				expect(edgeEditor()).not.toBeInTheDocument();
				// Delta and Epsilon had this one edge between them.
				expect(nodeBody('d')).toHaveAttribute('data-node-state', 'isolated');

				const notice = removalToast();
				expect(notice.title).toBe('Edge deleted');
				expect(notice.message).toContain('The row for Epsilon was removed from the Peers of Delta');
			});

			it('leaves the other half of a mutual pair as it was', () => {
				renderView();
				switchMode('edit');
				const betaBefore = sessionOf('b');

				clickEdge('a->b');
				fireEvent.click(deleteEdgeButton()!);

				expect(sessionOf('a').peerAgents).toBeUndefined();
				expect(sessionOf('b')).toBe(betaBefore);
				expect(drawnEdgeIds()).toEqual(['b->a', 'd->e']);
				expect(edgeEl('b->a').dataset.hasReverse).toBe('false');
			});

			it('says the edge is still drawn when a grant gives the peer back', () => {
				// Alpha holds a row for Epsilon over its group grant.
				patchSession('a', {
					groupPeerAccess: { read: true, write: false },
					peerAgents: [
						{ sessionId: 'b', read: true, write: true },
						{ sessionId: 'e', read: true, write: true },
					],
				});
				renderView();
				switchMode('edit');

				clickEdge('a->e');
				fireEvent.click(deleteEdgeButton()!);

				expect(sessionOf('a').peerAgents).toEqual([{ sessionId: 'b', read: true, write: true }]);
				expect(sessionOf('a').groupPeerAccess).toEqual({ read: true, write: false });
				// The row is gone and the edge is not: the grant draws it now.
				expect(drawnEdgeIds()).toContain('a->e');
				const model = buildDelegationGraph(ALL, useSessionStore.getState().sessions);
				expect(model.edges.find((edge) => edge.id === 'a->e')).toMatchObject({
					source: 'group',
					read: true,
					write: false,
				});

				const notice = removalToast();
				expect(notice.title).toBe('Row deleted, edge still drawn');
				expect(notice.message).toContain(PEER_GRANT_LABELS.group);
			});
		});

		describe('deleting an edge a grant derived', () => {
			beforeEach(() => {
				// Epsilon reaches Alpha, the other agent in Platform, through its group grant.
				patchSession('e', { groupPeerAccess: { read: true, write: false } });
			});

			it('names the action for what it writes', () => {
				renderView();
				switchMode('edit');

				clickEdge('e->a');

				expect(deleteEdgeButton()).toHaveTextContent('Exclude peer');
			});

			it('writes a row with neither bit and does not alter the grant', () => {
				renderView();
				switchMode('edit');
				const alphaBefore = sessionOf('a');

				clickEdge('e->a');
				fireEvent.click(deleteEdgeButton()!);

				expect(sessionOf('e').peerAgents).toEqual([{ sessionId: 'a', read: false, write: false }]);
				expect(sessionOf('e').groupPeerAccess).toEqual({ read: true, write: false });
				expect(sessionOf('a')).toBe(alphaBefore);
				expect(drawnEdgeIds()).not.toContain('e->a');
				expect(edgeEditor()).not.toBeInTheDocument();
			});

			it('says in a toast that the peer was excluded and not removed, and why', () => {
				renderView();
				switchMode('edit');

				clickEdge('e->a');
				fireEvent.click(deleteEdgeButton()!);

				const notice = removalToast();
				expect(notice.title).toBe('Peer excluded, not removed');
				expect(notice.message).toContain(
					`The "${PEER_GRANT_LABELS.group}" grant of Epsilon is still in force`
				);
				expect(notice.message).toContain('A row with no access was written for Alpha');
			});

			it('does the same for an edge the worktree grant derived, and leaves that grant alone', () => {
				// Gamma is a worktree child of Alpha and reaches it through the family grant.
				patchSession('c', {
					parentSessionId: 'a',
					worktreePeerAccess: { read: true, write: true },
				});
				renderView();
				switchMode('edit');
				const before = useSessionStore.getState().sessions;

				clickEdge('c->a');
				expect(deleteEdgeButton()).toHaveTextContent('Exclude peer');
				fireEvent.click(deleteEdgeButton()!);

				expect(sessionOf('c').peerAgents).toEqual([{ sessionId: 'a', read: false, write: false }]);
				expect(sessionOf('c').worktreePeerAccess).toEqual({ read: true, write: true });
				expect(changedAgentIds(before)).toEqual(['c']);
				expect(drawnEdgeIds()).not.toContain('c->a');
				expect(removalToast().message).toContain(
					`The "${PEER_GRANT_LABELS.worktree}" grant of Gamma is still in force`
				);
			});
		});

		describe('clearing both bits', () => {
			it('is the exclusion and not a delete on an edge the user wrote, and says so', () => {
				patchSession('d', {
					peerAgents: [{ sessionId: 'e', read: false, write: true, description: 'Runs deploys' }],
				});
				renderView();
				switchMode('edit');

				clickEdge('d->e');
				fireEvent.click(accessSquare('write'));

				expect(screen.getByTestId('delegation-edge-editor-excludes')).toHaveTextContent(
					'It is not a delete.'
				);
				expect(screen.getByTestId('delegation-edge-editor-confirm')).toHaveTextContent(
					'Save as excluded'
				);
				confirmEdge();

				// The row is kept, with its note and with neither bit.
				expect(sessionOf('d').peerAgents).toEqual([
					{ sessionId: 'e', read: false, write: false, description: 'Runs deploys' },
				]);
				expect(drawnEdgeIds()).not.toContain('d->e');
				expect(edgeEditor()).not.toBeInTheDocument();

				const notice = removalToast();
				expect(notice.title).toBe('Peer excluded, not removed');
				expect(notice.message).toContain(
					'The row for Epsilon stays in the Peers of Delta, with no access'
				);
			});

			it('is the same exclusion on an edge a grant derived', () => {
				patchSession('e', { groupPeerAccess: { read: true, write: false } });
				renderView();
				switchMode('edit');

				clickEdge('e->a');
				fireEvent.click(accessSquare('read'));
				confirmEdge();

				expect(sessionOf('e').peerAgents).toEqual([{ sessionId: 'a', read: false, write: false }]);
				expect(sessionOf('e').groupPeerAccess).toEqual({ read: true, write: false });
				expect(removalToast().message).toContain(PEER_GRANT_LABELS.group);
			});

			it('still refuses a new edge with neither bit', () => {
				const sessionsBefore = useSessionStore.getState().sessions;
				renderView();
				switchMode('edit');

				connect('c', 'e');
				fireEvent.click(accessSquare('read'));

				expect(screen.getByTestId('delegation-edge-editor-confirm')).toBeDisabled();
				expect(deleteEdgeButton()).not.toBeInTheDocument();
				expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			});
		});

		it('offers the delete action for a direction that is drawn again', () => {
			renderView();
			switchMode('edit');

			connect('d', 'e');
			fireEvent.click(deleteEdgeButton()!);

			expect(sessionOf('d').peerAgents).toBeUndefined();
			expect(drawnEdgeIds()).not.toContain('d->e');
		});

		it('brings an excluded peer back as a row when its edge is drawn again', () => {
			patchSession('e', { groupPeerAccess: { read: true, write: false } });
			renderView();
			switchMode('edit');
			clickEdge('e->a');
			fireEvent.click(deleteEdgeButton()!);

			connect('e', 'a');
			confirmEdge();

			expect(sessionOf('e').peerAgents).toEqual([{ sessionId: 'a', read: true, write: false }]);
			expect(drawnEdgeIds()).toContain('e->a');
		});

		it('discards an open edge on the way back to View', () => {
			const sessionsBefore = useSessionStore.getState().sessions;
			renderView();
			switchMode('edit');

			clickEdge('a->b');
			switchMode('view');

			expect(edgeEditor()).not.toBeInTheDocument();
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
		});
	});

	// On the Platform graph Gamma has no node: it is in Research and no edge
	// joins it to Platform.
	describe('pulling an agent onto the canvas', () => {
		const FOXTROT = { id: 'f', name: 'Foxtrot' };

		function addFoxtrot(): void {
			setSessions((sessions) => [...sessions, createMockSession(FOXTROT)]);
		}

		describe('the Add agent control', () => {
			it('is offered in Edit only', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('view');
				expect(addAgentSelect()).toBeNull();

				switchMode('edit');
				expect(addAgentSelect()).toBeInTheDocument();

				switchMode('view');
				expect(addAgentSelect()).toBeNull();
			});

			it('lists the agents the graph does not draw, under the group each is in', () => {
				addFoxtrot();
				renderView(PLATFORM_SCOPE);
				switchMode('edit');

				const sections = Array.from(addAgentSelect()?.querySelectorAll('optgroup') ?? []).map(
					(section) => [
						section.label,
						Array.from(section.querySelectorAll('option')).map((option) => option.textContent),
					]
				);

				expect(sections).toEqual([
					['Research', ['Gamma']],
					['Ungrouped', ['Foxtrot']],
				]);
				expect(addableIds()).toEqual(['c', 'f']);
				expect(addAgentSelect()).toBeEnabled();
			});

			it('has nothing to add on the graph of every agent, and says why', () => {
				renderView();
				switchMode('edit');

				expect(addableIds()).toEqual([]);
				expect(addAgentSelect()).toBeDisabled();
				expect(addAgentSelect()).toHaveAttribute('title', 'Every agent is already on this graph');
			});

			// An edge needs one end in the group, so an agent added to a group with
			// no agent could never be connected.
			it('is disabled on a group with no agent, and says why', () => {
				renderView({ kind: 'group', groupId: VACANT.id });
				switchMode('edit');

				expect(addAgentSelect()).toBeDisabled();
				expect(addAgentSelect()?.title).toMatch(/no agent/);
			});

			it('draws the picked agent as placed, and writes nothing to any agent', () => {
				const sessionsBefore = useSessionStore.getState().sessions;
				renderView(PLATFORM_SCOPE);
				switchMode('edit');

				addAgent('c');

				expect(drawnNodeIds()).toEqual(['a', 'b', 'c', 'd', 'e']);
				expect(nodeBody('c')).toHaveAttribute('data-node-state', 'placed');
				expect(drawnEdgeIds()).toEqual(['a->b', 'b->a', 'd->e']);
				expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
				// Placing is not moving: Gamma is still in Research.
				expect(sessionOf('c').groupId).toBe(RESEARCH.id);
				// The control is back on its label, and no longer offers Gamma.
				expect(addAgentSelect()?.value).toBe('');
				expect(addableIds()).toEqual([]);
			});

			// The arrangement can put the agent outside what is on screen.
			it('fits the view after an agent is added', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				settle();
				flow.fitView.mockClear();

				addAgent('c');
				settle();

				expect(flow.fitView).toHaveBeenCalledTimes(1);
			});

			it('saves nothing for a scope with no arrangement saved', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');

				addAgent('c');
				rest();

				expect(layouts()[PLATFORM_KEY]).toBeUndefined();
				expect(writeCount()).toBe(0);
			});

			it('moves no agent of a saved arrangement, and keeps the place it gave the new one', () => {
				saveLayouts({ [PLATFORM_KEY]: { layout: 'manual', positions: PLATFORM_POSITIONS } });
				renderView(PLATFORM_SCOPE);
				switchMode('edit');

				addAgent('c');

				for (const id of PLATFORM_IDS) expect(positionOf(id)).toEqual(PLATFORM_POSITIONS[id]);
				const gamma = positionOf('c');
				expect(gamma).not.toEqual(ORIGIN);
				for (const id of PLATFORM_IDS)
					expect(distance(gamma, PLATFORM_POSITIONS[id])).toBeGreaterThan(0);
				expect(layouts()[PLATFORM_KEY]).toEqual({
					layout: 'manual',
					positions: { ...PLATFORM_POSITIONS, c: gamma },
				});
			});
		});

		describe('an agent with no edge yet', () => {
			it('says that adding is not moving, and names the agent and the group', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				expect(placedNotice()).toBeNull();

				addAgent('c');

				expect(placedNotice()).toHaveTextContent('Gamma has no edge yet.');
				expect(placedNotice()).toHaveTextContent(placedAgentHint(PLATFORM.name));
				expect(placedAgentHint(PLATFORM.name)).toMatch(/does not move it into Platform/);
			});

			it('names every agent that waits for an edge', () => {
				addFoxtrot();
				renderView(PLATFORM_SCOPE);
				switchMode('edit');

				addAgent('c');
				addAgent('f');

				expect(placedNotice()).toHaveTextContent('Foxtrot, Gamma have no edge yet.');
			});

			// "Placed and then connected becomes a spill node, exactly as if the
			// delegation had been authored in settings."
			it('becomes a spill agent when an edge is drawn to it, and stays in its own group', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');
				const gammaBefore = sessionOf('c');

				connect('a', 'c');
				confirmEdge();

				expect(sessionOf('a').peerAgents).toContainEqual({
					sessionId: 'c',
					read: true,
					write: false,
				});
				expect(nodeBody('c')).toHaveAttribute('data-node-state', 'spill');
				expect(drawnEdgeIds()).toContain(delegationEdgeId('a', 'c'));
				expect(placedNotice()).toBeNull();
				// The edge was written to Alpha. Gamma is the same object, group included.
				expect(sessionOf('c')).toBe(gammaBefore);
				expect(
					buildDelegationGraph(PLATFORM_SCOPE, useSessionStore.getState().sessions).nodes
				).toContainEqual({ sessionId: 'c', name: 'Gamma', groupId: RESEARCH.id, scope: 'spill' });
			});

			it('can start an edge as well as end one', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');

				connect('c', 'e');
				confirmEdge();

				expect(sessionOf('c').peerAgents).toEqual([{ sessionId: 'e', read: true, write: false }]);
				expect(nodeBody('c')).toHaveAttribute('data-node-state', 'spill');
			});

			// Both ends outside the group: the graph of the group would not draw it.
			it('is refused an edge to another agent outside the group', () => {
				const sessionsBefore = useSessionStore.getState().sessions;
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');

				connect('c', 'b');

				expect(screen.getByTestId('delegation-edge-refusal')).toHaveTextContent(
					'outside this group'
				);
				expect(edgeEditor()).not.toBeInTheDocument();
				expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			});

			it('is taken off the graph from the notice, which leaves a connected agent alone', () => {
				addFoxtrot();
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');
				addAgent('f');
				connect('a', 'c');
				confirmEdge();
				const sessionsBefore = useSessionStore.getState().sessions;

				fireEvent.click(screen.getByTestId('delegation-graph-placed-clear'));

				expect(drawnNodeIds()).toEqual(['a', 'b', 'c', 'd', 'e']);
				expect(placedNotice()).toBeNull();
				expect(addableIds()).toEqual(['f']);
				expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			});

			it('stays when an edge to it is deleted, so it does not vanish under the pointer', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');
				connect('a', 'c');
				confirmEdge();

				clickEdge(delegationEdgeId('a', 'c'));
				fireEvent.click(deleteEdgeButton()!);

				expect(nodeBody('c')).toHaveAttribute('data-node-state', 'placed');
			});

			it('stays on the canvas when the mode goes back to View', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');

				switchMode('view');

				expect(sharedCanvas.props?.nodes.find((node) => node.id === 'c')).toBeDefined();
				expect(placedNotice()).toBeInTheDocument();
				switchMode('edit');
				expect(nodeBody('c')).toHaveAttribute('data-node-state', 'placed');
			});

			it('belongs to the scope it was added on', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');

				changeScope(ALL_KEY);
				expect(placedNotice()).toBeNull();
				changeScope(PLATFORM_KEY);

				expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
			});

			// Never saved: the graph cannot open with an agent nobody connected.
			it('is gone after a remount', () => {
				const first = renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');
				first.unmount();

				renderView(PLATFORM_SCOPE);

				expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
			});

			it('goes with its agent when the agent is deleted', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				addAgent('c');

				setSessions((sessions) => sessions.filter((session) => session.id !== 'c'));

				expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
				expect(placedNotice()).toBeNull();
			});
		});

		describe('an agent row dropped from the Left Bar', () => {
			const GAMMA_DROP: DelegationNodePosition = {
				x: DROP.x + FLOW_OFFSET.x - estimateAgentDelegationNodeWidth('Gamma') / 2,
				y: DROP.y + FLOW_OFFSET.y - AGENT_DELEGATION_NODE_HEIGHT / 2,
			};

			it('is not taken in View', () => {
				const sessionsBefore = useSessionStore.getState().sessions;
				renderView(PLATFORM_SCOPE);
				switchMode('view');
				startAgentDrag('c');

				expect(fireCanvasDrag('dragOver')).toBe(true);
				expect(dropOverlay()).toBeNull();
				fireCanvasDrag('drop');

				expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
				expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
				expect(writeCount()).toBe(0);
			});

			// A file or a tab dragged across the canvas belongs to somebody else.
			it('is not taken when the drag is not an agent', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');

				expect(fireCanvasDrag('dragOver')).toBe(true);
				expect(dropOverlay()).toBeNull();
				fireCanvasDrag('drop');

				expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
			});

			it('says before the drop that adding is not moving', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				startAgentDrag('c');

				expect(fireCanvasDrag('dragOver')).toBe(false);

				expect(dropOverlay()).toHaveTextContent('Drop to add Gamma');
				expect(dropOverlay()).toHaveTextContent(placedAgentHint(PLATFORM.name));
				expect(dropOverlay()).toHaveAttribute('data-already-drawn', 'false');
				// It must not take the drop from the canvas under it.
				expect(dropOverlay()?.className).toContain('pointer-events-none');
			});

			it('takes the hint away when the drag leaves the canvas, and when it ends', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				startAgentDrag('c');

				fireCanvasDrag('dragOver');
				fireCanvasDrag('dragLeave');
				expect(dropOverlay()).toBeNull();

				fireCanvasDrag('dragOver');
				expect(dropOverlay()).toBeInTheDocument();
				endAgentDrag();
				expect(dropOverlay()).toBeNull();
			});

			it('draws the agent where it was dropped, with its middle under the pointer', () => {
				const sessionsBefore = useSessionStore.getState().sessions;
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				startAgentDrag('c');
				fireCanvasDrag('dragOver');

				expect(fireCanvasDrag('drop')).toBe(false);

				expect(flow.screenToFlowPosition).toHaveBeenCalledWith(DROP);
				expect(nodeBody('c')).toHaveAttribute('data-node-state', 'placed');
				expect(positionOf('c')).toEqual(GAMMA_DROP);
				expect(dropOverlay()).toBeNull();
				expect(placedNotice()).toHaveTextContent('Gamma has no edge yet.');
				expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
				expect(sessionOf('c').groupId).toBe(RESEARCH.id);
			});

			// A drop at a point is hand placement, saved the way a drag is.
			it('saves the drop at once as a hand arrangement, and moves no other agent', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				const before = positionsOnCanvas();
				startAgentDrag('c');

				fireCanvasDrag('drop');

				expect(layouts()[PLATFORM_KEY]).toEqual({
					layout: 'manual',
					positions: { ...before, c: GAMMA_DROP },
				});
				expect(writeCount()).toBe(1);
				expect(positionsOnCanvas()).toEqual({ ...before, c: GAMMA_DROP });
				expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('manual');
			});

			it('keeps the agent where it was dropped after the drag ends and the write settles', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				startAgentDrag('c');
				fireCanvasDrag('drop');

				endAgentDrag();
				rest();

				expect(positionOf('c')).toEqual(GAMMA_DROP);
				expect(writeCount()).toBe(1);
			});

			it('selects an agent that is already on the graph, and adds nothing', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				const before = positionsOnCanvas();
				startAgentDrag('b');

				fireCanvasDrag('dragOver');
				expect(dropOverlay()).toHaveTextContent('Beta is already on this graph');
				expect(dropOverlay()).toHaveAttribute('data-already-drawn', 'true');
				fireCanvasDrag('drop');

				expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
				expect(flow.props?.nodes.filter((node) => node.selected).map((node) => node.id)).toEqual([
					'b',
				]);
				expect(positionsOnCanvas()).toEqual(before);
				expect(writeCount()).toBe(0);
				expect(placedNotice()).toBeNull();
			});

			it('takes nothing on a group with no agent', () => {
				renderView({ kind: 'group', groupId: VACANT.id });
				switchMode('edit');
				startAgentDrag('c');

				expect(fireCanvasDrag('dragOver')).toBe(true);
				fireCanvasDrag('drop');

				expect(screen.queryByTestId('react-flow')).toBeNull();
				expect(dropOverlay()).toBeNull();
				expect(writeCount()).toBe(0);
			});

			it('takes nothing for an agent that is gone', () => {
				renderView(PLATFORM_SCOPE);
				switchMode('edit');
				startAgentDrag('gone');

				fireCanvasDrag('dragOver');
				expect(dropOverlay()).toBeNull();
				fireCanvasDrag('drop');

				expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
				expect(writeCount()).toBe(0);
			});
		});
	});

	describe('node markers', () => {
		it('marks an agent with no edges as isolated', () => {
			renderView();
			const gamma = nodeBody('c');

			expect(gamma).toHaveAttribute('data-node-state', 'isolated');
			expect(gamma.style.borderStyle).toBe(AGENT_DELEGATION_NODE_BORDER_STYLE.isolated);
			expect(within(gamma).getByTestId('agent-delegation-node-isolated')).toBeInTheDocument();
			expect(within(gamma).getByText('No peers')).toBeInTheDocument();
		});

		it('marks an agent outside the group as spill, with the name of the group it is in', () => {
			renderView(PLATFORM_SCOPE);
			const beta = nodeBody('b');

			expect(beta).toHaveAttribute('data-node-state', 'spill');
			expect(beta.style.borderStyle).toBe(AGENT_DELEGATION_NODE_BORDER_STYLE.spill);
			expect(beta.style.opacity).toBe(String(AGENT_DELEGATION_SPILL_OPACITY));
			expect(within(beta).getByTestId('agent-delegation-node-spill-group')).toHaveTextContent(
				'Research'
			);
			// Delta is in no group at all.
			expect(
				within(nodeBody('d')).getByTestId('agent-delegation-node-spill-group')
			).toHaveTextContent('Ungrouped');
		});

		it('gives a connected agent in scope neither marker', () => {
			renderView(PLATFORM_SCOPE);

			for (const id of ['a', 'e']) {
				const body = nodeBody(id);
				expect(body).toHaveAttribute('data-node-state', 'in-scope');
				expect(body.style.borderStyle).toBe(AGENT_DELEGATION_NODE_BORDER_STYLE['in-scope']);
				expect(within(body).queryByTestId('agent-delegation-node-isolated')).toBeNull();
				expect(within(body).queryByTestId('agent-delegation-node-spill-group')).toBeNull();
			}
		});

		// The same agent is isolated in one graph and absent from another: the
		// state belongs to the scope, not to the agent.
		it('marks an agent by the scope on screen', () => {
			renderView(RESEARCH_SCOPE);

			expect(nodeBody('c')).toHaveAttribute('data-node-state', 'isolated');
			expect(nodeBody('b')).toHaveAttribute('data-node-state', 'in-scope');
			expect(nodeBody('a')).toHaveAttribute('data-node-state', 'spill');
		});

		it('marks an agent isolated when the one agent it reached is deleted', () => {
			renderView();
			expect(nodeBody('a')).toHaveAttribute('data-node-state', 'in-scope');

			setSessions((sessions) => sessions.filter((session) => session.id !== 'b'));

			expect(drawnNodeIds()).toEqual(['a', 'c', 'd', 'e']);
			expect(drawnEdgeIds()).toEqual(['d->e']);
			expect(nodeBody('a')).toHaveAttribute('data-node-state', 'isolated');
		});
	});

	describe('saved positions', () => {
		it('draws every agent where it was saved', () => {
			saveLayouts({ [ALL_KEY]: { layout: 'manual', positions: ALL_POSITIONS } });

			renderView();

			expect(positionsOnCanvas()).toEqual(ALL_POSITIONS);
			// Reading a saved arrangement writes nothing.
			expect(writeCount()).toBe(0);
		});

		it('keeps a dragged agent where it was left across a remount', () => {
			const first = renderView();
			const others = positionsOnCanvas();
			delete others.a;

			drag('a', DRAGGED);
			first.unmount();
			renderView();

			expect(positionOf('a')).toEqual(DRAGGED);
			// The first drag saved every agent, so none of the rest moved either.
			for (const [id, position] of Object.entries(others)) {
				expect(positionOf(id)).toEqual(position);
			}
			// It reached disk, which is what makes it still there tomorrow.
			expect(diskWrites().at(-1)).toMatchObject({
				[ALL_KEY]: { layout: 'manual', positions: { a: DRAGGED } },
			});
		});

		// Every move after the first waits for the pointer to rest. Closing the
		// graph before it does must not lose that move.
		it('keeps the last move of a drag when the graph closes before the write', () => {
			const first = renderView();
			drag('a', { x: 4000, y: 4000 });
			drag('a', DRAGGED);
			expect(layouts()[ALL_KEY].positions.a).toEqual({ x: 4000, y: 4000 });

			first.unmount();
			renderView();

			expect(layouts()[ALL_KEY].positions.a).toEqual(DRAGGED);
			expect(positionOf('a')).toEqual(DRAGGED);
		});

		// The write a drag makes comes back as a new arrangement a render later.
		// The node must stay under the pointer, not jump to an older save.
		it('leaves a node where the pointer has it while an earlier move is being saved', () => {
			renderView();

			drag('a', { x: 4000, y: 4000 });
			drag('a', { x: 4500, y: 4200 });
			drag('a', DRAGGED);

			expect(positionOf('a')).toEqual(DRAGGED);
			rest();
			expect(positionOf('a')).toEqual(DRAGGED);
			expect(layouts()[ALL_KEY].positions.a).toEqual(DRAGGED);
		});

		it('never drops an agent with no saved position on the origin', () => {
			// Beta (a peer of Alpha) and Gamma (a peer of nobody) were never placed.
			const saved: DelegationSavedPositions = {
				a: ALL_POSITIONS.a,
				d: ALL_POSITIONS.d,
				e: ALL_POSITIONS.e,
			};
			saveLayouts({ [ALL_KEY]: { layout: 'manual', positions: saved } });

			renderView();

			expect(drawnNodeIds()).toEqual(ALL_IDS);
			expect(positionOf('b')).not.toEqual(ORIGIN);
			expect(positionOf('c')).not.toEqual(ORIGIN);
			// Beta goes beside the agent it is connected to, not somewhere arbitrary.
			expect(distance(positionOf('b'), ALL_POSITIONS.a)).toBeLessThan(1000);
			// No agent is dropped on top of another.
			const places = ALL_IDS.map((id) => `${positionOf(id).x},${positionOf(id).y}`);
			expect(new Set(places).size).toBe(ALL_IDS.length);
			// Nothing already placed moved to make room.
			for (const [id, position] of Object.entries(saved)) {
				expect(positionOf(id)).toEqual(position);
			}
		});

		it('keeps an agent it placed in the same spot on the next open', () => {
			saveLayouts({ [ALL_KEY]: { layout: 'manual', positions: { a: ALL_POSITIONS.a } } });
			const first = renderView();
			const placed = positionsOnCanvas();

			// The new places were added to what is saved, and the layout is still manual.
			expect(layouts()[ALL_KEY]).toEqual({ layout: 'manual', positions: placed });

			first.unmount();
			renderView();

			expect(positionsOnCanvas()).toEqual(placed);
		});

		it('places an agent created while the graph is open beside its peer, and moves nobody else', () => {
			saveLayouts({ [ALL_KEY]: { layout: 'manual', positions: ALL_POSITIONS } });
			renderView();

			setSessions((sessions) => [
				...sessions,
				createMockSession({
					id: 'f',
					name: 'Zeta',
					peerAgents: [{ sessionId: 'a', read: true, write: false }],
				}),
			]);

			expect(drawnNodeIds()).toEqual([...ALL_IDS, 'f']);
			expect(positionOf('f')).not.toEqual(ORIGIN);
			expect(distance(positionOf('f'), ALL_POSITIONS.a)).toBeLessThan(1000);
			for (const id of ALL_IDS) expect(positionOf(id)).toEqual(ALL_POSITIONS[id]);
			expect(layouts()[ALL_KEY].positions.f).toEqual(positionOf('f'));
		});
	});

	describe('scope', () => {
		beforeEach(() => {
			saveLayouts({
				[ALL_KEY]: { layout: 'manual', positions: ALL_POSITIONS },
				[PLATFORM_KEY]: { layout: 'manual', positions: PLATFORM_POSITIONS },
			});
		});

		it("loads the scope's own positions on a switch, and never the other scope's", () => {
			renderView();
			expect(positionsOnCanvas()).toEqual(ALL_POSITIONS);

			changeScope(PLATFORM_KEY);
			expect(positionsOnCanvas()).toEqual(PLATFORM_POSITIONS);

			changeScope(ALL_KEY);
			expect(positionsOnCanvas()).toEqual(ALL_POSITIONS);

			// Looking at a scope changes neither record.
			expect(layouts()).toEqual({
				[ALL_KEY]: { layout: 'manual', positions: ALL_POSITIONS },
				[PLATFORM_KEY]: { layout: 'manual', positions: PLATFORM_POSITIONS },
			});
			expect(writeCount()).toBe(0);
		});

		it('opens on the scope it was handed', () => {
			renderView(PLATFORM_SCOPE);

			expect(screen.getByTestId('delegation-graph-scope')).toHaveValue(PLATFORM_KEY);
			expect(positionsOnCanvas()).toEqual(PLATFORM_POSITIONS);
		});

		it('saves a drag to the scope it was made in, and leaves the other scope alone', () => {
			renderView(PLATFORM_SCOPE);

			drag('a', DRAGGED);
			rest();

			expect(layouts()[PLATFORM_KEY].positions.a).toEqual(DRAGGED);
			expect(layouts()[ALL_KEY].positions).toEqual(ALL_POSITIONS);

			changeScope(ALL_KEY);
			expect(positionOf('a')).toEqual(ALL_POSITIONS.a);
		});

		// The drag is still waiting to be written when the scope changes. It must
		// land in the scope it happened in, not in the one now on screen.
		it('does not carry a drag into the next scope when the scope changes mid-write', () => {
			renderView(PLATFORM_SCOPE);

			drag('a', DRAGGED);
			changeScope(ALL_KEY);

			expect(positionsOnCanvas()).toEqual(ALL_POSITIONS);
			expect(layouts()[ALL_KEY].positions).toEqual(ALL_POSITIONS);
			expect(layouts()[PLATFORM_KEY].positions.a).toEqual(DRAGGED);

			changeScope(PLATFORM_KEY);
			expect(positionOf('a')).toEqual(DRAGGED);
		});

		it('lists every group in the scope selector', () => {
			renderView();
			const options = within(screen.getByTestId('delegation-graph-scope')).getAllByRole('option');

			expect(options.map((option) => option.textContent)).toEqual([
				'All agents',
				'Platform',
				'Research',
				'Vacant',
			]);
		});

		// A group can be deleted while its graph is the one on screen, or between
		// the click that asked for it and the open.
		it('shows every agent when the group it was handed does not exist', () => {
			renderView({ kind: 'group', groupId: 'gone' });

			expect(screen.getByTestId('delegation-graph-scope')).toHaveValue(ALL_KEY);
			expect(positionsOnCanvas()).toEqual(ALL_POSITIONS);
		});
	});

	describe('a deleted agent', () => {
		it('draws no node for a saved position whose agent is gone', () => {
			saveLayouts({
				[ALL_KEY]: {
					layout: 'manual',
					positions: { ...ALL_POSITIONS, ghost: { x: 9, y: 9 } },
				},
			});

			renderView();

			expect(drawnNodeIds()).toEqual(ALL_IDS);
		});

		it('drops the coordinates of a deleted agent on the next write', () => {
			saveLayouts({
				[ALL_KEY]: {
					layout: 'manual',
					positions: { ...ALL_POSITIONS, ghost: { x: 9, y: 9 } },
				},
			});
			renderView();

			drag('a', DRAGGED);
			rest();

			expect(Object.keys(layouts()[ALL_KEY].positions).sort()).toEqual(ALL_IDS);
		});

		it('drops the coordinates of an agent deleted while the graph is open', () => {
			saveLayouts({ [ALL_KEY]: { layout: 'manual', positions: ALL_POSITIONS } });
			renderView();

			setSessions((sessions) => sessions.filter((session) => session.id !== 'c'));
			expect(drawnNodeIds()).toEqual(['a', 'b', 'd', 'e']);

			drag('a', DRAGGED);
			rest();

			expect(Object.keys(layouts()[ALL_KEY].positions).sort()).toEqual(['a', 'b', 'd', 'e']);
			// The agents that are still here did not move.
			expect(layouts()[ALL_KEY].positions.b).toEqual(ALL_POSITIONS.b);
		});
	});

	describe('dragging', () => {
		it('turns the scope manual on the first move and saves every agent', () => {
			renderView();
			expect(screen.getByRole('combobox', { name: 'Layout' })).not.toHaveValue('manual');
			expect(screen.getByTestId('delegation-graph-reset')).toBeDisabled();
			const before = positionsOnCanvas();

			drag('a', DRAGGED);

			expect(layouts()[ALL_KEY]).toEqual({
				layout: 'manual',
				positions: { ...before, a: DRAGGED },
			});
			expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('manual');
			expect(screen.getByTestId('delegation-graph-reset')).toBeEnabled();
		});

		it('saves nothing when a node is selected', () => {
			renderView();

			select('a');

			expect(layouts()).toEqual({});
			expect(writeCount()).toBe(0);
		});
	});

	describe('a named layout', () => {
		it('offers every algorithm in a compact picker and shows manual placement without making it selectable', () => {
			renderView();
			const picker = screen.getByRole('combobox', { name: 'Layout' });
			expect(
				within(picker)
					.getAllByRole('option')
					.map((option) => option.getAttribute('value'))
			).toEqual(['hierarchical', 'force', 'radial', 'mindmap', 'lobes']);
			drag('a', DRAGGED);
			expect(picker).toHaveValue('manual');
			expect(within(picker).getByRole('option', { name: 'Manual' })).toBeDisabled();
		});

		// Moving between two algorithms destroys nothing the user made.
		it('is applied at once when nothing was placed by hand', () => {
			renderView();

			fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), {
				target: { value: 'force' },
			});

			expect(screen.queryByTestId('delegation-graph-confirm')).toBeNull();
			expect(layouts()[ALL_KEY].layout).toBe('force');
			expect(Object.keys(layouts()[ALL_KEY].positions).sort()).toEqual(ALL_IDS);
			expect(positionsOnCanvas()).toEqual(layouts()[ALL_KEY].positions);
			expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveValue('force');
		});

		it('asks first when the scope was arranged by hand, and changes nothing on Cancel', () => {
			renderView();
			drag('a', DRAGGED);

			fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), {
				target: { value: 'radial' },
			});
			const dialog = screen.getByTestId('delegation-graph-confirm');
			expect(layouts()[ALL_KEY].layout).toBe('manual');

			fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

			expect(screen.queryByTestId('delegation-graph-confirm')).toBeNull();
			expect(layouts()[ALL_KEY].layout).toBe('manual');
			expect(positionOf('a')).toEqual(DRAGGED);
		});

		it('replaces what was placed by hand once confirmed', () => {
			renderView();
			drag('a', DRAGGED);

			fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), {
				target: { value: 'radial' },
			});
			fireEvent.click(
				within(screen.getByTestId('delegation-graph-confirm')).getByRole('button', {
					name: `Apply ${DELEGATION_LAYOUT_LABELS.radial.name}`,
				})
			);

			expect(screen.queryByTestId('delegation-graph-confirm')).toBeNull();
			expect(layouts()[ALL_KEY].layout).toBe('radial');
			expect(positionOf('a')).not.toEqual(DRAGGED);
			expect(positionsOnCanvas()).toEqual(layouts()[ALL_KEY].positions);
			expect(screen.getByRole('combobox', { name: 'Layout' })).not.toHaveValue('manual');
		});

		it('forgets the arrangement on a confirmed reset', () => {
			renderView();
			const arranged = positionsOnCanvas();
			drag('a', DRAGGED);

			fireEvent.click(screen.getByTestId('delegation-graph-reset'));
			expect(layouts()[ALL_KEY].layout).toBe('manual');
			fireEvent.click(
				within(screen.getByTestId('delegation-graph-confirm')).getByRole('button', {
					name: 'Reset',
				})
			);

			expect(layouts()).toEqual({});
			// Back where the default layout put every agent.
			expect(positionsOnCanvas()).toEqual(arranged);
			expect(screen.getByTestId('delegation-graph-reset')).toBeDisabled();
		});
	});

	describe('neighbor focus', () => {
		it('highlights the edges of the selected agent and dims the rest', () => {
			renderView();
			expect(edgeEl('a->b').dataset.emphasis).toBe('none');

			select('a');

			expect(edgeEl('a->b').dataset.emphasis).toBe('highlighted');
			expect(edgeEl('b->a').dataset.emphasis).toBe('highlighted');
			expect(edgeEl('d->e').dataset.emphasis).toBe('dimmed');
		});

		it('dims every agent that is neither selected nor one edge away', () => {
			renderView();

			select('a');

			expect(nodeEl('a').style.opacity).toBe('');
			expect(nodeEl('b').style.opacity).toBe('');
			for (const id of ['c', 'd', 'e']) expect(nodeEl(id).style.opacity).toBe('0.35');
		});

		it('shows the selected agent in the panel, and clears the focus from there', () => {
			renderView();
			expect(screen.queryByTestId('delegation-graph-detail')).toBeNull();

			select('a');
			const panel = screen.getByTestId('delegation-graph-detail');
			expect(within(panel).getByTestId('delegation-graph-detail-outbound')).toHaveTextContent(
				'Beta'
			);

			fireEvent.click(within(panel).getByRole('button', { name: 'Clear the selection' }));

			expect(screen.queryByTestId('delegation-graph-detail')).toBeNull();
			expect(edgeEl('d->e').dataset.emphasis).toBe('none');
			for (const id of ALL_IDS) expect(nodeEl(id).style.opacity).toBe('');
		});

		it("opens the selected agent's Peers tab from the panel", () => {
			renderView();
			select('d');

			fireEvent.click(screen.getByTestId('delegation-graph-detail-open-peers'));

			const opened = useModalStore.getState().getData('editAgent');
			expect(opened?.session.id).toBe('d');
			expect(opened?.initialTab).toBe('peers');
		});
	});

	describe('empty states', () => {
		it('says so in prose when there is no agent at all, and draws no canvas', () => {
			useSessionStore.setState({ sessions: [] });

			renderView();

			expect(screen.getByText('No agents yet')).toBeInTheDocument();
			expect(screen.getByText(/Peers tab of its settings/)).toBeInTheDocument();
			expect(screen.queryByTestId('react-flow')).toBeNull();
			expect(screen.getByTestId('delegation-graph-fit')).toBeDisabled();
		});

		it('says so in prose when the group has no agent', () => {
			renderView({ kind: 'group', groupId: VACANT.id });

			expect(screen.getByText('No agents in this group')).toBeInTheDocument();
			expect(screen.queryByTestId('react-flow')).toBeNull();
		});

		// An isolated agent is what the graph exists to show, so the agents are
		// still drawn. The notice says why nothing joins them and where to fix it.
		it('draws the agents under a notice when every one of them is isolated', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({ id: 'a', name: 'Alpha' }),
					createMockSession({ id: 'b', name: 'Beta' }),
				],
				activeSessionId: 'b',
			});

			renderView();

			expect(drawnNodeIds()).toEqual(['a', 'b']);
			expect(drawnEdgeIds()).toEqual([]);
			expect(screen.getByTestId('delegation-graph-no-edges')).toHaveTextContent(
				'No agent here can reach another'
			);
		});

		it('links the notice to the Peers tab of the agent the user is working in', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({ id: 'a', name: 'Alpha' }),
					createMockSession({ id: 'b', name: 'Beta' }),
				],
				activeSessionId: 'b',
			});
			renderView();
			const link = screen.getByTestId('delegation-graph-no-edges-open-peers');
			expect(link).toHaveTextContent('Open Peers tab of Beta');

			fireEvent.click(link);

			const opened = useModalStore.getState().getData('editAgent');
			expect(opened?.session.id).toBe('b');
			expect(opened?.initialTab).toBe('peers');
		});

		it('shows no notice while at least one edge is drawn', () => {
			renderView();

			expect(screen.queryByTestId('delegation-graph-no-edges')).toBeNull();
		});
	});

	describe('the legend', () => {
		it('is open by default', () => {
			renderView();

			expect(screen.getByTestId('delegation-graph-legend')).toBeInTheDocument();
		});

		it('stays hidden across a remount once the user hides it', () => {
			const first = renderView();

			fireEvent.click(screen.getByTestId('delegation-graph-legend-toggle'));
			expect(screen.queryByTestId('delegation-graph-legend')).toBeNull();
			first.unmount();
			renderView();

			expect(screen.queryByTestId('delegation-graph-legend')).toBeNull();
		});
	});
});
