import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipelineContextMenu } from '../../../../renderer/hooks/cue/usePipelineContextMenu';
import type { CuePipelineState, PipelineNode } from '../../../../shared/cue-pipeline-types';
import type { Node } from 'reactflow';

function triggerNode(id: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 10, y: 20 },
		data: { eventType: 'app.startup', label: 'T', config: {}, customLabel: 'MyTrigger' },
	};
}

function rfNode(id: string, type: 'trigger' | 'agent'): Node {
	return { id, position: { x: 0, y: 0 }, data: {}, type } as unknown as Node;
}

function stubEvent(x = 10, y = 20): React.MouseEvent {
	return {
		preventDefault: vi.fn(),
		clientX: x,
		clientY: y,
	} as unknown as React.MouseEvent;
}

function setup(options: { isAllPipelinesView?: boolean; pipelines?: PipelineNode[] } = {}) {
	let pipelineState: CuePipelineState = {
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
	const setPipelineState = vi.fn((u: React.SetStateAction<CuePipelineState>) => {
		pipelineState =
			typeof u === 'function' ? (u as (p: CuePipelineState) => CuePipelineState)(pipelineState) : u;
	});
	const setSelectedNodeId = vi.fn();
	const setSelectedEdgeId = vi.fn();

	const { result, rerender } = renderHook(
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
			act(() => h.result.current.onNodeContextMenu(ev, rfNode('p1:t1', 'trigger')));
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
			act(() => h.result.current.onNodeContextMenu(ev, rfNode('p1:t1', 'trigger')));
			expect(h.result.current.contextMenu).toBeNull();
			expect(ev.preventDefault).toHaveBeenCalled();
		});

		it('rejects malformed node ids (no colon separator)', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('malformed', 'trigger')));
			expect(h.result.current.contextMenu).toBeNull();
		});
	});

	describe('handleContextMenuConfigure', () => {
		it('selects node + closes menu', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
			act(() => h.result.current.handleContextMenuConfigure());
			expect(h.setSelectedNodeId).toHaveBeenCalledWith('p1:t1');
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
			expect(h.result.current.contextMenu).toBeNull();
		});

		it('view switch between open and action → closes menu without mutation', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
			h.rerender({ isAllPipelinesView: true });
			act(() => h.result.current.handleContextMenuConfigure());
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
			expect(h.result.current.contextMenu).toBeNull();
		});

		it('no-op when menu is already null', () => {
			const h = setup();
			act(() => h.result.current.handleContextMenuConfigure());
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
		});
	});

	describe('handleContextMenuDelete', () => {
		it('removes node + adjacent edges, clears selection + menu', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
			act(() => h.result.current.handleContextMenuDelete());
			expect(h.getState().pipelines[0].nodes.map((n) => n.id)).not.toContain('t1');
			expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
			expect(h.result.current.contextMenu).toBeNull();
		});

		it('view switch → closes menu without state change', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
			h.rerender({ isAllPipelinesView: true });
			act(() => h.result.current.handleContextMenuDelete());
			expect(h.setPipelineState).not.toHaveBeenCalled();
			expect(h.result.current.contextMenu).toBeNull();
		});
	});

	describe('handleContextMenuDuplicate', () => {
		it('duplicates trigger with +50px offset', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
			act(() => h.result.current.handleContextMenuDuplicate());
			const newNodes = h.getState().pipelines[0].nodes;
			expect(newNodes).toHaveLength(2);
			const newNode = newNodes[1];
			expect(newNode.position).toEqual({ x: 60, y: 70 });
			expect(newNode.type).toBe('trigger');
		});

		it('no-op for agent nodes', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'agent')));
			act(() => h.result.current.handleContextMenuDuplicate());
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('view switch → closes menu without duplicate', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
			h.rerender({ isAllPipelinesView: true });
			act(() => h.result.current.handleContextMenuDuplicate());
			// Note: setPipelineState may be called initially by onNodeContextMenu — but it isn't, so
			// only check no state change after duplicate attempt
			expect(h.getState().pipelines[0].nodes).toHaveLength(1);
		});
	});

	describe('handleContextMenuDismiss', () => {
		it('sets context menu to null', () => {
			const h = setup();
			act(() => h.result.current.onNodeContextMenu(stubEvent(), rfNode('p1:t1', 'trigger')));
			act(() => h.result.current.handleContextMenuDismiss());
			expect(h.result.current.contextMenu).toBeNull();
		});
	});
});
