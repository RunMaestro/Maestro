/**
 * "View in Graph" agent scope.
 *
 * When an agent owns several pipelines, CueModal sends the editor an
 * `initialGraphTarget` with a scope instead of arbitrarily selecting one of
 * them. The All Pipelines view must then draw ONLY that agent's pipelines, and
 * the toolbar chip must be able to drop the scope again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import React from 'react';

vi.mock('reactflow', () => ({
	default: (props: any) => <div data-testid="react-flow">{props.children}</div>,
	ReactFlowProvider: ({ children }: any) => <>{children}</>,
	useReactFlow: () => ({
		fitView: vi.fn(),
		screenToFlowPosition: vi.fn((pos: any) => pos),
		setViewport: vi.fn(),
		getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
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

vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineCanvas', () => ({
	PipelineCanvas: React.memo(() => <div data-testid="pipeline-canvas" />),
}));

const PIPELINE_A = {
	id: 'p1',
	name: 'Alpha',
	color: '#06b6d4',
	nodes: [
		{
			id: 'trigger-1',
			type: 'trigger' as const,
			position: { x: 0, y: 0 },
			data: { eventType: 'time.heartbeat', label: 'Test', config: {} },
		},
	],
	edges: [],
};
const PIPELINE_B = {
	id: 'p2',
	name: 'Beta',
	color: '#8b5cf6',
	nodes: [
		{
			id: 'trigger-2',
			type: 'trigger' as const,
			position: { x: 0, y: 0 },
			data: { eventType: 'time.heartbeat', label: 'Test', config: {} },
		},
	],
	edges: [],
};
const PIPELINE_C = {
	id: 'p3',
	name: 'Gamma',
	color: '#f59e0b',
	nodes: [
		{
			id: 'trigger-3',
			type: 'trigger' as const,
			position: { x: 0, y: 0 },
			data: { eventType: 'time.heartbeat', label: 'Test', config: {} },
		},
	],
	edges: [],
};

const pipelineState = {
	pipelines: [PIPELINE_A, PIPELINE_B, PIPELINE_C],
	selectedPipelineId: null as string | null,
};

const mockSelectPipeline = vi.fn();
const stableStateHook = {
	pipelineState,
	setPipelineState: vi.fn(),
	isAllPipelinesView: true,
	isDirty: false,
	setIsDirty: vi.fn(),
	savedStateRef: { current: '' },
	saveStatus: 'idle' as const,
	validationErrors: [],
	runningPipelineIds: new Set<string>(),
	runningAgentsByPipeline: new Map(),
	runningSubscriptionsByPipeline: new Map(),
	optimisticTriggeredPipelineIds: new Set<string>(),
	markPipelineTriggered: vi.fn(),
	persistLayout: vi.fn(),
	pendingSavedViewportRef: { current: null },
	pipelinesLoaded: true,
	handleSave: vi.fn(),
	handleDiscard: vi.fn(),
	createPipeline: vi.fn(),
	deletePipeline: vi.fn(),
	renamePipeline: vi.fn(),
	selectPipeline: mockSelectPipeline,
	changePipelineColor: vi.fn(),
	onUpdateNode: vi.fn(),
	onUpdateEdgePrompt: vi.fn(),
	onDeleteNode: vi.fn(),
	onUpdateEdge: vi.fn(),
	onDeleteEdge: vi.fn(),
};

vi.mock('../../../../renderer/hooks/cue/usePipelineState', () => ({
	usePipelineState: () => stableStateHook,
	DEFAULT_TRIGGER_LABELS: { 'time.heartbeat': 'Heartbeat' },
	validatePipelines: vi.fn(),
}));

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
	incomingAgentEdges: [],
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

const convertToReactFlowNodes = vi.fn(() => []);
vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	convertToReactFlowNodes: (...args: any[]) => convertToReactFlowNodes(...(args as [])),
	convertToReactFlowEdges: vi.fn(() => []),
	computePipelineYOffsets: vi.fn(() => new Map()),
	NODE_BG_WIDTH: 320,
	NODE_BG_HEIGHT: 100,
}));

import { CuePipelineEditor } from '../../../../renderer/components/CuePipelineEditor/CuePipelineEditor';
import { mockTheme } from '../../../helpers/mockTheme';

/** Pipeline names handed to the last node conversion - i.e. what is on canvas. */
function renderedPipelineNames(): string[] {
	const calls = convertToReactFlowNodes.mock.calls;
	const last = calls[calls.length - 1] as unknown as [{ name: string }[]];
	return last[0].map((p) => p.name);
}

const baseProps = {
	sessions: [],
	graphSessions: [],
	onSwitchToSession: vi.fn(),
	onClose: vi.fn(),
	theme: mockTheme,
};

describe('CuePipelineEditor agent scope', () => {
	beforeEach(() => {
		convertToReactFlowNodes.mockClear();
		mockSelectPipeline.mockClear();
		pipelineState.selectedPipelineId = null;
	});

	it('draws every pipeline when no scope is supplied', () => {
		render(<CuePipelineEditor {...baseProps} />);
		expect(renderedPipelineNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
	});

	it('draws only the scoped agent pipelines', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{
					id: null,
					nonce: 'n1',
					scope: { sessionId: 'sess-1', sessionName: 'Marketing', pipelineIds: ['p1', 'p3'] },
				}}
			/>
		);
		expect(renderedPipelineNames()).toEqual(['Alpha', 'Gamma']);
		expect(screen.getByTestId('pipeline-scope-chip')).toHaveTextContent('Marketing');
		expect(screen.getByTestId('pipeline-scope-chip')).toHaveTextContent('2 pipelines');
	});

	it('drops the scope when the chip is dismissed', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{
					id: null,
					nonce: 'n2',
					scope: { sessionId: 'sess-1', sessionName: 'Marketing', pipelineIds: ['p1'] },
				}}
			/>
		);
		expect(renderedPipelineNames()).toEqual(['Alpha']);

		fireEvent.click(screen.getByLabelText('Show all pipelines'));

		expect(renderedPipelineNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
		expect(screen.queryByTestId('pipeline-scope-chip')).not.toBeInTheDocument();
	});

	it('ignores a scope whose pipelines no longer exist', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{
					id: null,
					nonce: 'n3',
					scope: { sessionId: 'sess-1', sessionName: 'Marketing', pipelineIds: ['gone'] },
				}}
			/>
		);
		expect(renderedPipelineNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
		expect(screen.queryByTestId('pipeline-scope-chip')).not.toBeInTheDocument();
	});
});
