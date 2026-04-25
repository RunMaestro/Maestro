import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePipelineKeyboard } from '../../../../renderer/hooks/cue/usePipelineKeyboard';
import type { Node, Edge } from 'reactflow';

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
}

function setup(opts: SetupOpts = {}) {
	const onDeleteNode = vi.fn();
	const onDeleteEdge = vi.fn();
	const setSelectedNodeId = vi.fn();
	const setSelectedEdgeId = vi.fn();
	const setTriggerDrawerOpen = vi.fn();
	const setAgentDrawerOpen = vi.fn();
	const handleSave = vi.fn();

	renderHook(() =>
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
			handleSave,
		})
	);

	return {
		onDeleteNode,
		onDeleteEdge,
		setSelectedNodeId,
		setSelectedEdgeId,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
		handleSave,
	};
}

function dispatch(
	key: string,
	opts: { metaKey?: boolean; ctrlKey?: boolean; target?: HTMLElement } = {}
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
			const { unmount } = renderHook(() =>
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
					handleSave: vi.fn(),
				})
			);
			unmount();
			dispatch('Delete');
			expect(onDeleteNode).not.toHaveBeenCalled();
		});
	});
});
