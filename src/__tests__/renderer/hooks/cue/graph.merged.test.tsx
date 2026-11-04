// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/cue/pendingEditsRegistry.test.ts
// Source: src/__tests__/renderer/hooks/cue/useCueVisibilityWiring.test.ts
// Source: src/__tests__/renderer/hooks/cue/usePipelineCanvasCallbacks.test.ts
// Source: src/__tests__/renderer/hooks/cue/usePipelineContextMenu.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
	registerPendingEdit,
	flushAllPendingEdits,
	__resetPendingEditsRegistryForTests,
} from '../../../../renderer/hooks/cue/pendingEditsRegistry';
import { renderHook as s2_renderHook } from '@testing-library/react';
import { useCueVisibilityWiring } from '../../../../renderer/hooks/cue/useCueVisibilityWiring';
import { renderHook as s3_renderHook, act as s3_act } from '@testing-library/react';
import { usePipelineCanvasCallbacks } from '../../../../renderer/hooks/cue/usePipelineCanvasCallbacks';
import type {
	CuePipelineState as S3_CuePipelineState,
	CuePipeline,
} from '../../../../shared/cue-pipeline-types';
import type { Node as S3_Node, Edge, ReactFlowInstance } from 'reactflow';
import { renderHook as s4_renderHook, act as s4_act } from '@testing-library/react';
import { usePipelineContextMenu } from '../../../../renderer/hooks/cue/usePipelineContextMenu';
import type {
	CuePipelineState as S4_CuePipelineState,
	PipelineNode,
} from '../../../../shared/cue-pipeline-types';
import type { Node as S4_Node } from 'reactflow';
// Source: src/__tests__/renderer/hooks/cue/pendingEditsRegistry.test.ts
describe('', () => {
	describe('pendingEditsRegistry', () => {
		afterEach(() => {
			__resetPendingEditsRegistryForTests();
		});
		it('flushAllPendingEdits invokes every registered callback', () => {
			const a = vi.fn();
			const b = vi.fn();
			registerPendingEdit(a);
			registerPendingEdit(b);
			flushAllPendingEdits();
			expect(a).toHaveBeenCalledTimes(1);
			expect(b).toHaveBeenCalledTimes(1);
		});
		it('unregister prevents subsequent invocation', () => {
			const cb = vi.fn();
			const unregister = registerPendingEdit(cb);
			unregister();
			flushAllPendingEdits();
			expect(cb).not.toHaveBeenCalled();
		});
		it('registering the same callback twice coalesces via Set semantics', () => {
			const cb = vi.fn();
			registerPendingEdit(cb);
			registerPendingEdit(cb);
			flushAllPendingEdits();
			expect(cb).toHaveBeenCalledTimes(1);
		});
	});
});
// Source: src/__tests__/renderer/hooks/cue/useCueVisibilityWiring.test.ts
describe('', () => {
	describe('useCueVisibilityWiring', () => {
		let setActive: ReturnType<typeof vi.fn>;
		beforeEach(() => {
			setActive = vi.fn().mockResolvedValue(undefined);
			// The cue mock is provided by setup.ts but reset call counts here.
			(
				window.maestro.cue as unknown as {
					setActive: typeof setActive;
				}
			).setActive = setActive;
			// Reset visibility to "visible" between tests.
			Object.defineProperty(document, 'hidden', { configurable: true, value: false });
		});
		afterEach(() => {
			vi.clearAllMocks();
		});
		it('seeds main process with current visibility state on mount', () => {
			Object.defineProperty(document, 'hidden', { configurable: true, value: true });
			s2_renderHook(() => useCueVisibilityWiring(true));
			expect(setActive).toHaveBeenCalledTimes(1);
			expect(setActive).toHaveBeenCalledWith(false);
		});
		it('seeds with active=true when document is visible at mount', () => {
			Object.defineProperty(document, 'hidden', { configurable: true, value: false });
			s2_renderHook(() => useCueVisibilityWiring(true));
			expect(setActive).toHaveBeenCalledTimes(1);
			expect(setActive).toHaveBeenCalledWith(true);
		});
		it('forwards visibilitychange events as setActive(!hidden)', () => {
			s2_renderHook(() => useCueVisibilityWiring(true));
			expect(setActive).toHaveBeenCalledWith(true); // mount seed
			// Hide the document and dispatch the event
			Object.defineProperty(document, 'hidden', { configurable: true, value: true });
			document.dispatchEvent(new Event('visibilitychange'));
			expect(setActive).toHaveBeenLastCalledWith(false);
			// Show the document again
			Object.defineProperty(document, 'hidden', { configurable: true, value: false });
			document.dispatchEvent(new Event('visibilitychange'));
			expect(setActive).toHaveBeenLastCalledWith(true);
		});
		it('removes its visibilitychange listener on unmount', () => {
			const { unmount } = s2_renderHook(() => useCueVisibilityWiring(true));
			setActive.mockClear();
			unmount();
			Object.defineProperty(document, 'hidden', { configurable: true, value: true });
			document.dispatchEvent(new Event('visibilitychange'));
			expect(setActive).not.toHaveBeenCalled();
		});
		it('does not throw when window.maestro.cue is missing', () => {
			const original = window.maestro.cue;
			(
				window.maestro as unknown as {
					cue: unknown;
				}
			).cue = undefined;
			try {
				expect(() => s2_renderHook(() => useCueVisibilityWiring(true))).not.toThrow();
			} finally {
				(
					window.maestro as unknown as {
						cue: unknown;
					}
				).cue = original;
			}
		});
		it('swallows IPC rejection without throwing', async () => {
			setActive.mockRejectedValue(new Error('IPC error'));
			expect(() => s2_renderHook(() => useCueVisibilityWiring(true))).not.toThrow();
			// Wait a microtask for the catch handler.
			await Promise.resolve();
		});
		it('sends nothing and listens to nothing while Cue is disabled', () => {
			s2_renderHook(() => useCueVisibilityWiring(false));
			expect(setActive).not.toHaveBeenCalled();
			Object.defineProperty(document, 'hidden', { configurable: true, value: true });
			document.dispatchEvent(new Event('visibilitychange'));
			expect(setActive).not.toHaveBeenCalled();
		});
		it('seeds visibility when Cue is switched back on', () => {
			const { rerender } = s2_renderHook(({ enabled }) => useCueVisibilityWiring(enabled), {
				initialProps: { enabled: false },
			});
			expect(setActive).not.toHaveBeenCalled();
			rerender({ enabled: true });
			expect(setActive).toHaveBeenCalledWith(true);
		});
	});
});
// Source: src/__tests__/renderer/hooks/cue/usePipelineCanvasCallbacks.test.ts
describe('', () => {
	function rfNode(id: string, type: 'trigger' | 'agent'): S3_Node {
		return { id, position: { x: 0, y: 0 }, data: {}, type } as unknown as S3_Node;
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
		nodes?: S3_Node[];
		edges?: Edge[];
		stableYOffsets?: Map<string, number>;
	}
	function setup(opts: SetupOpts = {}) {
		const initialPipelines = opts.pipelines ?? [pipeline('p1', [])];
		// Use "in" check so callers can explicitly pass null
		const initialSelected = 'selectedPipelineId' in opts ? (opts.selectedPipelineId ?? null) : 'p1';
		let state: S3_CuePipelineState = {
			pipelines: initialPipelines,
			selectedPipelineId: initialSelected,
		};
		const setPipelineState = vi.fn((u: React.SetStateAction<S3_CuePipelineState>) => {
			state =
				typeof u === 'function' ? (u as (p: S3_CuePipelineState) => S3_CuePipelineState)(state) : u;
		});
		let displayNodes: S3_Node[] = opts.nodes ?? [];
		const setDisplayNodes = vi.fn((u: React.SetStateAction<S3_Node[]>) => {
			displayNodes = typeof u === 'function' ? (u as (n: S3_Node[]) => S3_Node[])(displayNodes) : u;
		});
		const persistLayout = vi.fn();
		const setSelectedNodeId = vi.fn();
		const setSelectedEdgeId = vi.fn();
		const stableYOffsetsRef = { current: opts.stableYOffsets ?? new Map<string, number>() };
		const reactFlowInstance = {
			screenToFlowPosition: vi.fn(({ x, y }) => ({ x, y })),
		} as unknown as ReactFlowInstance;
		const { result, rerender } = s3_renderHook(
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
			it('updates displayNodes only for non-remove changes, does not touch pipelineState', () => {
				const h = setup({ nodes: [rfNode('p1:t1', 'trigger')] });
				s3_act(() => {
					h.result.current.onNodesChange([
						{ id: 'p1:t1', type: 'position', position: { x: 99, y: 99 } },
					]);
				});
				expect(h.setDisplayNodes).toHaveBeenCalled();
				expect(h.setPipelineState).not.toHaveBeenCalled();
			});
			it('commits remove changes (box-select delete) to pipelineState and prunes connected edges', () => {
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
					data: { sessionId: 's1', sessionName: 'A', toolType: 'x' },
				};
				const h = setup({
					pipelines: [
						pipeline('p1', [t1, a1], [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }]),
					],
				});
				s3_act(() => {
					h.result.current.onNodesChange([
						{ id: 'p1:t1', type: 'remove' },
						{ id: 'p1:a1', type: 'remove' },
					]);
				});
				expect(h.getState().pipelines[0].nodes).toHaveLength(0);
				// Edge connected to the removed nodes is pruned too.
				expect(h.getState().pipelines[0].edges).toHaveLength(0);
				// Selection cleared so a stale composite id can't linger.
				expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
				expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
			});
			it('does not commit remove changes in All Pipelines view (read-only)', () => {
				const t1 = {
					id: 't1',
					type: 'trigger' as const,
					position: { x: 0, y: 0 },
					data: { eventType: 'app.startup' as const, label: 'T', config: {} },
				};
				const h = setup({ pipelines: [pipeline('p1', [t1])], isAllPipelinesView: true });
				s3_act(() => {
					h.result.current.onNodesChange([{ id: 'p1:t1', type: 'remove' }]);
				});
				expect(h.setPipelineState).not.toHaveBeenCalled();
				expect(h.getState().pipelines[0].nodes).toHaveLength(1);
			});
		});
		describe('onEdgesChange', () => {
			it('commits edge remove changes to pipelineState', () => {
				const h = setup({
					pipelines: [
						pipeline(
							'p1',
							[],
							[
								{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
								{ id: 'e2', source: 't1', target: 'a2', mode: 'pass' },
							]
						),
					],
				});
				s3_act(() => {
					h.result.current.onEdgesChange([{ id: 'p1:e1', type: 'remove' }]);
				});
				expect(h.getState().pipelines[0].edges).toHaveLength(1);
				expect(h.getState().pipelines[0].edges[0].id).toBe('e2');
				expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
			});
			it('no-op for non-remove edge changes', () => {
				const h = setup({
					pipelines: [pipeline('p1', [], [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }])],
				});
				s3_act(() => {
					h.result.current.onEdgesChange([{ id: 'p1:e1', type: 'select', selected: true }]);
				});
				expect(h.setPipelineState).not.toHaveBeenCalled();
				expect(h.getState().pipelines[0].edges).toHaveLength(1);
			});
			it('no-op in All Pipelines view (read-only)', () => {
				const h = setup({
					pipelines: [pipeline('p1', [], [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }])],
					isAllPipelinesView: true,
				});
				s3_act(() => {
					h.result.current.onEdgesChange([{ id: 'p1:e1', type: 'remove' }]);
				});
				expect(h.setPipelineState).not.toHaveBeenCalled();
				expect(h.getState().pipelines[0].edges).toHaveLength(1);
			});
		});
		describe('onNodeDrag (pipeline-group child translation)', () => {
			// Regression: ReactFlow fires onNodesChange (which moves the group node)
			// BEFORE onNodeDrag. An incremental per-frame delta read the group's
			// already-updated position and computed zero, stranding the child nodes
			// outside the dragged card. The absolute delta (start + total) must keep
			// children locked to the group regardless of that ordering.
			it('translates children by the full delta even when the group moved first', () => {
				const groupId = 'pipeline-group:p1';
				const group = {
					id: groupId,
					type: 'pipeline-group',
					position: { x: 10, y: 10 },
					data: {},
				} as unknown as S3_Node;
				const child1 = {
					id: 'p1:t1',
					type: 'trigger',
					position: { x: 20, y: 30 },
					data: {},
				} as unknown as S3_Node;
				const child2 = {
					id: 'p1:a1',
					type: 'agent',
					position: { x: 60, y: 80 },
					data: {},
				} as unknown as S3_Node;
				const h = setup({
					pipelines: [pipeline('p1', [])],
					selectedPipelineId: null,
					isAllPipelinesView: true,
					nodes: [group, child1, child2],
				});
				// 1) Drag start snapshots child start positions.
				s3_act(() => {
					h.result.current.onNodeDragStart({} as React.MouseEvent, group, [group]);
				});
				// 2) ReactFlow moves the GROUP node first (the bug trigger).
				s3_act(() => {
					h.result.current.onNodesChange([
						{ id: groupId, type: 'position', position: { x: 50, y: 70 }, dragging: true },
					]);
				});
				// 3) onNodeDrag fires with the group already at its new position.
				const movedGroup = { ...group, position: { x: 50, y: 70 } } as S3_Node;
				s3_act(() => {
					h.result.current.onNodeDrag({} as React.MouseEvent, movedGroup, [movedGroup]);
				});
				// Delta = (40, 60); children must track it exactly.
				const dn = h.getDisplayNodes();
				expect(dn.find((n) => n.id === 'p1:t1')!.position).toEqual({ x: 60, y: 90 });
				expect(dn.find((n) => n.id === 'p1:a1')!.position).toEqual({ x: 100, y: 140 });
				// The group node itself is moved by ReactFlow, not this handler.
				expect(dn.find((n) => n.id === groupId)!.position).toEqual({ x: 50, y: 70 });
			});
			it('ignores drags that did not originate on a pipeline-group node', () => {
				const child = {
					id: 'p1:t1',
					type: 'trigger',
					position: { x: 20, y: 30 },
					data: {},
				} as unknown as S3_Node;
				const h = setup({
					pipelines: [pipeline('p1', [])],
					selectedPipelineId: null,
					isAllPipelinesView: true,
					nodes: [child],
				});
				// No dragStart for a group → ref is null → onNodeDrag is a no-op.
				s3_act(() => {
					h.result.current.onNodeDrag({} as React.MouseEvent, child, [child]);
				});
				expect(h.getDisplayNodes().find((n) => n.id === 'p1:t1')!.position).toEqual({
					x: 20,
					y: 30,
				});
			});
		});
		describe('onNodeDragStop', () => {
			it('no-op in All Pipelines view', () => {
				const h = setup({ isAllPipelinesView: true });
				const dragged: S3_Node[] = [{ id: 'p1:t1', position: { x: 5, y: 5 }, data: {} } as S3_Node];
				s3_act(() => {
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
				const dragged: S3_Node[] = [
					{ id: 'p1:t1', position: { x: 200, y: 100 }, data: {} } as S3_Node,
				];
				s3_act(() => {
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
				const dragged: S3_Node[] = [
					{ id: 'p1:t1', position: { x: 200, y: 700 }, data: {} } as S3_Node,
				];
				s3_act(() => {
					h.result.current.onNodeDragStop({} as React.MouseEvent, dragged[0], dragged);
				});
				expect(h.getState().pipelines[0].nodes[0].position).toEqual({ x: 200, y: 200 });
			});
			it('no-op with empty draggedNodes array', () => {
				const h = setup({ pipelines: [pipeline('p1', [])] });
				s3_act(() => {
					h.result.current.onNodeDragStop({} as React.MouseEvent, {} as S3_Node, []);
				});
				expect(h.setPipelineState).not.toHaveBeenCalled();
			});
		});
		describe('onConnect', () => {
			it('no-op in All Pipelines view', () => {
				const h = setup({ isAllPipelinesView: true });
				s3_act(() =>
					h.result.current.onConnect({ source: 'p1:t1', target: 'p1:a1' } as Parameters<
						typeof h.result.current.onConnect
					>[0])
				);
				expect(h.setPipelineState).not.toHaveBeenCalled();
			});
			it('rejects connection when pipelines differ', () => {
				const h = setup();
				s3_act(() =>
					h.result.current.onConnect({
						source: 'p1:t1',
						target: 'p2:a1',
					} as Parameters<typeof h.result.current.onConnect>[0])
				);
				// Still calls setPipelineState but with prev unchanged - verify via getState
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
				s3_act(() =>
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
				s3_act(() =>
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
				s3_act(() =>
					h.result.current.onConnect({
						source: 'p1:t1',
						target: 'p1:a1',
					} as Parameters<typeof h.result.current.onConnect>[0])
				);
				const agent = h.getState().pipelines[0].nodes.find((n) => n.id === 'a1');
				expect(
					(
						agent?.data as {
							inputPrompt?: string;
						}
					).inputPrompt
				).toBeTruthy();
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
			// Phase 14C - callback identity stability via ref pattern.
			it('keeps callback identity stable across nodes/edges changes', () => {
				let nodes: S3_Node[] = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')];
				let edges: Edge[] = [];
				const { result, rerender } = s3_renderHook(
					({ n, e }: { n: S3_Node[]; e: Edge[] }) =>
						usePipelineCanvasCallbacks({
							state: {
								pipelineState: { pipelines: [pipeline('p1', [])], selectedPipelineId: 'p1' },
								isAllPipelinesView: false,
							},
							refs: { stableYOffsetsRef: { current: new Map() } },
							display: { nodes: n, edges: e, setDisplayNodes: vi.fn() },
							actions: { setPipelineState: vi.fn(), persistLayout: vi.fn() },
							selection: { setSelectedNodeId: vi.fn(), setSelectedEdgeId: vi.fn() },
							reactFlowInstance: {
								screenToFlowPosition: vi.fn(),
							} as unknown as ReactFlowInstance,
						}),
					{ initialProps: { n: nodes, e: edges } }
				);
				const firstIdentity = result.current.isValidConnection;
				// Swap in new nodes/edges arrays - simulating post-drag applyNodeChanges.
				nodes = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent'), rfNode('p1:a2', 'agent')];
				edges = [rfEdge('e1', 'p1:t1', 'p1:a1')];
				rerender({ n: nodes, e: edges });
				expect(result.current.isValidConnection).toBe(firstIdentity);
			});
			it('callback reads latest nodes/edges via refs (functional correctness preserved)', () => {
				let nodes: S3_Node[] = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')];
				let edges: Edge[] = [];
				const { result, rerender } = s3_renderHook(
					({ n, e }: { n: S3_Node[]; e: Edge[] }) =>
						usePipelineCanvasCallbacks({
							state: {
								pipelineState: { pipelines: [pipeline('p1', [])], selectedPipelineId: 'p1' },
								isAllPipelinesView: false,
							},
							refs: { stableYOffsetsRef: { current: new Map() } },
							display: { nodes: n, edges: e, setDisplayNodes: vi.fn() },
							actions: { setPipelineState: vi.fn(), persistLayout: vi.fn() },
							selection: { setSelectedNodeId: vi.fn(), setSelectedEdgeId: vi.fn() },
							reactFlowInstance: {
								screenToFlowPosition: vi.fn(),
							} as unknown as ReactFlowInstance,
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
				const { result, rerender } = s3_renderHook(
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
							reactFlowInstance: {
								screenToFlowPosition: vi.fn(),
							} as unknown as ReactFlowInstance,
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
				s3_act(() => {
					h.result.current.onDrop(event);
				});
				// Node created in state
				const newNodes = h.getState().pipelines[0].nodes;
				expect(newNodes).toHaveLength(1);
				expect(newNodes[0].type).toBe('trigger');
				// Selection NOT yet fired
				expect(h.setSelectedNodeId).not.toHaveBeenCalled();
				// After 50ms, selection fires
				s3_act(() => vi.advanceTimersByTime(50));
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
				s3_act(() => {
					h.result.current.onDrop(event);
				});
				expect(h.getState().pipelines).toHaveLength(1);
				expect(h.getState().pipelines[0].nodes).toHaveLength(1);
				expect(h.getState().selectedPipelineId).toBe(h.getState().pipelines[0].id);
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/cue/usePipelineContextMenu.test.ts
describe('', () => {
	function triggerNode(id: string): PipelineNode {
		return {
			id,
			type: 'trigger',
			position: { x: 10, y: 20 },
			data: { eventType: 'app.startup', label: 'T', config: {}, customLabel: 'MyTrigger' },
		};
	}
	function rfNode(id: string, type: 'trigger' | 'agent'): S4_Node {
		return { id, position: { x: 0, y: 0 }, data: {}, type } as unknown as S4_Node;
	}
	function stubEvent(x = 10, y = 20): React.MouseEvent {
		return {
			preventDefault: vi.fn(),
			clientX: x,
			clientY: y,
		} as unknown as React.MouseEvent;
	}
	function setup(
		options: {
			isAllPipelinesView?: boolean;
			pipelines?: PipelineNode[];
		} = {}
	) {
		let pipelineState: S4_CuePipelineState = {
			pipelines: [
				{
					id: 'p1',
					name: 'Pipeline 1',
					color: '#abc',
					nodes: options.pipelines ?? [triggerNode('t1')],
					edges: [],
				},
			],
			selectedPipelineId: 'p1',
		};
		const setPipelineState = vi.fn((u: React.SetStateAction<S4_CuePipelineState>) => {
			pipelineState =
				typeof u === 'function'
					? (u as (p: S4_CuePipelineState) => S4_CuePipelineState)(pipelineState)
					: u;
		});
		const setSelectedNodeId = vi.fn();
		const setSelectedEdgeId = vi.fn();
		const { result, rerender } = s4_renderHook(
			({ isAllPipelinesView }) =>
				usePipelineContextMenu({
					isAllPipelinesView,
					setPipelineState,
					setSelectedNodeId,
					setSelectedEdgeId,
				}),
			{ initialProps: { isAllPipelinesView: options.isAllPipelinesView ?? false } }
		);
		return {
			result,
			rerender,
			getState: () => pipelineState,
			setPipelineState,
			setSelectedNodeId,
			setSelectedEdgeId,
		};
	}
	describe('usePipelineContextMenu', () => {
		describe('onNodeContextMenu', () => {
			it('opens menu with coordinates + parsed node info', () => {
				const h = setup();
				const ev = stubEvent(120, 340);
				s4_act(() => h.result.current.onNodeContextMenu(ev, rfNode('p1:t1', 'trigger')));
				expect(h.result.current.contextMenu).toEqual({
					x: 120,
					y: 340,
					nodeId: 't1',
					pipelineId: 'p1',
					nodeType: 'trigger',
				});
				expect(ev.preventDefault).toHaveBeenCalled();
			});
			it('is a no-op in All Pipelines view', () => {
				const h = setup({ isAllPipelinesView: true });
				const ev = stubEvent();
				s4_act(() => h.result.current.onNodeContextMenu(ev, rfNode('p1:t1', 'trigger')));
				expect(h.result.current.contextMenu).toBeNull();
				expect(ev.preventDefault).toHaveBeenCalled();
			});
			it('rejects malformed node ids (no colon separator)', () => {
				const h = setup();
				s4_act(() =>
					h.result.current.onNodeContextMenu(stubEvent(), rfNode('malformed', 'trigger'))
				);
				expect(h.result.current.contextMenu).toBeNull();
			});
		});
		describe('handleContextMenuConfigure', () => {
			it('selects node + closes menu', () => {
				const h = setup();
				s4_act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
				s4_act(() => h.result.current.handleContextMenuConfigure());
				expect(h.setSelectedNodeId).toHaveBeenCalledWith('p1:t1');
				expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
				expect(h.result.current.contextMenu).toBeNull();
			});
			it('view switch between open and action → closes menu without mutation', () => {
				const h = setup();
				s4_act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
				h.rerender({ isAllPipelinesView: true });
				s4_act(() => h.result.current.handleContextMenuConfigure());
				expect(h.setSelectedNodeId).not.toHaveBeenCalled();
				expect(h.result.current.contextMenu).toBeNull();
			});
			it('no-op when menu is already null', () => {
				const h = setup();
				s4_act(() => h.result.current.handleContextMenuConfigure());
				expect(h.setSelectedNodeId).not.toHaveBeenCalled();
			});
		});
		describe('handleContextMenuDelete', () => {
			it('removes node + adjacent edges, clears selection + menu', () => {
				const h = setup();
				s4_act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
				s4_act(() => h.result.current.handleContextMenuDelete());
				expect(h.getState().pipelines[0].nodes.map((n) => n.id)).not.toContain('t1');
				expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
				expect(h.result.current.contextMenu).toBeNull();
			});
			it('view switch → closes menu without state change', () => {
				const h = setup();
				s4_act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
				h.rerender({ isAllPipelinesView: true });
				s4_act(() => h.result.current.handleContextMenuDelete());
				expect(h.setPipelineState).not.toHaveBeenCalled();
				expect(h.result.current.contextMenu).toBeNull();
			});
		});
		describe('handleContextMenuDuplicate', () => {
			it('duplicates trigger with +50px offset', () => {
				const h = setup();
				s4_act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
				s4_act(() => h.result.current.handleContextMenuDuplicate());
				const newNodes = h.getState().pipelines[0].nodes;
				expect(newNodes).toHaveLength(2);
				const newNode = newNodes[1];
				expect(newNode.position).toEqual({ x: 60, y: 70 });
				expect(newNode.type).toBe('trigger');
			});
			it('no-op for agent nodes', () => {
				const h = setup();
				s4_act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'agent')));
				s4_act(() => h.result.current.handleContextMenuDuplicate());
				expect(h.setPipelineState).not.toHaveBeenCalled();
			});
			it('view switch → closes menu without duplicate', () => {
				const h = setup();
				s4_act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
				h.rerender({ isAllPipelinesView: true });
				s4_act(() => h.result.current.handleContextMenuDuplicate());
				// Note: setPipelineState may be called initially by onNodeContextMenu - but it isn't, so
				// only check no state change after duplicate attempt
				expect(h.getState().pipelines[0].nodes).toHaveLength(1);
			});
		});
		describe('handleContextMenuDismiss', () => {
			it('sets context menu to null', () => {
				const h = setup();
				s4_act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
				s4_act(() => h.result.current.handleContextMenuDismiss());
				expect(h.result.current.contextMenu).toBeNull();
			});
		});
	});
});
