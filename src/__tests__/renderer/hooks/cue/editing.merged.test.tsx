// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/cue/usePipelineKeyboard.test.ts
// Source: src/__tests__/renderer/hooks/cue/usePipelineMutations.test.ts
// Source: src/__tests__/renderer/hooks/cue/usePipelineSelection.multiTrigger.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook as s1_renderHook } from '@testing-library/react';
import { usePipelineKeyboard } from '../../../../renderer/hooks/cue/usePipelineKeyboard';
import type { Node, Edge } from 'reactflow';
import { renderHook as s2_renderHook, act as s2_act } from '@testing-library/react';
import { usePipelineMutations } from '../../../../renderer/hooks/cue/usePipelineMutations';
import type {
	CuePipeline,
	CuePipelineState as S2_CuePipelineState,
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
} from '../../../../shared/cue-pipeline-types';
import { renderHook as s3_renderHook, act as s3_act } from '@testing-library/react';
import { usePipelineSelection } from '../../../../renderer/hooks/cue/usePipelineSelection';
import type { CuePipelineState as S3_CuePipelineState } from '../../../../shared/cue-pipeline-types';
// Source: src/__tests__/renderer/hooks/cue/usePipelineKeyboard.test.ts
describe('', () => {
	function rfNode(id: string): Node {
		return { id, position: { x: 0, y: 0 }, data: {} } as unknown as Node;
	}
	function rfEdge(id: string): Edge {
		return { id, source: 'a', target: 'b' } as Edge;
	}
	interface SetupOpts {
		isAllPipelinesView?: boolean;
		selectedNode?: Node | null;
		selectedNodePipelineId?: string | null;
		selectedEdge?: Edge | null;
		selectedEdgePipelineId?: string | null;
		selectedNodeId?: string | null;
		selectedEdgeId?: string | null;
		triggerDrawerOpen?: boolean;
		agentDrawerOpen?: boolean;
		/** Mock editor root. Defaults to a fresh div appended to document.body. */
		container?: HTMLElement;
	}
	function setup(opts: SetupOpts = {}) {
		const onDeleteNode = vi.fn();
		const onDeleteEdge = vi.fn();
		const setSelectedNodeId = vi.fn();
		const setSelectedEdgeId = vi.fn();
		const setTriggerDrawerOpen = vi.fn();
		const setAgentDrawerOpen = vi.fn();
		const setInteractionMode = vi.fn();
		const handleSave = vi.fn();
		const zoomIn = vi.fn();
		const zoomOut = vi.fn();
		const fitView = vi.fn();
		const setIsLocked = vi.fn();
		const container =
			opts.container ??
			(() => {
				const el = document.createElement('div');
				document.body.appendChild(el);
				return el;
			})();
		const containerRef = { current: container };
		s1_renderHook(() =>
			usePipelineKeyboard({
				isAllPipelinesView: opts.isAllPipelinesView ?? false,
				selectedNode: opts.selectedNode ?? null,
				selectedNodePipelineId: opts.selectedNodePipelineId ?? null,
				selectedEdge: opts.selectedEdge ?? null,
				selectedEdgePipelineId: opts.selectedEdgePipelineId ?? null,
				selectedNodeId: opts.selectedNodeId ?? null,
				selectedEdgeId: opts.selectedEdgeId ?? null,
				triggerDrawerOpen: opts.triggerDrawerOpen ?? false,
				agentDrawerOpen: opts.agentDrawerOpen ?? false,
				onDeleteNode,
				onDeleteEdge,
				setSelectedNodeId,
				setSelectedEdgeId,
				setTriggerDrawerOpen,
				setAgentDrawerOpen,
				setInteractionMode,
				handleSave,
				zoomIn,
				zoomOut,
				fitView,
				setIsLocked,
				containerRef,
			})
		);
		return {
			onDeleteNode,
			onDeleteEdge,
			setSelectedNodeId,
			setSelectedEdgeId,
			setTriggerDrawerOpen,
			setAgentDrawerOpen,
			setInteractionMode,
			handleSave,
			zoomIn,
			zoomOut,
			fitView,
			setIsLocked,
			container,
		};
	}
	function dispatch(
		key: string,
		opts: {
			metaKey?: boolean;
			ctrlKey?: boolean;
			target?: HTMLElement;
		} = {}
	) {
		const event = new KeyboardEvent('keydown', {
			key,
			metaKey: opts.metaKey ?? false,
			ctrlKey: opts.ctrlKey ?? false,
			bubbles: true,
			cancelable: true,
		});
		if (opts.target) {
			Object.defineProperty(event, 'target', { value: opts.target, enumerable: true });
		}
		window.dispatchEvent(event);
		return event;
	}
	describe('usePipelineKeyboard', () => {
		afterEach(() => {
			document.body.innerHTML = '';
		});
		describe('Delete / Backspace', () => {
			it('deletes selected node when present', () => {
				const h = setup({
					selectedNode: rfNode('p1:t1'),
					selectedNodePipelineId: 'p1',
				});
				dispatch('Delete');
				expect(h.onDeleteNode).toHaveBeenCalledWith('p1:t1');
			});
			it('Backspace also triggers node deletion', () => {
				const h = setup({
					selectedNode: rfNode('p1:t1'),
					selectedNodePipelineId: 'p1',
				});
				dispatch('Backspace');
				expect(h.onDeleteNode).toHaveBeenCalled();
			});
			it('deletes selected edge when node is not selected', () => {
				const h = setup({
					selectedEdge: rfEdge('e1'),
					selectedEdgePipelineId: 'p1',
				});
				dispatch('Delete');
				expect(h.onDeleteEdge).toHaveBeenCalledWith('e1');
			});
			it('no-op when target is text input', () => {
				const input = document.createElement('input');
				document.body.appendChild(input);
				const h = setup({
					selectedNode: rfNode('p1:t1'),
					selectedNodePipelineId: 'p1',
				});
				dispatch('Delete', { target: input });
				expect(h.onDeleteNode).not.toHaveBeenCalled();
			});
			it('no-op in All Pipelines view', () => {
				const h = setup({
					selectedNode: rfNode('p1:t1'),
					selectedNodePipelineId: 'p1',
					isAllPipelinesView: true,
				});
				dispatch('Delete');
				expect(h.onDeleteNode).not.toHaveBeenCalled();
			});
		});
		describe('Escape', () => {
			it('closes trigger drawer first', () => {
				const h = setup({ triggerDrawerOpen: true, selectedNodeId: 'p1:t1' });
				dispatch('Escape');
				expect(h.setTriggerDrawerOpen).toHaveBeenCalledWith(false);
				expect(h.setSelectedNodeId).not.toHaveBeenCalled();
			});
			it('closes agent drawer when trigger drawer closed', () => {
				const h = setup({ agentDrawerOpen: true, selectedNodeId: 'p1:t1' });
				dispatch('Escape');
				expect(h.setAgentDrawerOpen).toHaveBeenCalledWith(false);
				expect(h.setSelectedNodeId).not.toHaveBeenCalled();
			});
			it('clears selection when no drawers open', () => {
				const h = setup({ selectedNodeId: 'p1:t1', selectedEdgeId: null });
				dispatch('Escape');
				expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
				expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
			});
			it('no-op when nothing to close', () => {
				const h = setup();
				dispatch('Escape');
				expect(h.setSelectedNodeId).not.toHaveBeenCalled();
			});
		});
		describe('Cmd/Ctrl+S', () => {
			it('Cmd+S triggers handleSave', () => {
				const h = setup();
				const ev = dispatch('s', { metaKey: true });
				expect(h.handleSave).toHaveBeenCalled();
				expect(ev.defaultPrevented).toBe(true);
			});
			it('Ctrl+S triggers handleSave', () => {
				const h = setup();
				dispatch('s', { ctrlKey: true });
				expect(h.handleSave).toHaveBeenCalled();
			});
			it('plain "s" does NOT trigger save', () => {
				const h = setup();
				dispatch('s');
				expect(h.handleSave).not.toHaveBeenCalled();
			});
		});
		describe('cleanup', () => {
			it('removes listener on unmount', () => {
				const onDeleteNode = vi.fn();
				const container = document.createElement('div');
				document.body.appendChild(container);
				const { unmount } = s1_renderHook(() =>
					usePipelineKeyboard({
						isAllPipelinesView: false,
						selectedNode: rfNode('p1:t1'),
						selectedNodePipelineId: 'p1',
						selectedEdge: null,
						selectedEdgePipelineId: null,
						selectedNodeId: 'p1:t1',
						selectedEdgeId: null,
						triggerDrawerOpen: false,
						agentDrawerOpen: false,
						onDeleteNode,
						onDeleteEdge: vi.fn(),
						setSelectedNodeId: vi.fn(),
						setSelectedEdgeId: vi.fn(),
						setTriggerDrawerOpen: vi.fn(),
						setAgentDrawerOpen: vi.fn(),
						setInteractionMode: vi.fn(),
						handleSave: vi.fn(),
						zoomIn: vi.fn(),
						zoomOut: vi.fn(),
						fitView: vi.fn(),
						setIsLocked: vi.fn(),
						containerRef: { current: container },
					})
				);
				unmount();
				dispatch('Delete');
				expect(onDeleteNode).not.toHaveBeenCalled();
			});
		});
		describe('Interaction mode (P / S)', () => {
			// setInteractionMode is now a functional updater (Dispatch<SetStateAction>)
			// to support toggle semantics: pressing P from 'hand' flips to 'pointer'.
			// Helper: invoke the latest captured updater with a given prev state.
			function applyUpdater(
				mock: ReturnType<typeof vi.fn>,
				prev: 'hand' | 'pointer'
			): 'hand' | 'pointer' {
				const updater = mock.mock.calls.at(-1)?.[0] as (
					p: 'hand' | 'pointer'
				) => 'hand' | 'pointer';
				return updater(prev);
			}
			it('plain "p" switches to hand mode (from pointer)', () => {
				const h = setup();
				dispatch('p');
				expect(h.setInteractionMode).toHaveBeenCalled();
				expect(applyUpdater(h.setInteractionMode, 'pointer')).toBe('hand');
			});
			it('plain "P" (uppercase) switches to hand mode', () => {
				const h = setup();
				dispatch('P');
				expect(applyUpdater(h.setInteractionMode, 'pointer')).toBe('hand');
			});
			it('plain "s" switches to pointer mode (from hand)', () => {
				const h = setup();
				dispatch('s');
				expect(applyUpdater(h.setInteractionMode, 'hand')).toBe('pointer');
			});
			it('plain "S" (uppercase) switches to pointer mode', () => {
				const h = setup();
				dispatch('S');
				expect(applyUpdater(h.setInteractionMode, 'hand')).toBe('pointer');
			});
			it('pressing same mode key twice toggles back', () => {
				// Pressing 'p' while already in 'hand' should flip to 'pointer'.
				const h = setup();
				dispatch('p');
				expect(applyUpdater(h.setInteractionMode, 'hand')).toBe('pointer');
			});
			it('does not change mode when typing in an input INSIDE the editor', () => {
				const h = setup();
				const input = document.createElement('input');
				h.container.appendChild(input);
				dispatch('p', { target: input });
				dispatch('s', { target: input });
				expect(h.setInteractionMode).not.toHaveBeenCalled();
			});
			it('still switches mode when an input OUTSIDE the editor has focus', () => {
				// Regression: when the Cue modal is open above an AI textarea that
				// retained focus, P/S must claim the keystroke (not let the hidden
				// background input swallow it).
				const h = setup();
				const externalInput = document.createElement('textarea');
				document.body.appendChild(externalInput);
				const ev = dispatch('p', { target: externalInput });
				expect(applyUpdater(h.setInteractionMode, 'pointer')).toBe('hand');
				expect(ev.defaultPrevented).toBe(true);
			});
			it('does not change mode when Cmd is held (Cmd+S still saves)', () => {
				const h = setup();
				dispatch('s', { metaKey: true });
				expect(h.setInteractionMode).not.toHaveBeenCalled();
				expect(h.handleSave).toHaveBeenCalled();
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/cue/usePipelineMutations.test.ts
describe('', () => {
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
		let state: S2_CuePipelineState = {
			pipelines: options.pipelines,
			selectedPipelineId: options.pipelines[0]?.id ?? null,
		};
		const setPipelineState = vi.fn((updater: React.SetStateAction<S2_CuePipelineState>) => {
			state =
				typeof updater === 'function'
					? (updater as (p: S2_CuePipelineState) => S2_CuePipelineState)(state)
					: updater;
		});
		const setSelectedNodeId = vi.fn();
		const setSelectedEdgeId = vi.fn();
		const { result, rerender } = s2_renderHook(
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
				s2_act(() =>
					h.result.current.onUpdateNode('n1', { sessionName: 'X' } as Partial<AgentNodeData>)
				);
				expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe(
					'Agent'
				);
			});
			it('mutates only the node in selected pipeline', () => {
				const h = setup({
					pipelines: [
						pipeline('p1', 'A', [agentNode('n1', 'Alpha')]),
						pipeline('p2', 'B', [agentNode('n1', 'Bravo')]),
					],
					selectedNodePipelineId: 'p1',
				});
				s2_act(() =>
					h.result.current.onUpdateNode('n1', {
						sessionName: 'Updated',
					} as Partial<AgentNodeData>)
				);
				expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe(
					'Updated'
				);
				expect((h.getState().pipelines[1].nodes[0].data as AgentNodeData).sessionName).toBe(
					'Bravo'
				);
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
				s2_act(() =>
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
				s2_act(() => h.result.current.onUpdateEdgePrompt('e1', 'new'));
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
				s2_act(() => h.result.current.onUpdateEdgePrompt('e1', 'new1'));
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
				s2_act(() => h.result.current.onDeleteNode('t1'));
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
				s2_act(() => h.result.current.onDeleteNode('a1'));
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
				s2_act(() => h.result.current.onUpdateEdge('e1', { mode: 'debate' }));
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
				s2_act(() => h.result.current.onUpdateEdge('e1', { mode: 'debate' }));
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
				s2_act(() => h.result.current.onDeleteEdge('e1'));
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
				s2_act(() => h.result.current.onDeleteEdge('e1'));
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
				s2_act(() =>
					h.result.current.onUpdateNode('n1', { sessionName: 'X' } as Partial<AgentNodeData>)
				);
				expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe('X');
				// Rerender with different selection
				h.rerender({ selectedNode: 'p2', selectedEdge: null } as unknown as never);
				s2_act(() =>
					h.result.current.onUpdateNode('n1', { sessionName: 'Y' } as Partial<AgentNodeData>)
				);
				expect((h.getState().pipelines[1].nodes[0].data as AgentNodeData).sessionName).toBe('Y');
				expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe('X');
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/cue/usePipelineSelection.multiTrigger.test.ts
describe('', () => {
	function makeTriggerNode(id: string, eventType: string, label = 'Trigger') {
		return {
			id,
			type: 'trigger' as const,
			position: { x: 0, y: 0 },
			data: { eventType, label, config: {} },
		};
	}
	function makeAgentNode(id: string, extras: Record<string, unknown> = {}) {
		return {
			id,
			type: 'agent' as const,
			position: { x: 100, y: 0 },
			data: {
				sessionId: `sess-${id}`,
				sessionName: `Agent ${id}`,
				toolType: 'claude-code',
				...extras,
			},
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
	function makePipeline(id: string, nodes: any[], edges: any[]) {
		return { id, name: `Pipeline ${id}`, color: '#06b6d4', nodes, edges };
	}
	function mouseEvent() {
		return { stopPropagation: () => {} } as unknown as React.MouseEvent;
	}
	describe('usePipelineSelection - multi-trigger prompt isolation', () => {
		it('returns distinct prompts for two triggers when both have edge.prompt set', () => {
			const triggerA = makeTriggerNode('tA', 'github.issue');
			const triggerB = makeTriggerNode('tB', 'github.pull_request');
			const agent = makeAgentNode('a1');
			const edgeA = makeEdge('eA', 'tA', 'a1', { prompt: 'handle issue' });
			const edgeB = makeEdge('eB', 'tB', 'a1', { prompt: 'handle PR' });
			const pipeline = makePipeline('p1', [triggerA, triggerB, agent], [edgeA, edgeB]);
			const state: S3_CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };
			const { result } = s3_renderHook(() => usePipelineSelection({ pipelineState: state }));
			s3_act(() => {
				result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
			});
			const triggers = result.current.incomingTriggerEdges;
			expect(triggers).toHaveLength(2);
			const promptByEdge = Object.fromEntries(triggers.map((t) => [t.edgeId, t.prompt]));
			expect(promptByEdge.eA).toBe('handle issue');
			expect(promptByEdge.eB).toBe('handle PR');
		});
		it("second trigger without edge.prompt falls back to its own event-type default, not the first trigger's prompt or agent inputPrompt", () => {
			const triggerA = makeTriggerNode('tA', 'github.issue');
			const triggerB = makeTriggerNode('tB', 'file.changed');
			// Simulate the legacy auto-populate that used to set inputPrompt from the first trigger.
			const agent = makeAgentNode('a1', { inputPrompt: 'ISSUE PROMPT TEMPLATE' });
			const edgeA = makeEdge('eA', 'tA', 'a1', { prompt: 'user-edited issue prompt' });
			const edgeB = makeEdge('eB', 'tB', 'a1'); // no prompt - this is the leakage vector
			const pipeline = makePipeline('p1', [triggerA, triggerB, agent], [edgeA, edgeB]);
			const state: S3_CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };
			const { result } = s3_renderHook(() => usePipelineSelection({ pipelineState: state }));
			s3_act(() => {
				result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
			});
			const promptByEdge = Object.fromEntries(
				result.current.incomingTriggerEdges.map((t) => [t.edgeId, t.prompt])
			);
			expect(promptByEdge.eA).toBe('user-edited issue prompt');
			// eB must NOT receive the agent inputPrompt (the bug) and must NOT
			// receive eA's prompt (another shape of leak). It must receive the
			// file.changed template.
			expect(promptByEdge.eB).toContain('{{CUE_FILE_PATH}}');
			expect(promptByEdge.eB).not.toBe('ISSUE PROMPT TEMPLATE');
			expect(promptByEdge.eB).not.toBe('user-edited issue prompt');
		});
		it('two triggers, neither with edge.prompt, each gets its own event-type default', () => {
			const triggerA = makeTriggerNode('tA', 'task.pending');
			const triggerB = makeTriggerNode('tB', 'cli.trigger');
			const agent = makeAgentNode('a1');
			const edgeA = makeEdge('eA', 'tA', 'a1');
			const edgeB = makeEdge('eB', 'tB', 'a1');
			const pipeline = makePipeline('p1', [triggerA, triggerB, agent], [edgeA, edgeB]);
			const state: S3_CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };
			const { result } = s3_renderHook(() => usePipelineSelection({ pipelineState: state }));
			s3_act(() => {
				result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
			});
			const promptByEdge = Object.fromEntries(
				result.current.incomingTriggerEdges.map((t) => [t.edgeId, t.prompt])
			);
			expect(promptByEdge.eA).toContain('{{CUE_TASK_LIST}}');
			expect(promptByEdge.eB).toContain('{{CUE_CLI_PROMPT}}');
		});
		it('agent inputPrompt is never used as the fallback, even when the edge is present and unset', () => {
			const trigger = makeTriggerNode('t1', 'time.heartbeat');
			const agent = makeAgentNode('a1', { inputPrompt: 'do not leak this' });
			const edge = makeEdge('e1', 't1', 'a1');
			const pipeline = makePipeline('p1', [trigger, agent], [edge]);
			const state: S3_CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };
			const { result } = s3_renderHook(() => usePipelineSelection({ pipelineState: state }));
			s3_act(() => {
				result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
			});
			expect(result.current.incomingTriggerEdges[0].prompt).toBe(''); // time.heartbeat default
			expect(result.current.incomingTriggerEdges[0].prompt).not.toContain('do not leak this');
		});
	});
});
