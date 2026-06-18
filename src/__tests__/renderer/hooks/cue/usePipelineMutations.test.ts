import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipelineMutations } from '../../../../renderer/hooks/cue/usePipelineMutations';
import type {
	CuePipeline,
	CuePipelineState,
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
} from '../../../../shared/cue-pipeline-types';

function triggerNode(id: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: { eventType: 'app.startup', label: 'Trigger', config: {} },
	};
}

function agentNode(id: string, sessionName = 'Agent'): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 0, y: 0 },
		data: {
			sessionId: `s-${id}`,
			sessionName,
			toolType: 'claude-code',
			inputPrompt: 'p',
		},
	};
}

function pipeline(
	id: string,
	name: string,
	nodes: PipelineNode[],
	edges: PipelineEdge[] = []
): CuePipeline {
	return { id, name, color: '#06b6d4', nodes, edges };
}

function setup(options: {
	pipelines: CuePipeline[];
	selectedNodePipelineId?: string | null;
	selectedEdgePipelineId?: string | null;
}) {
	let state: CuePipelineState = {
		pipelines: options.pipelines,
		selectedPipelineId: options.pipelines[0]?.id ?? null,
	};
	const setPipelineState = vi.fn((updater: React.SetStateAction<CuePipelineState>) => {
		state =
			typeof updater === 'function'
				? (updater as (p: CuePipelineState) => CuePipelineState)(state)
				: updater;
	});
	const setSelectedNodeId = vi.fn();
	const setSelectedEdgeId = vi.fn();

	const { result, rerender } = renderHook(
		({ selectedNode, selectedEdge }) =>
			usePipelineMutations({
				setPipelineState,
				selection: {
					selectedNodePipelineId: selectedNode,
					selectedEdgePipelineId: selectedEdge,
					setSelectedNodeId,
					setSelectedEdgeId,
				},
			}),
		{
			initialProps: {
				selectedNode: options.selectedNodePipelineId ?? null,
				selectedEdge: options.selectedEdgePipelineId ?? null,
			},
		}
	);

	return { result, rerender, getState: () => state, setSelectedNodeId, setSelectedEdgeId };
}

describe('usePipelineMutations', () => {
	describe('onUpdateNode', () => {
		it('no-op when selectedNodePipelineId is null', () => {
			const h = setup({
				pipelines: [pipeline('p1', 'A', [agentNode('n1')])],
				selectedNodePipelineId: null,
			});
			act(() =>
				h.result.current.onUpdateNode('n1', { sessionName: 'X' } as Partial<AgentNodeData>)
			);
			expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe('Agent');
		});

		it('mutates only the node in selected pipeline', () => {
			const h = setup({
				pipelines: [
					pipeline('p1', 'A', [agentNode('n1', 'Alpha')]),
					pipeline('p2', 'B', [agentNode('n1', 'Bravo')]),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() =>
				h.result.current.onUpdateNode('n1', { sessionName: 'Updated' } as Partial<AgentNodeData>)
			);
			expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe(
				'Updated'
			);
			expect((h.getState().pipelines[1].nodes[0].data as AgentNodeData).sessionName).toBe('Bravo');
		});

		it('merges data partial into node data', () => {
			const h = setup({
				pipelines: [
					pipeline('p1', 'A', [
						{
							id: 't1',
							type: 'trigger',
							position: { x: 0, y: 0 },
							data: {
								eventType: 'time.heartbeat',
								label: 'T',
								config: { interval_minutes: 5 },
							} as TriggerNodeData,
						},
					]),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() =>
				h.result.current.onUpdateNode('t1', {
					customLabel: 'Morning',
				} as Partial<TriggerNodeData>)
			);
			const updated = h.getState().pipelines[0].nodes[0].data as TriggerNodeData;
			expect(updated.customLabel).toBe('Morning');
			expect(updated.config.interval_minutes).toBe(5);
		});
	});

	describe('onUpdateEdgePrompt', () => {
		it('no-op when selectedNodePipelineId is null', () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'old' }]
					),
				],
				selectedNodePipelineId: null,
			});
			act(() => h.result.current.onUpdateEdgePrompt('e1', 'new'));
			expect(h.getState().pipelines[0].edges[0].prompt).toBe('old');
		});

		it('updates only the target edge', () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1'), agentNode('a2')],
						[
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'old1' },
							{ id: 'e2', source: 't1', target: 'a2', mode: 'pass', prompt: 'old2' },
						]
					),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() => h.result.current.onUpdateEdgePrompt('e1', 'new1'));
			expect(h.getState().pipelines[0].edges[0].prompt).toBe('new1');
			expect(h.getState().pipelines[0].edges[1].prompt).toBe('old2');
		});
	});

	describe('onDeleteNode', () => {
		it('no-op when selectedNodePipelineId is null', () => {
			const h = setup({
				pipelines: [pipeline('p1', 'A', [triggerNode('t1')])],
				selectedNodePipelineId: null,
			});
			act(() => h.result.current.onDeleteNode('t1'));
			expect(h.getState().pipelines[0].nodes).toHaveLength(1);
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
		});

		it('removes node and all adjacent edges (source and target)', () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1'), agentNode('a2')],
						[
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
							{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
						]
					),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() => h.result.current.onDeleteNode('a1'));
			expect(h.getState().pipelines[0].nodes.map((n) => n.id)).toEqual(['t1', 'a2']);
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
			expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
		});
	});

	describe('onUpdateEdge', () => {
		it('no-op when selectedEdgePipelineId is null', () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }]
					),
				],
				selectedEdgePipelineId: null,
			});
			act(() => h.result.current.onUpdateEdge('e1', { mode: 'debate' }));
			expect(h.getState().pipelines[0].edges[0].mode).toBe('pass');
		});

		it('merges updates, preserving other fields', () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'hi' }]
					),
				],
				selectedEdgePipelineId: 'p1',
			});
			act(() => h.result.current.onUpdateEdge('e1', { mode: 'debate' }));
			const edge = h.getState().pipelines[0].edges[0];
			expect(edge.mode).toBe('debate');
			expect(edge.prompt).toBe('hi');
			expect(edge.source).toBe('t1');
		});
	});

	describe('onDeleteEdge', () => {
		it('no-op when selectedEdgePipelineId is null', () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }]
					),
				],
				selectedEdgePipelineId: null,
			});
			act(() => h.result.current.onDeleteEdge('e1'));
			expect(h.getState().pipelines[0].edges).toHaveLength(1);
			expect(h.setSelectedEdgeId).not.toHaveBeenCalled();
		});

		it('removes edge and clears selection', () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }]
					),
				],
				selectedEdgePipelineId: 'p1',
			});
			act(() => h.result.current.onDeleteEdge('e1'));
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
		});
	});

	describe('selection change across renders', () => {
		it('callbacks pick up new selection ID after rerender', () => {
			const h = setup({
				pipelines: [
					pipeline('p1', 'A', [agentNode('n1', 'Alpha')]),
					pipeline('p2', 'B', [agentNode('n1', 'Bravo')]),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() =>
				h.result.current.onUpdateNode('n1', { sessionName: 'X' } as Partial<AgentNodeData>)
			);
			expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe('X');

			// Rerender with different selection
			h.rerender({ selectedNode: 'p2', selectedEdge: null } as unknown as never);
			act(() =>
				h.result.current.onUpdateNode('n1', { sessionName: 'Y' } as Partial<AgentNodeData>)
			);
			expect((h.getState().pipelines[1].nodes[0].data as AgentNodeData).sessionName).toBe('Y');
			expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe('X');
		});
	});
});
