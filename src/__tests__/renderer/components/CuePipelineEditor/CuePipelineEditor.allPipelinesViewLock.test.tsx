/**
 * All Pipelines view — read-only lock regression tests.
 *
 * In "All Pipelines" view (`selectedPipelineId === null`), the canvas must be
 * completely locked:
 *   - Nodes cannot be dragged; drag-stop must not mutate canonical state.
 *   - Drag-drop from the trigger/agent drawers must not add nodes.
 *   - Edge connection attempts must not create edges.
 *   - `isValidConnection` must refuse every connection.
 *   - Keyboard Delete/Backspace must not delete the selected node/edge.
 *   - Right-click must not open the context menu.
 *   - Clicking a node/edge must not open the config panel for editing.
 *   - The per-node "Configure" callback must not set selection.
 *
 * These tests drive each entry point directly via the captured props and
 * verify no canonical mutation (setPipelineState, onDeleteNode, onDeleteEdge)
 * and no selection mutation (setSelectedNodeId, setSelectedEdgeId) happens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';

// ─── Captured props from PipelineCanvas ──────────────────────────────────────
let captured: {
	onNodesChange: any;
	onNodeDragStop: any;
	onDrop: any;
	onConnect: any;
	isValidConnection: any;
	onNodeClick: any;
	onEdgeClick: any;
	onNodeContextMenu: any;
	handleConfigureNode: any;
	isReadOnly: boolean | undefined;
} = {
	onNodesChange: null,
	onNodeDragStop: null,
	onDrop: null,
	onConnect: null,
	isValidConnection: null,
	onNodeClick: null,
	onEdgeClick: null,
	onNodeContextMenu: null,
	handleConfigureNode: null,
	isReadOnly: undefined,
};

vi.mock('reactflow', () => ({
	default: (props: any) => <div data-testid="react-flow">{props.children}</div>,
	ReactFlowProvider: ({ children }: any) => <>{children}</>,
	useReactFlow: () => ({
		fitView: vi.fn(),
		screenToFlowPosition: vi.fn((pos: any) => pos),
		setViewport: vi.fn(),
	}),
	useNodesInitialized: () => false,
	applyNodeChanges: (_changes: any[], nodes: any[]) => nodes,
	Background: () => null,
	Controls: () => null,
	MiniMap: () => null,
	ConnectionMode: { Loose: 'loose' },
	Position: { Left: 'left', Right: 'right' },
	Handle: () => null,
	MarkerType: { ArrowClosed: 'arrowclosed' },
}));

// Capture all interaction callbacks + the read-only flag that CuePipelineEditor
// passes down. The mock intentionally captures these at mount so tests can
// invoke them directly — much more reliable than simulating ReactFlow events.
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineCanvas', () => ({
	PipelineCanvas: React.memo((props: any) => {
		captured.onNodesChange = props.onNodesChange;
		captured.onNodeDragStop = props.onNodeDragStop;
		captured.onDrop = props.onDrop;
		captured.onConnect = props.onConnect;
		captured.isValidConnection = props.isValidConnection;
		captured.onNodeClick = props.onNodeClick;
		captured.onEdgeClick = props.onEdgeClick;
		captured.onNodeContextMenu = props.onNodeContextMenu;
		captured.isReadOnly = props.isReadOnly;
		return <div data-testid="pipeline-canvas" />;
	}),
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineToolbar', () => ({
	PipelineToolbar: () => <div />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineContextMenu', () => ({
	PipelineContextMenu: (props: any) => (
		<div
			data-testid="pipeline-context-menu"
			data-context-menu={JSON.stringify(props.contextMenu)}
		/>
	),
}));

// Hoisted — tests toggle this and re-render. `stableStateHook` returns the
// same object reference each call (avoids the setState loop the initial
// viewport test ran into).
const mockSetPipelineState = vi.fn();
const mockOnDeleteNode = vi.fn();
const mockOnDeleteEdge = vi.fn();
const mockPersistLayout = vi.fn();

const TRIGGER_NODE = {
	id: 'trigger-1',
	type: 'trigger' as const,
	position: { x: 0, y: 0 },
	data: { eventType: 'time.heartbeat', label: 'Test', config: {} },
};
const AGENT_NODE = {
	id: 'agent-1',
	type: 'agent' as const,
	position: { x: 200, y: 0 },
	data: { sessionId: 's1', sessionName: 'Agent', toolType: 'claude-code' },
};
const EDGE = { id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' as const };

// Two stable state objects — one per view mode — so the pipelineState prop is
// referentially identical across renders (prevents ReactFlow re-renders
// triggering a setState loop).
const lockedPipelineState = {
	pipelines: [
		{
			id: 'p1',
			name: 'Pipeline 1',
			color: '#06b6d4',
			nodes: [TRIGGER_NODE, AGENT_NODE],
			edges: [EDGE],
		},
	],
	selectedPipelineId: null as string | null,
};
const unlockedPipelineState = {
	pipelines: lockedPipelineState.pipelines,
	selectedPipelineId: 'p1' as string | null,
};
let currentPipelineState = lockedPipelineState;

// Selection mocks — used to verify click-to-select is blocked
const mockSetSelectedNodeId = vi.fn();
const mockSetSelectedEdgeId = vi.fn();
const mockHandleConfigureNode = vi.fn();
const stableSelectionHook = {
	selectedNodeId: null as string | null,
	setSelectedNodeId: mockSetSelectedNodeId,
	selectedEdgeId: null as string | null,
	setSelectedEdgeId: mockSetSelectedEdgeId,
	selectedNode: null,
	selectedNodePipelineId: null,
	selectedNodeHasOutgoingEdge: false,
	hasIncomingAgentEdges: false,
	incomingAgentEdgeCount: 0,
	incomingTriggerEdges: [],
	selectedEdge: null,
	selectedEdgePipelineId: null,
	selectedEdgePipelineColor: '#06b6d4',
	edgeSourceNode: null,
	edgeTargetNode: null,
	onCanvasSessionIds: new Set<string>(),
	onNodeClick: vi.fn((_e: any, node: any) => mockSetSelectedNodeId(node.id)),
	onEdgeClick: vi.fn((_e: any, edge: any) => mockSetSelectedEdgeId(edge.id)),
	onPaneClick: vi.fn(),
	handleConfigureNode: mockHandleConfigureNode,
};

const stableCueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break' as const,
	max_concurrent: 1,
	queue_size: 10,
};
const stableRunningPipelineIds = new Set<string>();

// usePipelineState mock that flips `isAllPipelinesView` based on
// `currentPipelineState.selectedPipelineId`.
function makeStateHook() {
	const state = currentPipelineState;
	return {
		pipelineState: state,
		setPipelineState: mockSetPipelineState,
		isAllPipelinesView: state.selectedPipelineId === null,
		isDirty: false,
		setIsDirty: vi.fn(),
		saveStatus: 'idle' as const,
		validationErrors: [],
		cueSettings: stableCueSettings,
		setCueSettings: vi.fn(),
		showSettings: false,
		setShowSettings: vi.fn(),
		runningPipelineIds: stableRunningPipelineIds,
		persistLayout: mockPersistLayout,
		pendingSavedViewportRef: { current: null as null | { x: number; y: number; zoom: number } },
		handleSave: vi.fn(),
		handleDiscard: vi.fn(),
		createPipeline: vi.fn(),
		deletePipeline: vi.fn(),
		renamePipeline: vi.fn(),
		selectPipeline: vi.fn(),
		changePipelineColor: vi.fn(),
		onUpdateNode: vi.fn(),
		onUpdateEdgePrompt: vi.fn(),
		onDeleteNode: mockOnDeleteNode,
		onUpdateEdge: vi.fn(),
		onDeleteEdge: mockOnDeleteEdge,
	};
}
let stateHookCache = makeStateHook();

vi.mock('../../../../renderer/hooks/cue/usePipelineState', () => ({
	usePipelineState: () => stateHookCache,
	DEFAULT_TRIGGER_LABELS: { 'time.heartbeat': 'Heartbeat' },
	validatePipelines: vi.fn(),
}));

vi.mock('../../../../renderer/hooks/cue/usePipelineSelection', () => ({
	usePipelineSelection: () => stableSelectionHook,
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	convertToReactFlowNodes: vi.fn((_pipelines: any, _sel: any, onConfigureNode: any) => {
		// Expose the guarded configure callback the editor passes into nodes.
		captured.handleConfigureNode = onConfigureNode;
		return [
			{ id: 'p1:trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
			{ id: 'p1:agent-1', type: 'agent', position: { x: 200, y: 0 }, data: {} },
		];
	}),
	convertToReactFlowEdges: vi.fn(() => []),
	computePipelineYOffsets: vi.fn(() => new Map()),
}));

import { CuePipelineEditor } from '../../../../renderer/components/CuePipelineEditor/CuePipelineEditor';

const mockTheme = {
	name: 'test',
	colors: {
		bgMain: '#1a1a2e',
		bgActivity: '#16213e',
		border: '#333',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#06b6d4',
		accentForeground: '#fff',
		success: '#22c55e',
	},
} as any;

function renderEditor() {
	stateHookCache = makeStateHook();
	render(
		<CuePipelineEditor
			sessions={[]}
			graphSessions={[]}
			onSwitchToSession={vi.fn()}
			onClose={vi.fn()}
			theme={mockTheme}
		/>
	);
}

describe('CuePipelineEditor — All Pipelines view is fully read-only', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(captured, {
			onNodesChange: null,
			onNodeDragStop: null,
			onDrop: null,
			onConnect: null,
			isValidConnection: null,
			onNodeClick: null,
			onEdgeClick: null,
			onNodeContextMenu: null,
			handleConfigureNode: null,
			isReadOnly: undefined,
		});
		currentPipelineState = lockedPipelineState;
	});

	it('passes isReadOnly=true to PipelineCanvas in All Pipelines view', () => {
		renderEditor();
		expect(captured.isReadOnly).toBe(true);
	});

	it('passes isReadOnly=false to PipelineCanvas when a pipeline is selected', () => {
		currentPipelineState = unlockedPipelineState;
		renderEditor();
		expect(captured.isReadOnly).toBe(false);
	});

	it('onNodeDragStop is a no-op — position commits are refused', () => {
		renderEditor();
		const draggedNode = { id: 'p1:agent-1', position: { x: 999, y: 999 } };
		captured.onNodeDragStop({} as any, draggedNode, [draggedNode]);
		expect(mockSetPipelineState).not.toHaveBeenCalled();
		expect(mockPersistLayout).not.toHaveBeenCalled();
	});

	it('onDrop is a no-op — new trigger/agent drops are refused', () => {
		renderEditor();
		const triggerDropEvent = {
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
			dataTransfer: {
				getData: () => JSON.stringify({ type: 'trigger', eventType: 'time.heartbeat' }),
			},
			clientX: 100,
			clientY: 100,
		};
		captured.onDrop(triggerDropEvent);
		expect(mockSetPipelineState).not.toHaveBeenCalled();

		const agentDropEvent = {
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
			dataTransfer: {
				getData: () =>
					JSON.stringify({
						type: 'agent',
						sessionId: 's1',
						sessionName: 'Agent',
						toolType: 'claude-code',
					}),
			},
			clientX: 100,
			clientY: 100,
		};
		captured.onDrop(agentDropEvent);
		expect(mockSetPipelineState).not.toHaveBeenCalled();
	});

	it('onConnect is a no-op — new edges are refused', () => {
		renderEditor();
		captured.onConnect({
			source: 'p1:trigger-1',
			target: 'p1:agent-1',
			sourceHandle: null,
			targetHandle: null,
		});
		expect(mockSetPipelineState).not.toHaveBeenCalled();
	});

	it('isValidConnection returns false for every connection', () => {
		renderEditor();
		expect(
			captured.isValidConnection({
				source: 'p1:trigger-1',
				target: 'p1:agent-1',
				sourceHandle: null,
				targetHandle: null,
			})
		).toBe(false);
	});

	it('onNodeContextMenu refuses to open the context menu', () => {
		renderEditor();
		const event = {
			preventDefault: vi.fn(),
			clientX: 100,
			clientY: 100,
		};
		const node = { id: 'p1:agent-1', type: 'agent' };
		captured.onNodeContextMenu(event, node);
		expect(event.preventDefault).toHaveBeenCalled();
		// No menu rendered → no selection mutation, no state mutation
		expect(mockSetPipelineState).not.toHaveBeenCalled();
		expect(mockSetSelectedNodeId).not.toHaveBeenCalled();
	});

	it('onNodeClick does not set node selection (guarded wrapper)', () => {
		renderEditor();
		captured.onNodeClick({} as any, { id: 'p1:agent-1', type: 'agent' });
		expect(mockSetSelectedNodeId).not.toHaveBeenCalled();
	});

	it('onEdgeClick does not set edge selection (guarded wrapper)', () => {
		renderEditor();
		captured.onEdgeClick({} as any, { id: 'p1:e1' });
		expect(mockSetSelectedEdgeId).not.toHaveBeenCalled();
	});

	it('handleConfigureNode (per-node configure icon) is a no-op', () => {
		renderEditor();
		expect(captured.handleConfigureNode).toBeTruthy();
		captured.handleConfigureNode('p1:agent-1');
		expect(mockHandleConfigureNode).not.toHaveBeenCalled();
	});

	it('keyboard Delete/Backspace does not delete the selected node', () => {
		// Single-pipeline view would delete; All Pipelines view must not.
		// Prime a selection so the delete path is reachable if the guard were absent.
		stableSelectionHook.selectedNode = AGENT_NODE as any;
		(stableSelectionHook as any).selectedNodePipelineId = 'p1';
		renderEditor();
		fireEvent.keyDown(window, { key: 'Delete' });
		fireEvent.keyDown(window, { key: 'Backspace' });
		expect(mockOnDeleteNode).not.toHaveBeenCalled();
		// Reset so other tests aren't affected
		stableSelectionHook.selectedNode = null;
		(stableSelectionHook as any).selectedNodePipelineId = null;
	});

	it('keyboard Delete/Backspace does not delete the selected edge', () => {
		(stableSelectionHook as any).selectedEdge = EDGE;
		(stableSelectionHook as any).selectedEdgePipelineId = 'p1';
		renderEditor();
		fireEvent.keyDown(window, { key: 'Delete' });
		fireEvent.keyDown(window, { key: 'Backspace' });
		expect(mockOnDeleteEdge).not.toHaveBeenCalled();
		(stableSelectionHook as any).selectedEdge = null;
		(stableSelectionHook as any).selectedEdgePipelineId = null;
	});
});

describe('CuePipelineEditor — single-pipeline view remains editable (negative control)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(captured, {
			onNodesChange: null,
			onNodeDragStop: null,
			onDrop: null,
			onConnect: null,
			isValidConnection: null,
			onNodeClick: null,
			onEdgeClick: null,
			onNodeContextMenu: null,
			handleConfigureNode: null,
			isReadOnly: undefined,
		});
		currentPipelineState = unlockedPipelineState;
	});

	it('onNodeDragStop commits to state when a pipeline is selected', () => {
		renderEditor();
		const draggedNode = { id: 'p1:agent-1', position: { x: 999, y: 999 } };
		captured.onNodeDragStop({} as any, draggedNode, [draggedNode]);
		expect(mockSetPipelineState).toHaveBeenCalledTimes(1);
		expect(mockPersistLayout).toHaveBeenCalledTimes(1);
	});

	it('onNodeClick sets selection when a pipeline is selected', () => {
		renderEditor();
		captured.onNodeClick({} as any, { id: 'p1:agent-1', type: 'agent' });
		expect(mockSetSelectedNodeId).toHaveBeenCalledWith('p1:agent-1');
	});

	it('handleConfigureNode calls through when a pipeline is selected', () => {
		renderEditor();
		captured.handleConfigureNode('p1:agent-1');
		expect(mockHandleConfigureNode).toHaveBeenCalledWith('p1:agent-1');
	});
});
