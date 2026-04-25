/**
 * Regression tests for CuePipelineEditor's initial viewport behavior.
 *
 * Guards against the bug where, on first open, the canvas appeared empty
 * because the initial `fitView` was scheduled on a `setTimeout(150)` that
 * could fire BEFORE ReactFlow had measured the freshly-rendered nodes.
 * Switching pipelines and switching back "fixed" the canvas only because
 * the selection-change `fitView` ran later, after measurements had
 * completed from the first render.
 *
 * The fix gates the initial viewport step on ReactFlow's
 * `useNodesInitialized()` and coordinates saved-viewport restoration
 * (owned by usePipelineLayout) with fitView in a single effect — no race.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

const mockFitView = vi.fn();
const mockSetViewport = vi.fn();
let mockNodesInitialized = false;

vi.mock('reactflow', () => ({
	default: (props: any) => <div data-testid="react-flow">{props.children}</div>,
	ReactFlowProvider: ({ children }: any) => <>{children}</>,
	useReactFlow: () => ({
		fitView: mockFitView,
		screenToFlowPosition: vi.fn((pos: any) => pos),
		setViewport: mockSetViewport,
	}),
	useNodesInitialized: () => mockNodesInitialized,
	applyNodeChanges: (_changes: any[], nodes: any[]) => nodes,
	Background: () => null,
	Controls: () => null,
	MiniMap: () => null,
	ConnectionMode: { Loose: 'loose' },
	Position: { Left: 'left', Right: 'right' },
	Handle: () => null,
	MarkerType: { ArrowClosed: 'arrowclosed' },
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineCanvas', () => ({
	PipelineCanvas: React.memo(() => <div data-testid="pipeline-canvas" />),
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineToolbar', () => ({
	PipelineToolbar: () => <div />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineContextMenu', () => ({
	PipelineContextMenu: () => null,
}));

// Stable references across renders — returning a new object literal from the
// mock every render caused a setState loop in `useEffect(() => setDisplayNodes,
// [computedNodes])`, which OOM'd the Node worker.
const mockPendingSavedViewportRef = {
	current: null as null | { x: number; y: number; zoom: number },
};
const stablePipelineState = {
	pipelines: [
		{
			id: 'p1',
			name: 'Pipeline 1',
			color: '#06b6d4',
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'time.heartbeat', label: 'Test', config: {} },
				},
			],
			edges: [],
		},
	],
	selectedPipelineId: null,
};
const stableRunningPipelineIds = new Set<string>();
const stableCueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break',
	max_concurrent: 1,
	queue_size: 10,
};
const stableStateHook = {
	pipelineState: stablePipelineState,
	setPipelineState: vi.fn(),
	isAllPipelinesView: true,
	isDirty: false,
	setIsDirty: vi.fn(),
	saveStatus: 'idle' as const,
	validationErrors: [],
	cueSettings: stableCueSettings,
	setCueSettings: vi.fn(),
	showSettings: false,
	setShowSettings: vi.fn(),
	runningPipelineIds: stableRunningPipelineIds,
	persistLayout: vi.fn(),
	pendingSavedViewportRef: mockPendingSavedViewportRef,
	handleSave: vi.fn(),
	handleDiscard: vi.fn(),
	createPipeline: vi.fn(),
	deletePipeline: vi.fn(),
	renamePipeline: vi.fn(),
	selectPipeline: vi.fn(),
	changePipelineColor: vi.fn(),
	onUpdateNode: vi.fn(),
	onUpdateEdgePrompt: vi.fn(),
	onDeleteNode: vi.fn(),
	onUpdateEdge: vi.fn(),
	onDeleteEdge: vi.fn(),
};

vi.mock('../../../../renderer/hooks/cue/usePipelineState', () => ({
	usePipelineState: () => stableStateHook,
	DEFAULT_TRIGGER_LABELS: {},
	validatePipelines: vi.fn(),
}));

// Stable mock — see note on stableStateHook above.
const stableSelectionHook = {
	selectedNodeId: null,
	setSelectedNodeId: vi.fn(),
	selectedEdgeId: null,
	setSelectedEdgeId: vi.fn(),
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
	onNodeClick: vi.fn(),
	onEdgeClick: vi.fn(),
	onPaneClick: vi.fn(),
	handleConfigureNode: vi.fn(),
};

vi.mock('../../../../renderer/hooks/cue/usePipelineSelection', () => ({
	usePipelineSelection: () => stableSelectionHook,
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	// Return one node so computedNodes.length > 0
	convertToReactFlowNodes: vi.fn(() => [
		{ id: 'p1:trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
	]),
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
	return render(
		<CuePipelineEditor
			sessions={[]}
			graphSessions={[]}
			onSwitchToSession={vi.fn()}
			onClose={vi.fn()}
			theme={mockTheme}
		/>
	);
}

describe('CuePipelineEditor — initial viewport (regression: empty canvas on first open)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockNodesInitialized = false;
		mockPendingSavedViewportRef.current = null;
	});

	it('does NOT fitView when nodes have not yet been measured', () => {
		// Simulates the first render after layout restore — nodes are present
		// in state but ReactFlow's dimension measurement has not completed.
		mockNodesInitialized = false;
		renderEditor();

		expect(mockFitView).not.toHaveBeenCalled();
		expect(mockSetViewport).not.toHaveBeenCalled();
	});

	it('fits view once nodes have been measured (no saved viewport)', () => {
		// Mount with nodesInitialized=false to mirror the real ReactFlow timing
		// (initial render happens before the dimension measurement finishes),
		// then flip to true and rerender so the initial-viewport effect's
		// dependency change drives it post-mount. Asserting after a single
		// mount with nodesInitialized=true would mask a regression where the
		// effect doesn't react to the false→true transition.
		mockNodesInitialized = false;
		mockPendingSavedViewportRef.current = null;
		const { rerender } = renderEditor();

		expect(mockFitView).not.toHaveBeenCalled();

		mockNodesInitialized = true;
		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(mockFitView).toHaveBeenCalledTimes(1);
		expect(mockSetViewport).not.toHaveBeenCalled();
	});

	it('restores saved viewport immediately on mount (no need to wait for measurement)', () => {
		// setViewport is a pure (x, y, zoom) restore — it doesn't depend on
		// node measurement, so it fires immediately. Waiting for
		// nodesInitialized would briefly show the wrong viewport before
		// snapping to the saved one.
		mockNodesInitialized = false;
		mockPendingSavedViewportRef.current = { x: 100, y: 200, zoom: 1.5 };
		renderEditor();

		expect(mockSetViewport).toHaveBeenCalledWith({ x: 100, y: 200, zoom: 1.5 });
		expect(mockFitView).not.toHaveBeenCalled();
	});

	it('consumes the pending saved viewport after applying it', () => {
		mockNodesInitialized = false;
		mockPendingSavedViewportRef.current = { x: 100, y: 200, zoom: 1.5 };
		renderEditor();

		// Ref is nulled out so the viewport isn't re-applied on subsequent renders
		// (e.g. after selection changes trigger the other fitView effect).
		expect(mockPendingSavedViewportRef.current).toBeNull();
	});

	it('runs the initial viewport step exactly once', () => {
		mockNodesInitialized = false;
		mockPendingSavedViewportRef.current = null;
		const { rerender } = renderEditor();

		mockNodesInitialized = true;
		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(mockFitView).toHaveBeenCalledTimes(1);

		// Subsequent renders must NOT re-fit — that's the job of the
		// selection-change fitView effect, not the initial one.
		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(mockFitView).toHaveBeenCalledTimes(1);
	});
});
