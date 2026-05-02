/**
 * Regression: empty Cue graph showed a spinner forever instead of the
 * "Create your first pipeline" CTA.
 *
 * Failure trace:
 *   1. `useCueGraphData` finishes its initial fetch with `graphSessions=[]`
 *      and flips `graphInitialLoading` → false.
 *   2. `usePipelineLayout`'s restore effect early-returns when
 *      `graphSessions.length === 0`, so `pipelinesLoaded` stays at its
 *      initial `false`.
 *   3. The editor's `isLoading={graphLoading || !pipelinesLoaded}` evaluates
 *      to `false || true === true`. Spinner renders, CTA never shows.
 *
 * Fix: the editor now gates `!pipelinesLoaded` behind `graphSessions.length > 0`
 * — empty graphSessions after the parent fetch completes correctly falls
 * through to the CTA.
 *
 * These tests assert the four-way truth table on the `isLoading` prop that
 * `CuePipelineEditor` passes to `PipelineCanvas`. Testing at this boundary
 * (rather than via the rendered spinner) keeps the regression coverage
 * decoupled from `PipelineEmptyState` so that component is free to evolve
 * without breaking these guards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import type { CueGraphSession } from '../../../../shared/cue-pipeline-types';

// ─── Captured props ──────────────────────────────────────────────────────────
let capturedIsLoading: boolean | undefined;
let capturedPipelineCount: number | undefined;

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

vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineCanvas', () => ({
	PipelineCanvas: React.memo((props: any) => {
		capturedIsLoading = props.isLoading;
		capturedPipelineCount = props.pipelineCount;
		return <div data-testid="pipeline-canvas" />;
	}),
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineToolbar', () => ({
	PipelineToolbar: () => <div />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineContextMenu', () => ({
	PipelineContextMenu: () => null,
}));

// ─── Stable hook mocks ───────────────────────────────────────────────────────
// Test toggles `mockPipelinesLoaded` and `mockPipelineCount` before each render.
let mockPipelinesLoaded = false;
let mockPipelineCount = 0;

const stableCueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break' as const,
	max_concurrent: 1,
	queue_size: 10,
};

function makeStateHook() {
	const pipelines = Array.from({ length: mockPipelineCount }, (_, i) => ({
		id: `p${i + 1}`,
		name: `Pipeline ${i + 1}`,
		color: '#06b6d4',
		nodes: [],
		edges: [],
	}));
	return {
		pipelineState: { pipelines, selectedPipelineId: null as string | null },
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
		runningPipelineIds: new Set<string>(),
		runningAgentsByPipeline: new Map<string, Set<string>>(),
		runningSubscriptionsByPipeline: new Map<string, Set<string>>(),
		persistLayout: vi.fn(),
		pendingSavedViewportRef: { current: null as null | { x: number; y: number; zoom: number } },
		pipelinesLoaded: mockPipelinesLoaded,
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
}
let stateHookCache = makeStateHook();

vi.mock('../../../../renderer/hooks/cue/usePipelineState', () => ({
	usePipelineState: () => stateHookCache,
	DEFAULT_TRIGGER_LABELS: {},
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

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	convertToReactFlowNodes: vi.fn(() => []),
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

// Synthetic non-empty graph session — content doesn't matter, only `length > 0`.
const SOME_GRAPH_SESSION: CueGraphSession = {
	sessionId: 's1',
	sessionName: 'Agent 1',
	projectRoot: '/tmp',
	subscriptions: [],
} as unknown as CueGraphSession;

function renderEditor({
	graphLoading,
	graphSessions,
}: {
	graphLoading: boolean;
	graphSessions: CueGraphSession[];
}) {
	stateHookCache = makeStateHook();
	render(
		<CuePipelineEditor
			sessions={[]}
			graphSessions={graphSessions}
			onSwitchToSession={vi.fn()}
			onClose={vi.fn()}
			theme={mockTheme}
			graphLoading={graphLoading}
		/>
	);
}

describe('CuePipelineEditor — isLoading gate (regression: empty graph spinner stayed forever)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedIsLoading = undefined;
		capturedPipelineCount = undefined;
		mockPipelinesLoaded = false;
		mockPipelineCount = 0;
	});

	it('shows spinner while parent is fetching graph data (graphLoading=true, empty)', () => {
		mockPipelinesLoaded = false;
		mockPipelineCount = 0;
		renderEditor({ graphLoading: true, graphSessions: [] });
		expect(capturedIsLoading).toBe(true);
		expect(capturedPipelineCount).toBe(0);
	});

	it('shows spinner while parent is fetching graph data (graphLoading=true, non-empty)', () => {
		mockPipelinesLoaded = false;
		mockPipelineCount = 1;
		renderEditor({ graphLoading: true, graphSessions: [SOME_GRAPH_SESSION] });
		expect(capturedIsLoading).toBe(true);
	});

	it('falls through to CTA when graph fetch completes with no sessions', () => {
		// THE REGRESSION. Before the fix, isLoading was true here because
		// pipelinesLoaded never flipped (the layout hook early-returns on
		// empty graphSessions). PipelineCanvas would render the spinner
		// forever and the user would never see "Create your first pipeline".
		mockPipelinesLoaded = false;
		mockPipelineCount = 0;
		renderEditor({ graphLoading: false, graphSessions: [] });
		expect(capturedIsLoading).toBe(false);
		expect(capturedPipelineCount).toBe(0);
	});

	it('keeps spinner up while non-empty graph data is still being restored', () => {
		// graphSessions has data, but the layout hook hasn't finished merging
		// it with the saved layout yet. The editor MUST keep the spinner up
		// or the CTA flashes briefly before the pipelines render.
		mockPipelinesLoaded = false;
		mockPipelineCount = 0;
		renderEditor({ graphLoading: false, graphSessions: [SOME_GRAPH_SESSION] });
		expect(capturedIsLoading).toBe(true);
	});

	it('hides spinner once the layout has been restored', () => {
		mockPipelinesLoaded = true;
		mockPipelineCount = 1;
		renderEditor({ graphLoading: false, graphSessions: [SOME_GRAPH_SESSION] });
		expect(capturedIsLoading).toBe(false);
		expect(capturedPipelineCount).toBe(1);
	});

	it('hides spinner when the prop default kicks in (graphLoading omitted)', () => {
		// Some call sites omit `graphLoading` (the prop is optional, defaults
		// to false). With sessions present and pipelines loaded, the editor
		// must not require the prop to be threaded through.
		mockPipelinesLoaded = true;
		mockPipelineCount = 1;
		stateHookCache = makeStateHook();
		render(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[SOME_GRAPH_SESSION]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);
		expect(capturedIsLoading).toBe(false);
	});
});
