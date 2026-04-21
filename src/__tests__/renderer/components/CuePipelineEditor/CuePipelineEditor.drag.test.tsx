/**
 * Tests for canvas drag logic in CuePipelineEditor.
 *
 * Verifies that:
 * - onNodesChange never commits to pipelineState (visual only)
 * - onNodeDragStop commits final positions to pipelineState
 * - persistLayout is called only on drag stop
 * - Multiple nodes dragged simultaneously all commit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

// Capture props passed to PipelineCanvas
let capturedOnNodesChange: any = null;
let capturedOnNodeDragStop: any = null;

vi.mock('reactflow', () => {
	return {
		default: (props: any) => <div data-testid="react-flow">{props.children}</div>,
		ReactFlowProvider: ({ children }: any) => <>{children}</>,
		useReactFlow: () => ({
			fitView: vi.fn(),
			screenToFlowPosition: vi.fn((pos: any) => pos),
			setViewport: vi.fn(),
		}),
		useNodesInitialized: () => false,
		applyNodeChanges: (changes: any[], nodes: any[]) => nodes,
		Background: () => null,
		Controls: () => null,
		MiniMap: () => null,
		ConnectionMode: { Loose: 'loose' },
		Position: { Left: 'left', Right: 'right' },
		Handle: () => null,
		MarkerType: { ArrowClosed: 'arrowclosed' },
	};
});

vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineCanvas', () => ({
	PipelineCanvas: React.memo((props: any) => {
		capturedOnNodesChange = props.onNodesChange;
		capturedOnNodeDragStop = props.onNodeDragStop;
		return <div data-testid="pipeline-canvas" />;
	}),
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineToolbar', () => ({
	PipelineToolbar: () => <div />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineContextMenu', () => ({
	PipelineContextMenu: () => null,
}));

const mockSetPipelineState = vi.fn();
const mockPersistLayout = vi.fn();

vi.mock('../../../../renderer/hooks/cue/usePipelineState', () => ({
	usePipelineState: () => ({
		pipelineState: {
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
						{
							id: 'agent-1',
							type: 'agent',
							position: { x: 200, y: 0 },
							data: { sessionId: 's1', sessionName: 'Agent', toolType: 'claude-code' },
						},
					],
					edges: [{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' }],
				},
			],
			selectedPipelineId: 'p1',
		},
		setPipelineState: mockSetPipelineState,
		isAllPipelinesView: false,
		isDirty: false,
		setIsDirty: vi.fn(),
		saveStatus: 'idle',
		validationErrors: [],
		cueSettings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
		setCueSettings: vi.fn(),
		showSettings: false,
		setShowSettings: vi.fn(),
		runningPipelineIds: new Set<string>(),
		persistLayout: mockPersistLayout,
		pendingSavedViewportRef: { current: null },
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
	}),
	DEFAULT_TRIGGER_LABELS: {},
	validatePipelines: vi.fn(),
}));

vi.mock('../../../../renderer/hooks/cue/usePipelineSelection', () => ({
	usePipelineSelection: () => ({
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
	}),
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	convertToReactFlowNodes: vi.fn(() => []),
	convertToReactFlowEdges: vi.fn(() => []),
	computePipelineYOffsets: vi.fn(() => new Map()),
}));

import { CuePipelineEditor } from '../../../../renderer/components/CuePipelineEditor/CuePipelineEditor';

import { mockTheme } from '../../../helpers/mockTheme';

describe('CuePipelineEditor drag logic', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedOnNodesChange = null;
		capturedOnNodeDragStop = null;
	});

	function renderEditor() {
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

	it('onNodesChange never commits to pipelineState', () => {
		renderEditor();
		expect(capturedOnNodesChange).toBeTruthy();

		// Mid-drag change
		capturedOnNodesChange([
			{ type: 'position', id: 'p1:agent-1', position: { x: 300, y: 50 }, dragging: true },
		]);
		expect(mockSetPipelineState).not.toHaveBeenCalled();

		// Drag-end change
		capturedOnNodesChange([
			{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: false },
		]);
		expect(mockSetPipelineState).not.toHaveBeenCalled();

		// Selection change
		capturedOnNodesChange([{ type: 'select', id: 'p1:agent-1', selected: true }]);
		expect(mockSetPipelineState).not.toHaveBeenCalled();
		expect(mockPersistLayout).not.toHaveBeenCalled();
	});

	it('onNodeDragStop commits final positions to pipelineState', () => {
		renderEditor();
		expect(capturedOnNodeDragStop).toBeTruthy();

		const mockEvent = {} as React.MouseEvent;
		const draggedNode = { id: 'p1:agent-1', position: { x: 350, y: 100 } };
		capturedOnNodeDragStop(mockEvent, draggedNode, [draggedNode]);

		expect(mockSetPipelineState).toHaveBeenCalledTimes(1);
		expect(mockPersistLayout).toHaveBeenCalledTimes(1);
	});

	it('onNodeDragStop commits multiple nodes simultaneously', () => {
		renderEditor();
		expect(capturedOnNodeDragStop).toBeTruthy();

		const mockEvent = {} as React.MouseEvent;
		const nodes = [
			{ id: 'p1:trigger-1', position: { x: 50, y: 10 } },
			{ id: 'p1:agent-1', position: { x: 350, y: 100 } },
		];
		capturedOnNodeDragStop(mockEvent, nodes[0], nodes);

		expect(mockSetPipelineState).toHaveBeenCalledTimes(1);
		expect(mockPersistLayout).toHaveBeenCalledTimes(1);
	});

	it('onNodeDragStop does nothing with empty nodes', () => {
		renderEditor();
		expect(capturedOnNodeDragStop).toBeTruthy();

		capturedOnNodeDragStop({} as React.MouseEvent, {} as any, []);

		expect(mockSetPipelineState).not.toHaveBeenCalled();
		expect(mockPersistLayout).not.toHaveBeenCalled();
	});
});
