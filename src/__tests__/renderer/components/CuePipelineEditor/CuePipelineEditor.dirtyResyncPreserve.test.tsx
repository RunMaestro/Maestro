/**
 * Regression test for the "single-pipeline node drifts back after a few
 * seconds" bug.
 *
 * Symptom: in single-pipeline editing mode the user moves a node, then a few
 * seconds later it pops back to its previous position. Root cause: the
 * `displayNodes <- computedNodes` resync effect ran on every `activeRuns`
 * polling tick (its deps include the running-state Sets returned fresh from
 * usePipelineState's memos), unconditionally overwriting positions -
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

describe('CuePipelineEditor - resync preserves live positions when pipelineState is unchanged', () => {
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

		// User drags the node - onNodesChange (which the editor wires through to
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
		// `pipelines` reference is reused - nothing structural changed.
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

	it('poll tick DURING the first move (dragging:true, not yet dirty) never reverts', () => {
		// The FIRST move of a clean pipeline: the live position changes but the
		// drag-stop commit hasn't fired yet, so `isDirty` is still false. A
		// poll-driven recompute landing here must not be adopted - doing so snaps
		// the node out from under the cursor. The drag-in-flight guard (ReactFlow
		// stamps `dragging:true`) skips the resync until the gesture ends.
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		// User is actively dragging: live position moves AND dragging is true.
		// pipelineState is NOT committed yet (commit happens on drag-stop).
		capturedSetDisplayNodes!([
			{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: true },
		]);

		// Poll tick mid-drag: same pipelines ref (no commit), still clean, but
		// computedNodes recomputes to a DIFFERENT geometry. Without the guard this
		// fresh position would be adopted and the node would jump to (999, 999).
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(pipelines, { runningPipelineIds: new Set(['p1']) })
		);
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 999, 999)]);
		rerender(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);

		const heldNode = capturedNodes.find((n) => n.id === 'p1:agent-1');
		expect(heldNode).toBeTruthy();
		// Live drag position is held; the (999, 999) recompute is ignored.
		expect(heldNode!.position).toEqual({ x: 350, y: 100 });
	});

	it('DIRTY (unsaved edits): background recompute never moves an arranged node until save/discard', () => {
		// The core directive: once the user has moved something the pipeline is
		// dirty, and NO background refresh (activeRuns poll, theme, running-state
		// Sets, layout re-fit) may shift anything they have arranged until they
		// Save or Discard. This holds even when the node is at rest (dragging
		// false) and the recompute reports a wildly different geometry.
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines, { isDirty: true }));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		// User dragged earlier; the arranged position is live in displayNodes and
		// the gesture has ended (dragging false). pipelineState already reflects
		// the committed move on the SAME pipelines ref for this test's purposes.
		capturedSetDisplayNodes!([
			{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: false },
		]);

		// Background recompute while dirty: same pipelines ref, same selection, a
		// fresh running-state Set, and a DIFFERENT computed position. The freeze
		// must hold the arranged (350, 100), ignoring the (999, 999) recompute.
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(pipelines, { isDirty: true, runningPipelineIds: new Set(['p1']) })
		);
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 999, 999)]);
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
		expect(node).toBeTruthy();
		expect(node!.position).toEqual({ x: 350, y: 100 });
	});

	it('DIRTY: a brand-new node still appears (adding a node is not a positional revert)', () => {
		// The freeze pins EXISTING nodes' positions but must not hide nodes that
		// genuinely appear (a paste, an undo that re-adds, a band on view switch).
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines, { isDirty: true }));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		capturedSetDisplayNodes!([
			{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: false },
		]);

		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines, { isDirty: true }));
		mockConvertToReactFlowNodes.mockReturnValue([
			makeNode('p1:agent-1', 999, 999),
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

		// Existing node frozen at its arranged spot; new node surfaces fresh.
		const existing = capturedNodes.find((n) => n.id === 'p1:agent-1');
		expect(existing!.position).toEqual({ x: 350, y: 100 });
		const added = capturedNodes.find((n) => n.id === 'p1:agent-2');
		expect(added).toBeTruthy();
		expect(added!.position).toEqual({ x: 500, y: 500 });
	});

	it('DIRTY but user switches pipeline (selection change): adopts the newly selected geometry', () => {
		// Selection change is user navigation, not a background refresh - it must
		// still adopt fresh geometry even while dirty, otherwise switching views
		// would show stale node positions. The user's edits live in pipelineState
		// and reappear (from computedNodes) when they switch back.
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines, { isDirty: true }));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		capturedSetDisplayNodes!([
			{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: false },
		]);

		// Switch to All Pipelines view while dirty: selection p1 → null, fresh
		// computed geometry for the now-visible node.
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(pipelines, {
				isDirty: true,
				pipelineState: { pipelines, selectedPipelineId: null },
				isAllPipelinesView: true,
			})
		);
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 220)]);
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
		expect(node!.position).toEqual({ x: 0, y: 220 });
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

	it('selection change (single → All, same pipelines ref): takes fresh computedNodes geometry', () => {
		// Switching the pipeline selector changes `selectedPipelineId` WITHOUT
		// changing the `pipelines` reference. All-Pipelines view applies a
		// per-pipeline auto-stack yOffset that single-pipeline view does not, so
		// the same composite-id node resolves to a different position. The resync
		// must take the fresh All-view geometry rather than forcing the stale
		// single-view position back on (which made rearrangements appear undone
		// when switching to the All view).
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);

		const { rerender } = renderEditor();

		// User drags the node in single view; live displayNodes now holds (350,100).
		capturedSetDisplayNodes!([
			{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: false },
		]);

		// Switch to All Pipelines view: same `pipelines` ref, selection → null,
		// and computedNodes now reports the auto-stacked position for that node.
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(pipelines, {
				pipelineState: { pipelines, selectedPipelineId: null },
				isAllPipelinesView: true,
			})
		);
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 220)]);

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
		expect(node!.position).toEqual({ x: 0, y: 220 });
	});

	it('polling with new node added (same pipelines ref): edge case - new nodes still appear', () => {
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

	it('band appears on a later fire (selection-change lag): content takes fresh All-view geometry, not stranded single-view positions', () => {
		// Real-world repro of the "nodes outside the block on first open" bug.
		// Switching single → All flips `selectedPipelineId` AND recomputes
		// `computedNodes` (which gains the pipeline-group "band" backdrop and
		// applies the per-pipeline `viewOffset` to content). When those land in
		// SEPARATE effect fires, the `selectionChanged` ref is consumed on the
		// first fire - while displayNodes still holds single-view geometry and no
		// band - so the second fire (band now present) sees selectionChanged=false
		// and the bare `pipelinesChanged || selectionChanged` guard would PRESERVE
		// stale single-view content positions while the freshly-added band lands at
		// its All-view spot, stranding every node above/outside its band.
		// The band-presence guard (`hadBands !== hasBands`) forces a full fresh
		// sync on that second fire.

		// Mount: single view, content at (0,0), no band.
		const pipelines = makePipelines();
		mockUsePipelineState.mockReturnValue(buildStateHookReturn(pipelines));
		mockConvertToReactFlowNodes.mockReturnValue([makeNode('p1:agent-1', 0, 0)]);
		const { rerender } = renderEditor();

		// Fire 1: selection flips to null but computedNodes still lacks the band
		// (single-view geometry lags a render). selectionChanged is consumed here,
		// so displayNodes resyncs to single-view content with no band.
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(pipelines, {
				pipelineState: { pipelines, selectedPipelineId: null },
				isAllPipelinesView: true,
			})
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

		// Fire 2: same pipelines ref + same (null) selection, but computedNodes now
		// includes the band and the viewOffset-shifted content position.
		mockUsePipelineState.mockReturnValue(
			buildStateHookReturn(pipelines, {
				pipelineState: { pipelines, selectedPipelineId: null },
				isAllPipelinesView: true,
			})
		);
		mockConvertToReactFlowNodes.mockReturnValue([
			makeBandNode('p1'),
			makeNode('p1:agent-1', 0, 710),
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

		// Band must be present, and content must take the fresh All-view position
		// (0, 710) - NOT the stale single-view (0, 0) that left it above the band.
		expect(capturedNodes.some((n) => n.id === 'pipeline-group:p1')).toBe(true);
		const node = capturedNodes.find((n) => n.id === 'p1:agent-1');
		expect(node!.position).toEqual({ x: 0, y: 710 });
	});
});
