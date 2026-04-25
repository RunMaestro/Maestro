import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import { usePipelineViewport } from '../../../../renderer/hooks/cue/usePipelineViewport';
import type { CuePipelineState } from '../../../../shared/cue-pipeline-types';

// Mock computePipelineYOffsets to expose deterministic offsets
const mockComputeYOffsets =
	vi.fn<(pipelines: unknown, selectedId: unknown) => Map<string, number>>();
vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	computePipelineYOffsets: (...args: unknown[]) =>
		mockComputeYOffsets(args[0], args[1] as string | null),
}));

// useNodesInitialized must be controllable per test
let nodesInitialized = true;
vi.mock('reactflow', async () => {
	const actual = await vi.importActual<typeof import('reactflow')>('reactflow');
	return {
		...actual,
		useNodesInitialized: () => nodesInitialized,
	};
});

const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
	React.createElement(ReactFlowProvider, null, children);

function makePipelineState(
	pipelines: Array<{ id: string; nodeCount: number }>,
	selectedPipelineId: string | null = null
): CuePipelineState {
	return {
		pipelines: pipelines.map((p) => ({
			id: p.id,
			name: p.id,
			color: '#abc',
			nodes: Array.from({ length: p.nodeCount }, (_, i) => ({
				id: `${p.id}-n${i}`,
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			})),
			edges: [],
		})),
		selectedPipelineId,
	};
}

function makeRfInstance() {
	return {
		setViewport: vi.fn(),
		fitView: vi.fn(),
	};
}

describe('usePipelineViewport', () => {
	beforeEach(() => {
		mockComputeYOffsets.mockReset();
		mockComputeYOffsets.mockReturnValue(new Map([['p1', 100]]));
		nodesInitialized = true;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('stableYOffsets', () => {
		it('computes offsets on first render', () => {
			const rf = makeRfInstance();
			const pending = { current: null };
			const { result } = renderHook(
				() =>
					usePipelineViewport({
						pipelineState: makePipelineState([{ id: 'p1', nodeCount: 2 }]),
						computedNodeCount: 2,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper }
			);
			expect(result.current.stableYOffsets.get('p1')).toBe(100);
			expect(result.current.stableYOffsetsRef.current).toBe(result.current.stableYOffsets);
		});

		it('does NOT recompute when node positions change (key excludes positions)', () => {
			const rf = makeRfInstance();
			const pending = { current: null };
			const state1 = makePipelineState([{ id: 'p1', nodeCount: 2 }]);
			const { rerender } = renderHook(
				({ state }) =>
					usePipelineViewport({
						pipelineState: state,
						computedNodeCount: 2,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper, initialProps: { state: state1 } }
			);
			const callCountAfterMount = mockComputeYOffsets.mock.calls.length;
			// Same structure, different positions
			const state2 = makePipelineState([{ id: 'p1', nodeCount: 2 }]);
			state2.pipelines[0].nodes[0].position = { x: 500, y: 500 };
			rerender({ state: state2 });
			expect(mockComputeYOffsets.mock.calls.length).toBe(callCountAfterMount);
		});

		it('recomputes when node count changes', () => {
			const rf = makeRfInstance();
			const pending = { current: null };
			const state1 = makePipelineState([{ id: 'p1', nodeCount: 2 }]);
			const { rerender } = renderHook(
				({ state }) =>
					usePipelineViewport({
						pipelineState: state,
						computedNodeCount: state.pipelines[0]?.nodes.length ?? 0,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper, initialProps: { state: state1 } }
			);
			const before = mockComputeYOffsets.mock.calls.length;
			const state2 = makePipelineState([{ id: 'p1', nodeCount: 3 }]);
			rerender({ state: state2 });
			expect(mockComputeYOffsets.mock.calls.length).toBeGreaterThan(before);
		});
	});

	describe('initial viewport', () => {
		it('applies saved viewport immediately and clears ref', () => {
			const rf = makeRfInstance();
			const pending = { current: { x: 10, y: 20, zoom: 1.5 } };
			renderHook(
				() =>
					usePipelineViewport({
						pipelineState: makePipelineState([{ id: 'p1', nodeCount: 1 }]),
						computedNodeCount: 1,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper }
			);
			expect(rf.setViewport).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 1.5 });
			expect(pending.current).toBeNull();
			expect(rf.fitView).not.toHaveBeenCalled();
		});

		it('calls fitView when no saved viewport and nodes are initialized', () => {
			const rf = makeRfInstance();
			const pending = { current: null };
			renderHook(
				() =>
					usePipelineViewport({
						pipelineState: makePipelineState([{ id: 'p1', nodeCount: 1 }]),
						computedNodeCount: 1,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper }
			);
			expect(rf.fitView).toHaveBeenCalled();
		});

		it('does NOT fitView when computedNodeCount is 0', () => {
			const rf = makeRfInstance();
			const pending = { current: null };
			renderHook(
				() =>
					usePipelineViewport({
						pipelineState: makePipelineState([]),
						computedNodeCount: 0,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper }
			);
			expect(rf.fitView).not.toHaveBeenCalled();
		});

		it('does NOT fitView when nodes are not yet initialized', () => {
			nodesInitialized = false;
			const rf = makeRfInstance();
			const pending = { current: null };
			renderHook(
				() =>
					usePipelineViewport({
						pipelineState: makePipelineState([{ id: 'p1', nodeCount: 1 }]),
						computedNodeCount: 1,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper }
			);
			expect(rf.fitView).not.toHaveBeenCalled();
		});
	});

	describe('pipeline-selection-change re-fit', () => {
		it('suppresses first selection change (mount hydration)', () => {
			vi.useFakeTimers();
			const rf = makeRfInstance();
			const pending = { current: null };
			const state1 = makePipelineState([{ id: 'p1', nodeCount: 1 }], null);
			const { rerender } = renderHook(
				({ state }) =>
					usePipelineViewport({
						pipelineState: state,
						computedNodeCount: 1,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper, initialProps: { state: state1 } }
			);
			rf.fitView.mockClear();
			// First change (selectedPipelineId: null → 'p1') should be suppressed
			const state2 = makePipelineState([{ id: 'p1', nodeCount: 1 }], 'p1');
			rerender({ state: state2 });
			act(() => vi.advanceTimersByTime(200));
			expect(rf.fitView).not.toHaveBeenCalled();
		});

		it('fires fitView 150ms after second+ selection change', () => {
			vi.useFakeTimers();
			const rf = makeRfInstance();
			const pending = { current: null };
			const state1 = makePipelineState([{ id: 'p1', nodeCount: 1 }], null);
			const { rerender } = renderHook(
				({ state }) =>
					usePipelineViewport({
						pipelineState: state,
						computedNodeCount: 1,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper, initialProps: { state: state1 } }
			);
			rf.fitView.mockClear();
			// First change → suppressed
			rerender({ state: makePipelineState([{ id: 'p1', nodeCount: 1 }], 'p1') });
			act(() => vi.advanceTimersByTime(200));
			rf.fitView.mockClear();
			// Second change → scheduled for 150ms
			rerender({ state: makePipelineState([{ id: 'p1', nodeCount: 1 }], null) });
			expect(rf.fitView).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(149));
			expect(rf.fitView).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(5));
			expect(rf.fitView).toHaveBeenCalled();
		});

		it('unmount clears pending fit timer', () => {
			vi.useFakeTimers();
			const rf = makeRfInstance();
			const pending = { current: null };
			const state1 = makePipelineState([{ id: 'p1', nodeCount: 1 }], null);
			const { rerender, unmount } = renderHook(
				({ state }) =>
					usePipelineViewport({
						pipelineState: state,
						computedNodeCount: 1,
						pendingSavedViewportRef: pending,
						reactFlowInstance: rf as unknown as Parameters<
							typeof usePipelineViewport
						>[0]['reactFlowInstance'],
					}),
				{ wrapper, initialProps: { state: state1 } }
			);
			// Trigger first change (suppressed)
			rerender({ state: makePipelineState([{ id: 'p1', nodeCount: 1 }], 'p1') });
			act(() => vi.advanceTimersByTime(200));
			rf.fitView.mockClear();
			// Queue a second change
			rerender({ state: makePipelineState([{ id: 'p1', nodeCount: 1 }], null) });
			unmount();
			act(() => vi.advanceTimersByTime(500));
			expect(rf.fitView).not.toHaveBeenCalled();
		});
	});
});
