/**
 * Regression test for the "single-pipeline node drifts back after a few
 * seconds" bug.
 *
 * Symptom: in single-pipeline editing mode the user moves a node, then a few
 * seconds later it pops back to its previous position. Root cause: the
 * `displayNodes <- computedNodes` resync effect ran on every `activeRuns`
 * polling tick (its deps include the running-state Sets returned fresh from
 * usePipelineState's memos), unconditionally overwriting positions —
 * including ReactFlow's live drag-updated positions on `displayNodes`.
 *
 * Fix: track the `pipelineState.pipelines` reference between resyncs. When
 * pipelines is the SAME reference across two effect fires, the resync was
 * triggered by a non-positional dep (running flags / theme / etc.), so we
 * preserve `displayNodes` positions and only merge non-positional updates
 * from `computedNodes`. When `pipelines` reference changes (drag committed,
 * node added/removed, discard, mount), full sync to `computedNodes` resumes.
 *
 * The previous attempt gated on `isDirty`, which proved unreliable because
 * the dirty effect runs after the resync effect and isn't load-bearing for
 * "did the source-of-truth positions change."
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
	}),
	useNodesInitialized: () => false,
	applyNodeChanges: (changes: any[], nodes: any[]) => {
		const positionById = new Map<string, { x: number; y: number }>();
		for (const c of changes) {
			if (c?.type === 'position' && c.position) positionById.set(c.id, c.position);
		}
		return nodes.map((n) =>
			positionById.has(n.id) ? { ...n, position: positionById.get(n.id) } : n
		);
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
}));

import { CuePipelineEditor } from '../../../../renderer/components/CuePipelineEditor/CuePipelineEditor';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * Build a stateHook return value where the `pipelines` array reference is
 * stable across calls when `pipelinesRef` is reused. This mirrors the real
 * usePipelineState behavior: `pipelineState.pipelines` only gets a new array
 * identity when something actually mutates it (drag commit, add, delete,
 * discard) — NOT on every render.
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

describe('CuePipelineEditor — resync preserves live positions when pipelineState is unchanged', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedNodes = [];
		capturedSetDisplayNodes = null;
	});

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

	it('initial mount: displayNodes mirrors computedNodes', () => {
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		renderEditor();
		expect(capturedNodes).toEqual([
			expect.objectContaining({ id: 'p1:agent-1', position: { x: 0, y: 0 } }),
		]);
	});

	it('polling tick (same pipelines ref): live drag position is preserved', () => {
		// pipelines array kept identity-stable across renders to simulate the
		// real "pipelineState.pipelines didn't actually change" condition.
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		// User drags the node — onNodesChange (which the editor wires through to
		// applyNodeChanges → setDisplayNodes) flushes the new position into the
		// live displayNodes. pipelineState is NOT updated here; that would
		// happen in onNodeDragStop, which we omit to model the real-world
		// failure mode where the commit is missed.
		expect(capturedSetDisplayNodes).toBeTruthy();
		capturedSetDisplayNodes!([
			{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: false },
		]);

		// Poll tick: usePipelineState produces a fresh `runningPipelineIds` Set
		// identity (which forces computedNodes to recompute), but the SAME
		// `pipelines` reference is reused — nothing structural changed.
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(pipelines, { runningPipelineIds: new Set(['p1']) })
		);
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);
		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		const movedNode = capturedNodes.find((n) => n.id === 'p1:agent-1');
		expect(movedNode).toBeTruthy();
		expect(movedNode!.position).toEqual({ x: 350, y: 100 });
	});

	it('pipelineState changes (drag committed): full resync to computedNodes', () => {
		const pipelinesA = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelinesA));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		// User drags. Real flow: onNodesChange updates displayNodes, then
		// onNodeDragStop commits to pipelineState. Both happen.
		capturedSetDisplayNodes!([
			{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: false },
		]);

		// pipelineState now has a NEW pipelines reference reflecting the drop.
		const pipelinesB = makePipelines();
		pipelinesB[0].nodes[0].position = { x: 350, y: 100 };
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelinesB));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 350, 100)]);

		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		const movedNode = capturedNodes.find((n) => n.id === 'p1:agent-1');
		expect(movedNode!.position).toEqual({ x: 350, y: 100 });
	});

	it('pipelineState changes (discard): positions reset to discarded values', () => {
		// Initial state: node at (0, 0). User drags to (500, 500) but doesn't
		// save. Then handleDiscard fires, restoring pipelineState from disk.
		// The discarded position must overwrite the user's local drag.
		const pipelinesInitial = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelinesInitial));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		capturedSetDisplayNodes!([
			{ type: 'position', id: 'p1:agent-1', position: { x: 500, y: 500 }, dragging: false },
		]);

		// Discard: pipelineState reverts to disk values. New `pipelines` ref.
		const pipelinesAfterDiscard = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelinesAfterDiscard));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		const node = capturedNodes.find((n) => n.id === 'p1:agent-1');
		expect(node!.position).toEqual({ x: 0, y: 0 });
	});

	it('polling with new node added (same pipelines ref): edge case — new nodes still appear', () => {
		// Even though `pipelines` ref is unchanged in this contrived scenario,
		// the merge path picks up new ids from computedNodes. Guards against a
		// regression where the preserve branch dropped previously-unseen nodes.
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(pipelines, { runningPipelineIds: new Set(['p1']) })
		);
		mockConvertToReactFlowNodes.mockReturnValue([
			makeNode('p1:agent-1', 0, 0),
			makeNode('p1:agent-2', 500, 500),
		]);

		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(capturedNodes.map((n) => n.id).sort()).toEqual(['p1:agent-1', 'p1:agent-2']);
		const newNode = capturedNodes.find((n) => n.id === 'p1:agent-2');
		expect(newNode!.position).toEqual({ x: 500, y: 500 });
	});
});
