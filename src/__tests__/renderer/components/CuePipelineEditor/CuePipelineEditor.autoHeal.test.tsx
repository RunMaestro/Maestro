/**
 * Auto-heal: the pipeline canvas is machine-formatted (gofmt for pipelines).
 *
 * Whenever a pipeline's TOPOLOGY changes (node added/removed, edge
 * connected/removed, discard reloading from YAML), CuePipelineEditor
 * re-beautifies the board automatically - no Tidy/Arrange click required.
 * Position-only changes (drags) and data-only changes (renames, prompts)
 * must NOT trigger a heal: the untangle order-seed respects drag ordering,
 * and healing on keystrokes would make the config panels unusable.
 *
 * Dirtiness is preserved, not created: when the pre-heal state matched
 * savedStateRef (clean - e.g. right after Discard), the ref advances to the
 * healed snapshot so healing alone never raises the unsaved-changes banner.
 *
 * Harness cloned from CuePipelineEditor.dirtyResyncPreserve.test.tsx (the
 * proven mock set for mounting the editor shell), plus `getNodes` on the
 * ReactFlow instance (the heal snapshots measured widths through it) and
 * `savedStateRef` on the state-hook return (the heal advances it).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

let capturedNodes: any[] = [];
let capturedSetDisplayNodes: ((updater: any) => void) | null = null;

vi.mock('reactflow', () => ({
	default: (props: any) => <div data-testid="react-flow">{props.children}</div>,
	ReactFlowProvider: ({ children }: any) => <>{children}</>,
	useReactFlow: () => ({
		fitView: vi.fn(),
		screenToFlowPosition: vi.fn((pos: any) => pos),
		setViewport: vi.fn(),
		getNodes: vi.fn(() => []),
		zoomIn: vi.fn(),
		zoomOut: vi.fn(),
	}),
	useNodesInitialized: () => false,
	applyNodeChanges: (changes: any[], nodes: any[]) => {
		// Mirror ReactFlow: a position change carries both the new position AND
		// the live `dragging` flag, which the resync guard keys on to skip
		// resyncing mid-gesture.
		const changeById = new Map<
			string,
			{ position?: { x: number; y: number }; dragging?: boolean }
		>();
		for (const c of changes) {
			if (c?.type === 'position')
				changeById.set(c.id, { position: c.position, dragging: c.dragging });
		}
		return nodes.map((n) => {
			const change = changeById.get(n.id);
			if (!change) return n;
			return {
				...n,
				...(change.position ? { position: change.position } : {}),
				dragging: change.dragging,
			};
		});
	},
	Background: () => null,
	Controls: () => null,
	MiniMap: () => null,
	ConnectionMode: { Loose: 'loose' },
	Position: { Left: 'left', Right: 'right' },
	Handle: () => null,
	MarkerType: { ArrowClosed: 'arrowclosed' },
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineCanvas', () => ({
	PipelineCanvas: React.memo((props: any) => {
		capturedNodes = props.nodes;
		capturedSetDisplayNodes = props.onNodesChange ?? null;
		return <div data-testid="pipeline-canvas" />;
	}),
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineToolbar', () => ({
	PipelineToolbar: () => <div />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineContextMenu', () => ({
	PipelineContextMenu: () => null,
}));

const mockUsePipelineState = vi.fn();
vi.mock('../../../../renderer/hooks/cue/usePipelineState', () => ({
	usePipelineState: (...args: any[]) => mockUsePipelineState(...args),
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

const mockConvertToReactFlowNodes = vi.fn();
vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	convertToReactFlowNodes: (...args: any[]) => mockConvertToReactFlowNodes(...args),
	convertToReactFlowEdges: vi.fn(() => []),
	computePipelineYOffsets: vi.fn(() => new Map()),
	// Footprint constants read at module-eval time by pipelineAutoArrange
	// (imported transitively via CuePipelineEditor). Must be present on the mock
	// or the import throws "No export is defined".
	NODE_BG_WIDTH: 320,
	NODE_BG_HEIGHT: 100,
	PIPELINE_GROUP_PADDING: 28,
	resolvePipelineOffset: vi.fn(() => ({ x: 0, y: 0 })),
}));

import { CuePipelineEditor } from '../../../../renderer/components/CuePipelineEditor/CuePipelineEditor';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * Build a stateHook return value where the `pipelines` array reference is
 * stable across calls when `pipelinesRef` is reused. This mirrors the real
 * usePipelineState behavior: `pipelineState.pipelines` only gets a new array
 * identity when something actually mutates it (drag commit, add, delete,
 * discard) - NOT on every render.
 */
function buildStateHookReturn(pipelines: any[], overrides: Record<string, unknown> = {}) {
	return {
		pipelineState: {
			pipelines,
			selectedPipelineId: 'p1',
		},
		setPipelineState: vi.fn(),
		isAllPipelinesView: false,
		isDirty: false,
		setIsDirty: vi.fn(),
		savedStateRef: { current: '' },
		saveStatus: 'idle',
		validationErrors: [],
		cueSettings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
		setCueSettings: vi.fn(),
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
		selectPipeline: vi.fn(),
		changePipelineColor: vi.fn(),
		onUpdateNode: vi.fn(),
		onUpdateEdgePrompt: vi.fn(),
		onDeleteNode: vi.fn(),
		onUpdateEdge: vi.fn(),
		onDeleteEdge: vi.fn(),
		...overrides,
	};
}

function makeNode(id: string, x: number, y: number) {
	return {
		id,
		type: 'agent',
		position: { x, y },
		data: { compositeId: id, sessionId: 's1', sessionName: 'Agent', toolType: 'claude-code' },
	};
}

function makePipelines() {
	return [
		{
			id: 'p1',
			name: 'Pipeline 1',
			color: '#06b6d4',
			nodes: [
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 0, y: 0 },
					data: { sessionId: 's1', sessionName: 'Agent', toolType: 'claude-code' },
				},
			],
			edges: [],
		},
	];
}

/** A pipeline-group "band" backdrop node - only present in the All-Pipelines view. */
function makeBandNode(pipelineId: string) {
	return {
		id: `pipeline-group:${pipelineId}`,
		type: 'pipeline-group',
		position: { x: -28, y: 682 },
		data: { pipelineName: 'Pipeline 1', color: '#06b6d4', width: 376, height: 156 },
		selectable: false,
		draggable: true,
	};
}

function healAgentNode(id: string, x: number, y: number) {
	return {
		id,
		type: 'agent',
		position: { x, y },
		data: { sessionId: id, sessionName: id, toolType: 'claude-code' },
	};
}

function makeChainPipelines(edges: Array<{ id: string; source: string; target: string }>) {
	return [
		{
			id: 'p1',
			name: 'Pipeline 1',
			color: '#06b6d4',
			nodes: [healAgentNode('a1', 0, 0), healAgentNode('a2', 10, 10), healAgentNode('a3', 20, 20)],
			edges: edges.map((e) => ({ ...e, mode: 'pass' })),
		},
	];
}

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

describe('CuePipelineEditor - auto-heal on topology change', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConvertToReactFlowNodes.mockReturnValue([]);
	});

	it('re-beautifies when an edge is added, and persists the layout', () => {
		const before = makeChainPipelines([{ id: 'e1', source: 'a1', target: 'a2' }]);
		const hookReturn = buildStateHookReturn(before);
		mockUsePipelineState.mockReturnValue(hookReturn);
		const { rerender } = renderEditor();

		// Structural mutation: a second edge lands (as onConnect would commit).
		const after = makeChainPipelines([
			{ id: 'e1', source: 'a1', target: 'a2' },
			{ id: 'e2', source: 'a2', target: 'a3' },
		]);
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(after, {
				setPipelineState: hookReturn.setPipelineState,
				persistLayout: hookReturn.persistLayout,
				savedStateRef: hookReturn.savedStateRef,
				isDirty: true,
			})
		);
		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(hookReturn.setPipelineState).toHaveBeenCalled();
		// Apply the functional update to see the healed result: the a1→a2→a3
		// chain must come out in strictly increasing columns.
		const calls = (hookReturn.setPipelineState as any).mock.calls;
		const updater = calls[calls.length - 1][0];
		const healed = updater({ pipelines: after, selectedPipelineId: 'p1' });
		const byId = new Map<string, { x: number; y: number }>(
			healed.pipelines[0].nodes.map((n: any) => [n.id, n.position])
		);
		expect(byId.get('a1')!.x).toBeLessThan(byId.get('a2')!.x);
		expect(byId.get('a2')!.x).toBeLessThan(byId.get('a3')!.x);
		expect(hookReturn.persistLayout).toHaveBeenCalled();
	});

	it('does NOT heal on a position-only change (drag commit)', () => {
		const before = makeChainPipelines([{ id: 'e1', source: 'a1', target: 'a2' }]);
		const hookReturn = buildStateHookReturn(before);
		mockUsePipelineState.mockReturnValue(hookReturn);
		const { rerender } = renderEditor();

		// Same topology, new array identity, moved node - a committed drag.
		const dragged = makeChainPipelines([{ id: 'e1', source: 'a1', target: 'a2' }]);
		dragged[0].nodes[0].position = { x: 999, y: 999 };
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(dragged, {
				setPipelineState: hookReturn.setPipelineState,
				persistLayout: hookReturn.persistLayout,
				isDirty: true,
			})
		);
		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(hookReturn.setPipelineState).not.toHaveBeenCalled();
		expect(hookReturn.persistLayout).not.toHaveBeenCalled();
	});

	it('advances savedStateRef when healing a CLEAN state so the heal never reads as unsaved changes', () => {
		const before = makeChainPipelines([{ id: 'e1', source: 'a1', target: 'a2' }]);
		const hookReturn = buildStateHookReturn(before);
		mockUsePipelineState.mockReturnValue(hookReturn);
		const { rerender } = renderEditor();

		// Discard-like transition: new topology arrives with savedStateRef
		// already matching it (clean).
		const after = makeChainPipelines([
			{ id: 'e1', source: 'a1', target: 'a2' },
			{ id: 'e2', source: 'a2', target: 'a3' },
		]);
		const savedStateRef = { current: JSON.stringify(after) };
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(after, {
				setPipelineState: hookReturn.setPipelineState,
				persistLayout: hookReturn.persistLayout,
				savedStateRef,
			})
		);
		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(hookReturn.setPipelineState).toHaveBeenCalled();
		const calls = (hookReturn.setPipelineState as any).mock.calls;
		const updater = calls[calls.length - 1][0];
		const healed = updater({ pipelines: after, selectedPipelineId: 'p1' });
		// The ref now matches the HEALED snapshot: dirty stays false.
		expect(savedStateRef.current).toBe(JSON.stringify(healed.pipelines));
	});
});
