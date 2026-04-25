import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipelineSelection } from '../../../../renderer/hooks/cue/usePipelineSelection';
import type { CuePipelineState } from '../../../../shared/cue-pipeline-types';

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	getTriggerConfigSummary: vi.fn(() => 'summary'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTriggerNode(
	id: string,
	label = 'File Change',
	eventType = 'file.changed',
	extras: Record<string, unknown> = {}
) {
	return {
		id,
		type: 'trigger' as const,
		position: { x: 0, y: 0 },
		data: { eventType, label, config: {}, ...extras },
	};
}

function makeAgentNode(
	id: string,
	sessionId: string,
	sessionName = 'Agent',
	extras: Record<string, unknown> = {}
) {
	return {
		id,
		type: 'agent' as const,
		position: { x: 100, y: 0 },
		data: { sessionId, sessionName, toolType: 'claude-code', ...extras },
	};
}

function makeEdge(
	id: string,
	source: string,
	target: string,
	extras: Record<string, unknown> = {}
) {
	return { id, source, target, mode: 'pass' as const, ...extras };
}

function makePipeline(
	id: string,
	opts: {
		name?: string;
		color?: string;
		nodes?: ReturnType<typeof makeTriggerNode | typeof makeAgentNode>[];
		edges?: ReturnType<typeof makeEdge>[];
	} = {}
) {
	return {
		id,
		name: opts.name ?? 'Pipeline',
		color: opts.color ?? '#ff0000',
		nodes: opts.nodes ?? [],
		edges: opts.edges ?? [],
	};
}

function emptyState(): CuePipelineState {
	return { pipelines: [], selectedPipelineId: null };
}

function mouseEvent(): React.MouseEvent {
	return {} as React.MouseEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePipelineSelection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// --- Initial state ---

	it('returns null selections on mount', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));
		expect(result.current.selectedNodeId).toBeNull();
		expect(result.current.selectedEdgeId).toBeNull();
		expect(result.current.selectedNode).toBeNull();
		expect(result.current.selectedEdge).toBeNull();
	});

	it('returns empty onCanvasSessionIds when no pipelines exist', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));
		expect(result.current.onCanvasSessionIds.size).toBe(0);
	});

	it('returns default edge pipeline color when nothing selected', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));
		expect(result.current.selectedEdgePipelineColor).toBe('#06b6d4');
	});

	// --- onNodeClick ---

	it('onNodeClick sets selectedNodeId and clears selectedEdgeId', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:n1' } as any);
		});

		expect(result.current.selectedNodeId).toBe('p1:n1');
		expect(result.current.selectedEdgeId).toBeNull();
	});

	it('onNodeClick clears a previously selected edge', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.onEdgeClick(mouseEvent(), { id: 'p1:e1' } as any);
		});
		expect(result.current.selectedEdgeId).toBe('p1:e1');

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:n1' } as any);
		});
		expect(result.current.selectedEdgeId).toBeNull();
		expect(result.current.selectedNodeId).toBe('p1:n1');
	});

	// --- onEdgeClick ---

	it('onEdgeClick sets selectedEdgeId and clears selectedNodeId', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.onEdgeClick(mouseEvent(), { id: 'p1:e1' } as any);
		});

		expect(result.current.selectedEdgeId).toBe('p1:e1');
		expect(result.current.selectedNodeId).toBeNull();
	});

	// --- onPaneClick ---

	it('onPaneClick clears both selections', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:n1' } as any);
		});
		act(() => {
			result.current.onPaneClick();
		});

		expect(result.current.selectedNodeId).toBeNull();
		expect(result.current.selectedEdgeId).toBeNull();
	});

	// --- handleConfigureNode ---

	it('handleConfigureNode sets node ID when different from current', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.handleConfigureNode('p1:n1');
		});

		expect(result.current.selectedNodeId).toBe('p1:n1');
		expect(result.current.selectedEdgeId).toBeNull();
	});

	it('handleConfigureNode toggles to null when same ID', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.handleConfigureNode('p1:n1');
		});
		expect(result.current.selectedNodeId).toBe('p1:n1');

		act(() => {
			result.current.handleConfigureNode('p1:n1');
		});
		expect(result.current.selectedNodeId).toBeNull();
	});

	it('handleConfigureNode switches to a new ID without toggling off', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.handleConfigureNode('p1:n1');
		});
		act(() => {
			result.current.handleConfigureNode('p1:n2');
		});

		expect(result.current.selectedNodeId).toBe('p1:n2');
	});

	it('handleConfigureNode clears selectedEdgeId', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.onEdgeClick(mouseEvent(), { id: 'p1:e1' } as any);
		});
		expect(result.current.selectedEdgeId).toBe('p1:e1');

		act(() => {
			result.current.handleConfigureNode('p1:n1');
		});
		expect(result.current.selectedEdgeId).toBeNull();
	});

	// --- Node resolution ---

	it('resolves selectedNode from composite ID', () => {
		const agent = makeAgentNode('n1', 'sess1');
		const pipeline = makePipeline('p1', { nodes: [agent] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:n1' } as any);
		});

		expect(result.current.selectedNode).toEqual(agent);
		expect(result.current.selectedNodePipelineId).toBe('p1');
	});

	it('returns null selectedNode for invalid composite ID (no colon)', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.setSelectedNodeId('invalidid');
		});

		expect(result.current.selectedNode).toBeNull();
		expect(result.current.selectedNodePipelineId).toBeNull();
	});

	it('returns null selectedNode when pipeline not found', () => {
		const state: CuePipelineState = { pipelines: [], selectedPipelineId: null };
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.setSelectedNodeId('missing:n1');
		});

		expect(result.current.selectedNode).toBeNull();
		expect(result.current.selectedNodePipelineId).toBeNull();
	});

	// --- selectedNodeHasOutgoingEdge ---

	it('selectedNodeHasOutgoingEdge is true when node has outgoing edges', () => {
		const trigger = makeTriggerNode('t1', 'Watch');
		const agent = makeAgentNode('a1', 'sess1');
		const edge = makeEdge('e1', 't1', 'a1');
		const pipeline = makePipeline('p1', { nodes: [trigger, agent], edges: [edge] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:t1' } as any);
		});

		expect(result.current.selectedNodeHasOutgoingEdge).toBe(true);
	});

	it('selectedNodeHasOutgoingEdge is false when node has no outgoing edges', () => {
		const agent = makeAgentNode('a1', 'sess1');
		const pipeline = makePipeline('p1', { nodes: [agent], edges: [] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		expect(result.current.selectedNodeHasOutgoingEdge).toBe(false);
	});

	// --- incomingTriggerEdges ---

	it('computes incomingTriggerEdges for an agent node with trigger sources', () => {
		const trigger = makeTriggerNode('t1', 'File Change', 'file_change');
		const agent = makeAgentNode('a1', 'sess1');
		const edge = makeEdge('e1', 't1', 'a1', { prompt: 'do stuff' });
		const pipeline = makePipeline('p1', { nodes: [trigger, agent], edges: [edge] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		expect(result.current.incomingTriggerEdges).toHaveLength(1);
		expect(result.current.incomingTriggerEdges[0]).toEqual({
			edgeId: 'e1',
			triggerLabel: 'File Change',
			configSummary: 'summary',
			prompt: 'do stuff',
		});
	});

	it('uses customLabel over label for trigger edge info', () => {
		const trigger = makeTriggerNode('t1', 'File Change', 'file_change', {
			customLabel: 'My Trigger',
		});
		const agent = makeAgentNode('a1', 'sess1');
		const edge = makeEdge('e1', 't1', 'a1');
		const pipeline = makePipeline('p1', { nodes: [trigger, agent], edges: [edge] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		expect(result.current.incomingTriggerEdges[0].triggerLabel).toBe('My Trigger');
	});

	it('falls back to the event-type default template when edge has no prompt, ignoring agent inputPrompt', () => {
		// Regression guard for the multi-trigger prompt-leakage bug: when a
		// second trigger feeds an agent with no edge.prompt of its own, the UI
		// must NOT fall back to the agent's node-level inputPrompt (which was
		// set by the first trigger). The fallback must be the per-event
		// barebones template so each trigger starts independent.
		const trigger = makeTriggerNode('t1', 'Watch', 'file.changed');
		const agent = makeAgentNode('a1', 'sess1', 'Agent', { inputPrompt: 'first trigger prompt' });
		const edge = makeEdge('e1', 't1', 'a1');
		const pipeline = makePipeline('p1', { nodes: [trigger, agent], edges: [edge] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		// file.changed default is "Changed file: {{CUE_FILE_PATH}}\n\n"; must NOT
		// be the agent's "first trigger prompt".
		expect(result.current.incomingTriggerEdges[0].prompt).toBe(
			'Changed file: {{CUE_FILE_PATH}}\n\n'
		);
		expect(result.current.incomingTriggerEdges[0].prompt).not.toContain('first trigger prompt');
	});

	it('returns the event-type default template when neither edge nor agent has one', () => {
		const trigger = makeTriggerNode('t1', 'Watch', 'time.heartbeat');
		const agent = makeAgentNode('a1', 'sess1');
		const edge = makeEdge('e1', 't1', 'a1');
		const pipeline = makePipeline('p1', { nodes: [trigger, agent], edges: [edge] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		// time.heartbeat default is an empty string (no useful barebones template).
		expect(result.current.incomingTriggerEdges[0].prompt).toBe('');
	});

	// --- hasIncomingAgentEdges ---

	it('hasIncomingAgentEdges is true when agent has incoming edges from other agents', () => {
		const agent1 = makeAgentNode('a1', 'sess1');
		const agent2 = makeAgentNode('a2', 'sess2');
		const edge = makeEdge('e1', 'a1', 'a2');
		const pipeline = makePipeline('p1', { nodes: [agent1, agent2], edges: [edge] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a2' } as any);
		});

		expect(result.current.hasIncomingAgentEdges).toBe(true);
	});

	it('hasIncomingAgentEdges is false for trigger nodes', () => {
		const trigger = makeTriggerNode('t1', 'Watch');
		const pipeline = makePipeline('p1', { nodes: [trigger] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:t1' } as any);
		});

		expect(result.current.hasIncomingAgentEdges).toBe(false);
	});

	// --- Edge resolution ---

	it('resolves selectedEdge and pipeline color from composite edge ID', () => {
		const trigger = makeTriggerNode('t1', 'Watch');
		const agent = makeAgentNode('a1', 'sess1');
		const edge = makeEdge('e1', 't1', 'a1', { prompt: 'go' });
		const pipeline = makePipeline('p1', {
			color: '#00ff00',
			nodes: [trigger, agent],
			edges: [edge],
		});
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onEdgeClick(mouseEvent(), { id: 'p1:e1' } as any);
		});

		expect(result.current.selectedEdge).toEqual(edge);
		expect(result.current.selectedEdgePipelineId).toBe('p1');
		expect(result.current.selectedEdgePipelineColor).toBe('#00ff00');
	});

	it('returns default color when edge pipeline is not found', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		act(() => {
			result.current.onEdgeClick(mouseEvent(), { id: 'missing:e1' } as any);
		});

		expect(result.current.selectedEdgePipelineColor).toBe('#06b6d4');
		expect(result.current.selectedEdge).toBeNull();
	});

	// --- edgeSourceNode / edgeTargetNode ---

	it('resolves edgeSourceNode and edgeTargetNode for selected edge', () => {
		const trigger = makeTriggerNode('t1', 'Watch');
		const agent = makeAgentNode('a1', 'sess1');
		const edge = makeEdge('e1', 't1', 'a1');
		const pipeline = makePipeline('p1', { nodes: [trigger, agent], edges: [edge] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		act(() => {
			result.current.onEdgeClick(mouseEvent(), { id: 'p1:e1' } as any);
		});

		expect(result.current.edgeSourceNode).toEqual(trigger);
		expect(result.current.edgeTargetNode).toEqual(agent);
	});

	it('returns null source/target nodes when no edge is selected', () => {
		const { result } = renderHook(() => usePipelineSelection({ pipelineState: emptyState() }));

		expect(result.current.edgeSourceNode).toBeNull();
		expect(result.current.edgeTargetNode).toBeNull();
	});

	// --- onCanvasSessionIds ---

	it('collects session IDs from agent nodes across all pipelines', () => {
		const a1 = makeAgentNode('a1', 'sess-1');
		const a2 = makeAgentNode('a2', 'sess-2');
		const a3 = makeAgentNode('a3', 'sess-3');
		const trigger = makeTriggerNode('t1', 'Watch');
		const p1 = makePipeline('p1', { nodes: [a1, trigger] });
		const p2 = makePipeline('p2', { nodes: [a2, a3] });
		const state: CuePipelineState = { pipelines: [p1, p2], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		expect(result.current.onCanvasSessionIds).toEqual(new Set(['sess-1', 'sess-2', 'sess-3']));
	});

	it('excludes trigger nodes from onCanvasSessionIds', () => {
		const trigger = makeTriggerNode('t1', 'Watch');
		const pipeline = makePipeline('p1', { nodes: [trigger] });
		const state: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));

		expect(result.current.onCanvasSessionIds.size).toBe(0);
	});

	// --- Reactive updates ---

	it('re-resolves node when pipelineState changes', () => {
		const agent = makeAgentNode('a1', 'sess1');
		const pipeline = makePipeline('p1', { nodes: [agent] });
		const state1: CuePipelineState = { pipelines: [pipeline], selectedPipelineId: 'p1' };

		const { result, rerender } = renderHook(
			({ pipelineState }) => usePipelineSelection({ pipelineState }),
			{ initialProps: { pipelineState: state1 } }
		);

		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});
		expect(result.current.selectedNode).toEqual(agent);

		// Remove the node from pipeline
		const state2: CuePipelineState = {
			pipelines: [makePipeline('p1', { nodes: [] })],
			selectedPipelineId: 'p1',
		};
		rerender({ pipelineState: state2 });

		expect(result.current.selectedNode).toBeNull();
		expect(result.current.selectedNodePipelineId).toBeNull();
	});
});
