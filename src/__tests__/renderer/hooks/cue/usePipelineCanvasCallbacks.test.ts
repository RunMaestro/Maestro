import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipelineCanvasCallbacks } from '../../../../renderer/hooks/cue/usePipelineCanvasCallbacks';
import type { CuePipelineState, CuePipeline } from '../../../../shared/cue-pipeline-types';
import type { Node, Edge, ReactFlowInstance } from 'reactflow';

function rfNode(id: string, type: 'trigger' | 'agent'): Node {
	return { id, position: { x: 0, y: 0 }, data: {}, type } as unknown as Node;
}

function rfEdge(id: string, source: string, target: string): Edge {
	return { id, source, target } as Edge;
}

function pipeline(
	id: string,
	nodes: CuePipeline['nodes'],
	edges: CuePipeline['edges'] = []
): CuePipeline {
	return { id, name: id, color: '#abc', nodes, edges };
}

interface SetupOpts {
	pipelines?: CuePipeline[];
	selectedPipelineId?: string | null;
	isAllPipelinesView?: boolean;
	nodes?: Node[];
	edges?: Edge[];
	stableYOffsets?: Map<string, number>;
}

function setup(opts: SetupOpts = {}) {
	const initialPipelines = opts.pipelines ?? [pipeline('p1', [])];
	// Use "in" check so callers can explicitly pass null
	const initialSelected = 'selectedPipelineId' in opts ? (opts.selectedPipelineId ?? null) : 'p1';
	let state: CuePipelineState = {
		pipelines: initialPipelines,
		selectedPipelineId: initialSelected,
	};
	const setPipelineState = vi.fn((u: React.SetStateAction<CuePipelineState>) => {
		state = typeof u === 'function' ? (u as (p: CuePipelineState) => CuePipelineState)(state) : u;
	});
	let displayNodes: Node[] = opts.nodes ?? [];
	const setDisplayNodes = vi.fn((u: React.SetStateAction<Node[]>) => {
		displayNodes = typeof u === 'function' ? (u as (n: Node[]) => Node[])(displayNodes) : u;
	});
	const persistLayout = vi.fn();
	const setSelectedNodeId = vi.fn();
	const setSelectedEdgeId = vi.fn();
	const stableYOffsetsRef = { current: opts.stableYOffsets ?? new Map<string, number>() };

	const reactFlowInstance = {
		screenToFlowPosition: vi.fn(({ x, y }) => ({ x, y })),
	} as unknown as ReactFlowInstance;

	const { result, rerender } = renderHook(
		({ view }) =>
			usePipelineCanvasCallbacks({
				state: { pipelineState: state, isAllPipelinesView: view },
				refs: { stableYOffsetsRef },
				display: { nodes: displayNodes, edges: opts.edges ?? [], setDisplayNodes },
				actions: { setPipelineState, persistLayout },
				selection: { setSelectedNodeId, setSelectedEdgeId },
				reactFlowInstance,
			}),
		{ initialProps: { view: opts.isAllPipelinesView ?? false } }
	);

	return {
		result,
		rerender,
		getState: () => state,
		getDisplayNodes: () => displayNodes,
		setPipelineState,
		setDisplayNodes,
		persistLayout,
		setSelectedNodeId,
		setSelectedEdgeId,
		reactFlowInstance,
	};
}

describe('usePipelineCanvasCallbacks', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('onNodesChange', () => {
		it('updates displayNodes only, does not touch pipelineState', () => {
			const h = setup({ nodes: [rfNode('p1:t1', 'trigger')] });
			act(() => {
				h.result.current.onNodesChange([
					{ id: 'p1:t1', type: 'position', position: { x: 99, y: 99 } },
				]);
			});
			expect(h.setDisplayNodes).toHaveBeenCalled();
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});
	});

	describe('onNodeDragStop', () => {
		it('no-op in All Pipelines view', () => {
			const h = setup({ isAllPipelinesView: true });
			const dragged: Node[] = [{ id: 'p1:t1', position: { x: 5, y: 5 }, data: {} } as Node];
			act(() => {
				h.result.current.onNodeDragStop({} as React.MouseEvent, dragged[0], dragged);
			});
			expect(h.setPipelineState).not.toHaveBeenCalled();
			expect(h.persistLayout).not.toHaveBeenCalled();
		});

		it('commits position and calls persistLayout in single-pipeline view', () => {
			const n1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const h = setup({ pipelines: [pipeline('p1', [n1])] });
			const dragged: Node[] = [{ id: 'p1:t1', position: { x: 200, y: 100 }, data: {} } as Node];
			act(() => {
				h.result.current.onNodeDragStop({} as React.MouseEvent, dragged[0], dragged);
			});
			expect(h.getState().pipelines[0].nodes[0].position).toEqual({ x: 200, y: 100 });
			expect(h.persistLayout).toHaveBeenCalled();
		});

		it('subtracts stableYOffsets in All-Pipelines view', () => {
			const n1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const h = setup({
				pipelines: [pipeline('p1', [n1])],
				selectedPipelineId: null,
				stableYOffsets: new Map([['p1', 500]]),
			});
			const dragged: Node[] = [{ id: 'p1:t1', position: { x: 200, y: 700 }, data: {} } as Node];
			act(() => {
				h.result.current.onNodeDragStop({} as React.MouseEvent, dragged[0], dragged);
			});
			expect(h.getState().pipelines[0].nodes[0].position).toEqual({ x: 200, y: 200 });
		});

		it('no-op with empty draggedNodes array', () => {
			const h = setup({ pipelines: [pipeline('p1', [])] });
			act(() => {
				h.result.current.onNodeDragStop({} as React.MouseEvent, {} as Node, []);
			});
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});
	});

	describe('onConnect', () => {
		it('no-op in All Pipelines view', () => {
			const h = setup({ isAllPipelinesView: true });
			act(() =>
				h.result.current.onConnect({ source: 'p1:t1', target: 'p1:a1' } as Parameters<
					typeof h.result.current.onConnect
				>[0])
			);
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('rejects connection when pipelines differ', () => {
			const h = setup();
			act(() =>
				h.result.current.onConnect({
					source: 'p1:t1',
					target: 'p2:a1',
				} as Parameters<typeof h.result.current.onConnect>[0])
			);
			// Still calls setPipelineState but with prev unchanged — verify via getState
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
		});

		it('rejects when target node is a trigger', () => {
			const t1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const t2 = { ...t1, id: 't2' };
			const h = setup({ pipelines: [pipeline('p1', [t1, t2])] });
			act(() =>
				h.result.current.onConnect({
					source: 'p1:t1',
					target: 'p1:t2',
				} as Parameters<typeof h.result.current.onConnect>[0])
			);
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
		});

		it('creates edge when valid', () => {
			const t1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const a1 = {
				id: 'a1',
				type: 'agent' as const,
				position: { x: 0, y: 0 },
				data: { sessionId: 's1', sessionName: 'A', toolType: 'x', inputPrompt: 'p' },
			};
			const h = setup({ pipelines: [pipeline('p1', [t1, a1])] });
			act(() =>
				h.result.current.onConnect({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof h.result.current.onConnect>[0])
			);
			expect(h.getState().pipelines[0].edges).toHaveLength(1);
			expect(h.getState().pipelines[0].edges[0]).toMatchObject({
				source: 't1',
				target: 'a1',
				mode: 'pass',
			});
		});

		it('auto-populates default prompt when connecting GitHub trigger to prompt-less agent', () => {
			const t1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'github.pull_request' as const, label: 'PR', config: {} },
			};
			const a1 = {
				id: 'a1',
				type: 'agent' as const,
				position: { x: 0, y: 0 },
				data: { sessionId: 's1', sessionName: 'A', toolType: 'x' },
			};
			const h = setup({ pipelines: [pipeline('p1', [t1, a1])] });
			act(() =>
				h.result.current.onConnect({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof h.result.current.onConnect>[0])
			);
			const agent = h.getState().pipelines[0].nodes.find((n) => n.id === 'a1');
			expect((agent?.data as { inputPrompt?: string }).inputPrompt).toBeTruthy();
		});
	});

	describe('isValidConnection', () => {
		it('returns false in All Pipelines view', () => {
			const h = setup({ isAllPipelinesView: true });
			expect(
				h.result.current.isValidConnection({
					source: 'a',
					target: 'b',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('rejects self-loop', () => {
			const h = setup({ nodes: [rfNode('p1:t1', 'trigger')] });
			expect(
				h.result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:t1',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('rejects trigger→trigger', () => {
			const h = setup({
				nodes: [rfNode('p1:t1', 'trigger'), rfNode('p1:t2', 'trigger')],
			});
			expect(
				h.result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:t2',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('rejects target being a trigger', () => {
			const h = setup({
				nodes: [rfNode('p1:a1', 'agent'), rfNode('p1:t1', 'trigger')],
			});
			expect(
				h.result.current.isValidConnection({
					source: 'p1:a1',
					target: 'p1:t1',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('rejects duplicate edge', () => {
			const h = setup({
				nodes: [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')],
				edges: [rfEdge('e1', 'p1:t1', 'p1:a1')],
			});
			expect(
				h.result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('accepts valid new connection', () => {
			const h = setup({
				nodes: [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')],
			});
			expect(
				h.result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(true);
		});

		// Phase 14C — callback identity stability via ref pattern.
		it('keeps callback identity stable across nodes/edges changes', () => {
			let nodes: Node[] = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')];
			let edges: Edge[] = [];
			const { result, rerender } = renderHook(
				({ n, e }: { n: Node[]; e: Edge[] }) =>
					usePipelineCanvasCallbacks({
						state: {
							pipelineState: { pipelines: [pipeline('p1', [])], selectedPipelineId: 'p1' },
							isAllPipelinesView: false,
						},
						refs: { stableYOffsetsRef: { current: new Map() } },
						display: { nodes: n, edges: e, setDisplayNodes: vi.fn() },
						actions: { setPipelineState: vi.fn(), persistLayout: vi.fn() },
						selection: { setSelectedNodeId: vi.fn(), setSelectedEdgeId: vi.fn() },
						reactFlowInstance: { screenToFlowPosition: vi.fn() } as unknown as ReactFlowInstance,
					}),
				{ initialProps: { n: nodes, e: edges } }
			);

			const firstIdentity = result.current.isValidConnection;

			// Swap in new nodes/edges arrays — simulating post-drag applyNodeChanges.
			nodes = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent'), rfNode('p1:a2', 'agent')];
			edges = [rfEdge('e1', 'p1:t1', 'p1:a1')];
			rerender({ n: nodes, e: edges });

			expect(result.current.isValidConnection).toBe(firstIdentity);
		});

		it('callback reads latest nodes/edges via refs (functional correctness preserved)', () => {
			let nodes: Node[] = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')];
			let edges: Edge[] = [];
			const { result, rerender } = renderHook(
				({ n, e }: { n: Node[]; e: Edge[] }) =>
					usePipelineCanvasCallbacks({
						state: {
							pipelineState: { pipelines: [pipeline('p1', [])], selectedPipelineId: 'p1' },
							isAllPipelinesView: false,
						},
						refs: { stableYOffsetsRef: { current: new Map() } },
						display: { nodes: n, edges: e, setDisplayNodes: vi.fn() },
						actions: { setPipelineState: vi.fn(), persistLayout: vi.fn() },
						selection: { setSelectedNodeId: vi.fn(), setSelectedEdgeId: vi.fn() },
						reactFlowInstance: { screenToFlowPosition: vi.fn() } as unknown as ReactFlowInstance,
					}),
				{ initialProps: { n: nodes, e: edges } }
			);

			// First: no edge → valid.
			expect(
				result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof result.current.isValidConnection>[0])
			).toBe(true);

			// Add the edge, rerender. Same callback identity, but now sees the edge.
			edges = [rfEdge('e1', 'p1:t1', 'p1:a1')];
			rerender({ n: nodes, e: edges });
			expect(
				result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('callback identity changes when isAllPipelinesView flips', () => {
			const { result, rerender } = renderHook(
				({ view }: { view: boolean }) =>
					usePipelineCanvasCallbacks({
						state: {
							pipelineState: { pipelines: [pipeline('p1', [])], selectedPipelineId: 'p1' },
							isAllPipelinesView: view,
						},
						refs: { stableYOffsetsRef: { current: new Map() } },
						display: {
							nodes: [rfNode('p1:t1', 'trigger')],
							edges: [],
							setDisplayNodes: vi.fn(),
						},
						actions: { setPipelineState: vi.fn(), persistLayout: vi.fn() },
						selection: { setSelectedNodeId: vi.fn(), setSelectedEdgeId: vi.fn() },
						reactFlowInstance: { screenToFlowPosition: vi.fn() } as unknown as ReactFlowInstance,
					}),
				{ initialProps: { view: false } }
			);

			const firstIdentity = result.current.isValidConnection;
			rerender({ view: true });
			expect(result.current.isValidConnection).not.toBe(firstIdentity);
		});
	});

	describe('onDragOver', () => {
		it('calls preventDefault and sets move dropEffect', () => {
			const h = setup();
			const preventDefault = vi.fn();
			const stopPropagation = vi.fn();
			const event = {
				preventDefault,
				stopPropagation,
				dataTransfer: { dropEffect: '' },
			} as unknown as React.DragEvent;
			h.result.current.onDragOver(event);
			expect(preventDefault).toHaveBeenCalled();
			expect(event.dataTransfer.dropEffect).toBe('move');
		});
	});

	describe('onDrop', () => {
		it('no-op in All Pipelines view', () => {
			const h = setup({ isAllPipelinesView: true });
			const event = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
				dataTransfer: { getData: vi.fn(() => JSON.stringify({ type: 'trigger' })) },
				clientX: 10,
				clientY: 20,
			} as unknown as React.DragEvent;
			h.result.current.onDrop(event);
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('ignores drop without cue-pipeline payload', () => {
			const h = setup();
			const event = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
				dataTransfer: { getData: vi.fn(() => '') },
				clientX: 10,
				clientY: 20,
			} as unknown as React.DragEvent;
			h.result.current.onDrop(event);
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('creates trigger node and defers selection by 50ms', () => {
			const h = setup();
			const event = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
				dataTransfer: {
					getData: vi.fn(() =>
						JSON.stringify({ type: 'trigger', eventType: 'app.startup', label: 'Start' })
					),
				},
				clientX: 100,
				clientY: 200,
			} as unknown as React.DragEvent;
			act(() => {
				h.result.current.onDrop(event);
			});
			// Node created in state
			const newNodes = h.getState().pipelines[0].nodes;
			expect(newNodes).toHaveLength(1);
			expect(newNodes[0].type).toBe('trigger');
			// Selection NOT yet fired
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
			// After 50ms, selection fires
			act(() => vi.advanceTimersByTime(50));
			expect(h.setSelectedNodeId).toHaveBeenCalled();
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
		});

		it('auto-creates pipeline when none exists', () => {
			const h = setup({ pipelines: [], selectedPipelineId: null });
			const event = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
				dataTransfer: {
					getData: vi.fn(() => JSON.stringify({ type: 'trigger', eventType: 'app.startup' })),
				},
				clientX: 100,
				clientY: 200,
			} as unknown as React.DragEvent;
			act(() => {
				h.result.current.onDrop(event);
			});
			expect(h.getState().pipelines).toHaveLength(1);
			expect(h.getState().pipelines[0].nodes).toHaveLength(1);
			expect(h.getState().selectedPipelineId).toBe(h.getState().pipelines[0].id);
		});
	});
});
