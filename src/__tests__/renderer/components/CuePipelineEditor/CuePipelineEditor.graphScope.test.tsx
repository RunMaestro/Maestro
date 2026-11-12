/**
 * Agent scope: All Pipelines narrowed to one agent.
 *
 * The scope arrives two ways - CueModal's "View in Graph" sends an
 * `initialGraphTarget` with a scope, and the selector's Agents section sets
 * one directly. Either way the canvas draws ONLY that agent's pipelines,
 * packed together on the fly (never at their All Pipelines coordinates with
 * holes where the rest were), and nothing about the scoped layout is written
 * back to canonical state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, fireEvent, screen } from '@testing-library/react';
import React, { type ReactElement } from 'react';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';

vi.mock('reactflow', () => ({
	default: (props: any) => <div data-testid="react-flow">{props.children}</div>,
	ReactFlowProvider: ({ children }: any) => <>{children}</>,
	useReactFlow: () => ({
		fitView: vi.fn(),
		screenToFlowPosition: vi.fn((pos: any) => pos),
		setViewport: vi.fn(),
		getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
		// Read by the layout passes to space columns from real rendered widths.
		getNodes: vi.fn(() => []),
	}),
	useNodesInitialized: () => false,
	// The collision guard subscribes to measured node widths through the store.
	useStore: (selector: any) => selector({ nodeInternals: new Map() }),
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
		{
			id: 'agent-1',
			type: 'agent' as const,
			position: { x: 400, y: 0 },
			data: { sessionId: 'sess-1', sessionName: 'Marketing', toolType: 'claude-code' },
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
// Parked far from the others in All Pipelines, so a scoped view that kept the
// saved coordinates would leave a huge gap between Alpha and Gamma.
const PIPELINE_C = {
	id: 'p3',
	name: 'Gamma',
	color: '#f59e0b',
	viewOffset: { x: 9000, y: 9000 },
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
	// The scoped view packs its pipelines with the real arranger, which reads
	// each pipeline's current offset through this.
	resolvePipelineOffset: (p: { viewOffset?: { x: number; y: number } }) =>
		p.viewOffset ?? { x: 0, y: 0 },
	NODE_BG_WIDTH: 320,
	NODE_BG_HEIGHT: 100,
}));

import { CuePipelineEditor } from '../../../../renderer/components/CuePipelineEditor/CuePipelineEditor';
import { mockTheme } from '../../../helpers/mockTheme';

type RenderedPipeline = { id: string; name: string; viewOffset?: { x: number; y: number } };

/** Arguments of the last node conversion - i.e. what is on canvas, and how. */
function lastConversion(): unknown[] {
	const calls = convertToReactFlowNodes.mock.calls as unknown as unknown[][];
	return calls[calls.length - 1];
}

function renderedPipelines(): RenderedPipeline[] {
	return lastConversion()[0] as RenderedPipeline[];
}

function renderedPipelineNames(): string[] {
	return renderedPipelines().map((p) => p.name);
}

// The selector registers its open menu with the layer stack.
function render(ui: ReactElement) {
	return rtlRender(<LayerStackProvider>{ui}</LayerStackProvider>);
}

const marketingScope = {
	sessionId: 'sess-1',
	sessionName: 'Marketing',
	pipelineIds: ['p1', 'p3'],
};

const baseProps = {
	sessions: [{ id: 'sess-1', name: 'Marketing', toolType: 'claude-code' }],
	graphSessions: [],
	onSwitchToSession: vi.fn(),
	onClose: vi.fn(),
	theme: mockTheme,
};

describe('CuePipelineEditor agent scope', () => {
	beforeEach(() => {
		convertToReactFlowNodes.mockClear();
		mockSelectPipeline.mockClear();
		stableStateHook.setPipelineState.mockClear();
		pipelineState.selectedPipelineId = null;
	});

	it('draws every pipeline when no scope is supplied', () => {
		render(<CuePipelineEditor {...baseProps} />);
		expect(renderedPipelineNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
	});

	it('draws only the scoped agent pipelines and names the agent on the selector', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{ id: null, nonce: 'n1', scope: marketingScope }}
			/>
		);
		expect(renderedPipelineNames()).toEqual(['Alpha', 'Gamma']);
		expect(screen.getByRole('button', { name: /Marketing/ })).toHaveTextContent('2 pipelines');
		expect(screen.getByTestId('pipeline-scope-clear')).toBeInTheDocument();
	});

	it('packs the scoped pipelines together instead of keeping their All Pipelines coordinates', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{ id: null, nonce: 'n2', scope: marketingScope }}
			/>
		);
		const byId = new Map(renderedPipelines().map((p) => [p.id, p]));
		const gamma = byId.get('p3')!.viewOffset!;
		expect(byId.get('p1')!.viewOffset).toBeDefined();
		// Gamma lives at (9000, 9000) in All Pipelines; scoped, it sits beside Alpha.
		expect(Math.abs(gamma.x)).toBeLessThan(2000);
		expect(Math.abs(gamma.y)).toBeLessThan(2000);
	});

	it('never writes the scoped layout back to canonical state', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{ id: null, nonce: 'n3', scope: marketingScope }}
			/>
		);
		expect(stableStateHook.setPipelineState).not.toHaveBeenCalled();
		// The canonical pipeline still carries its All Pipelines position.
		expect(PIPELINE_C.viewOffset).toEqual({ x: 9000, y: 9000 });
	});

	it('hands the renderer each pipeline home agent for the cluster boxes', () => {
		render(<CuePipelineEditor {...baseProps} />);
		const homes = lastConversion()[7] as Map<string, { sessionName: string }>;
		expect(homes.get('p1')?.sessionName).toBe('Marketing');
		// Beta and Gamma name no agent and nobody declares them: no home.
		expect(homes.has('p2')).toBe(false);
	});

	it('drops the scope from the clear button', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{
					id: null,
					nonce: 'n4',
					scope: { ...marketingScope, pipelineIds: ['p1'] },
				}}
			/>
		);
		expect(renderedPipelineNames()).toEqual(['Alpha']);

		fireEvent.click(screen.getByLabelText('Show all pipelines'));

		expect(renderedPipelineNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
		expect(screen.queryByTestId('pipeline-scope-clear')).not.toBeInTheDocument();
	});

	it('ignores a scope whose pipelines no longer exist', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{
					id: null,
					nonce: 'n5',
					scope: { ...marketingScope, pipelineIds: ['gone'] },
				}}
			/>
		);
		expect(renderedPipelineNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
		expect(screen.queryByTestId('pipeline-scope-clear')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: /All Pipelines/i })).toBeInTheDocument();
	});

	it('narrows to an agent picked in the selector', () => {
		render(<CuePipelineEditor {...baseProps} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));
		fireEvent.click(screen.getByTestId('pipeline-selector-agent-sess-1'));

		// Marketing is drawn only in Alpha.
		expect(renderedPipelineNames()).toEqual(['Alpha']);
		expect(mockSelectPipeline).toHaveBeenCalledWith(null);
	});

	it('keeps the scope as a breadcrumb when one of its pipelines is opened', () => {
		const props = {
			...baseProps,
			initialGraphTarget: { id: null, nonce: 'n6', scope: marketingScope },
		};
		const { rerender } = render(<CuePipelineEditor {...props} />);

		fireEvent.click(screen.getByRole('button', { name: /Marketing/ }));
		fireEvent.click(screen.getByText('Gamma'));
		expect(mockSelectPipeline).toHaveBeenCalledWith('p3');

		// Selection is mocked; land the single-pipeline view by hand.
		pipelineState.selectedPipelineId = 'p3';
		rerender(
			<LayerStackProvider>
				<CuePipelineEditor {...props} />
			</LayerStackProvider>
		);

		const back = screen.getByTestId('pipeline-scope-back');
		expect(back).toHaveTextContent('Marketing');
		fireEvent.click(back);
		expect(mockSelectPipeline).toHaveBeenLastCalledWith(null);
	});

	it('drops the scope when a pipeline outside it is opened', () => {
		render(
			<CuePipelineEditor
				{...baseProps}
				initialGraphTarget={{ id: null, nonce: 'n7', scope: marketingScope }}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Marketing/ }));
		fireEvent.click(screen.getByText('Beta'));

		expect(mockSelectPipeline).toHaveBeenCalledWith('p2');
		// Selection is mocked, so the view stays All Pipelines - now unscoped.
		expect(renderedPipelineNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
		expect(screen.queryByTestId('pipeline-scope-back')).not.toBeInTheDocument();
	});
});
