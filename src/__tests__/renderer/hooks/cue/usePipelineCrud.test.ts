import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipelineCrud } from '../../../../renderer/hooks/cue/usePipelineCrud';
import type { CuePipelineState, CuePipeline } from '../../../../shared/cue-pipeline-types';

const mockShowConfirmation = vi.fn();

vi.mock('../../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({ showConfirmation: mockShowConfirmation }),
}));

function makePipeline(id: string, name: string, color = '#06b6d4', nodeCount = 0): CuePipeline {
	return {
		id,
		name,
		color,
		nodes: Array.from({ length: nodeCount }, (_, i) => ({
			id: `${id}-n${i}`,
			type: 'trigger',
			position: { x: 0, y: 0 },
			data: { eventType: 'app.startup', label: 'T', config: {} },
		})),
		edges: [],
	};
}

type Hooks = ReturnType<typeof setup>;

function setup(initialState?: Partial<CuePipelineState>) {
	let pipelineState: CuePipelineState = {
		pipelines: initialState?.pipelines ?? [],
		selectedPipelineId: initialState?.selectedPipelineId ?? null,
	};
	const setPipelineState = vi.fn((updater: React.SetStateAction<CuePipelineState>) => {
		pipelineState =
			typeof updater === 'function'
				? (updater as (prev: CuePipelineState) => CuePipelineState)(pipelineState)
				: updater;
	});
	const persistLayout = vi.fn();
	const setTriggerDrawerOpen = vi.fn();
	const setAgentDrawerOpen = vi.fn();

	const { result, rerender } = renderHook(
		({ state }) =>
			usePipelineCrud({
				state: { pipelineState: state },
				setters: { setPipelineState },
				actions: { persistLayout },
				drawers: { setTriggerDrawerOpen, setAgentDrawerOpen },
			}),
		{ initialProps: { state: pipelineState } }
	);

	return {
		result,
		rerender: () => rerender({ state: pipelineState }),
		getState: () => pipelineState,
		setPipelineState,
		persistLayout,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
	};
}

describe('usePipelineCrud', () => {
	beforeEach(() => {
		mockShowConfirmation.mockReset();
	});

	describe('createPipeline', () => {
		it('creates first pipeline with name "Pipeline 1" and first color', () => {
			const h: Hooks = setup();
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines).toHaveLength(1);
			expect(state.pipelines[0].name).toBe('Pipeline 1');
			expect(state.selectedPipelineId).toBe(state.pipelines[0].id);
		});

		it('assigns next unused color when existing pipelines use earlier colors', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Pipeline 1', '#06b6d4')],
			});
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines).toHaveLength(2);
			expect(state.pipelines[1].color).not.toBe('#06b6d4');
		});

		it('auto-generates Pipeline N with N = max existing number + 1 (handles deletions)', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p3', 'Pipeline 3'), makePipeline('p1', 'Pipeline 1')],
			});
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines[2].name).toBe('Pipeline 4');
		});

		it('assigns id of the form `pipeline-${name}` (matches yamlToPipeline reload id)', () => {
			// Regression guard for the "snap-back to grid on first save+reopen"
			// bug: if createPipeline used a timestamp id (e.g. pipeline-1741234567890),
			// the first persistLayout would write positions under that timestamp
			// id; the next reopen would regenerate the id as `pipeline-${name}`
			// and the position lookup would miss, snapping all nodes to the
			// auto-layout default. yamlToPipeline uses `pipeline-${baseName}` on
			// reload (see `subscriptionsToPipelines` in yamlToPipeline.ts), so
			// createPipeline must match that form from day one.
			const h: Hooks = setup();
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines[0].id).toBe('pipeline-Pipeline 1');
		});

		it('id tracks the auto-incremented name across successive creates', () => {
			const h: Hooks = setup();
			act(() => h.result.current.createPipeline());
			act(() => h.result.current.createPipeline());
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines.map((p) => p.id)).toEqual([
				'pipeline-Pipeline 1',
				'pipeline-Pipeline 2',
				'pipeline-Pipeline 3',
			]);
		});
	});

	describe('deletePipeline', () => {
		it('deletes empty pipeline without confirmation', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Alpha', '#06b6d4', 0)],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.deletePipeline('p1'));
			expect(mockShowConfirmation).not.toHaveBeenCalled();
			expect(h.getState().pipelines).toHaveLength(0);
			expect(h.getState().selectedPipelineId).toBeNull();
		});

		it('shows confirmation for pipeline with nodes', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Alpha', '#06b6d4', 3)],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.deletePipeline('p1'));
			expect(mockShowConfirmation).toHaveBeenCalledWith(
				expect.stringContaining('"Alpha"'),
				expect.any(Function)
			);
			// State not yet changed
			expect(h.getState().pipelines).toHaveLength(1);
			// Invoke the confirmation callback
			const callback = mockShowConfirmation.mock.calls[0][1] as () => void;
			act(() => callback());
			expect(h.getState().pipelines).toHaveLength(0);
			expect(h.getState().selectedPipelineId).toBeNull();
		});

		it('preserves selectedPipelineId when deleting a non-selected pipeline', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'A'), makePipeline('p2', 'B')],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.deletePipeline('p2'));
			expect(h.getState().selectedPipelineId).toBe('p1');
		});

		it('is a no-op for unknown id', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Alpha')],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.deletePipeline('non-existent'));
			expect(mockShowConfirmation).not.toHaveBeenCalled();
			expect(h.getState().pipelines).toHaveLength(1);
		});
	});

	describe('renamePipeline', () => {
		it('updates name but leaves nodes/edges/color intact', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Old', '#abc', 2)],
			});
			act(() => h.result.current.renamePipeline('p1', 'New'));
			const p = h.getState().pipelines[0];
			expect(p.name).toBe('New');
			expect(p.color).toBe('#abc');
			expect(p.nodes).toHaveLength(2);
		});
	});

	describe('selectPipeline', () => {
		it('sets selectedPipelineId to given id and calls persistLayout', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'A')],
				selectedPipelineId: null,
			});
			act(() => h.result.current.selectPipeline('p1'));
			expect(h.getState().selectedPipelineId).toBe('p1');
			expect(h.persistLayout).toHaveBeenCalledTimes(1);
			// Drawers untouched when selecting non-null
			expect(h.setTriggerDrawerOpen).not.toHaveBeenCalled();
			expect(h.setAgentDrawerOpen).not.toHaveBeenCalled();
		});

		it('selectPipeline(null) closes both drawers and calls persistLayout', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'A')],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.selectPipeline(null));
			expect(h.getState().selectedPipelineId).toBeNull();
			expect(h.setTriggerDrawerOpen).toHaveBeenCalledWith(false);
			expect(h.setAgentDrawerOpen).toHaveBeenCalledWith(false);
			expect(h.persistLayout).toHaveBeenCalledTimes(1);
		});
	});

	describe('changePipelineColor', () => {
		it('updates color, leaves other fields intact', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'A', '#abc', 2)],
			});
			act(() => h.result.current.changePipelineColor('p1', '#xyz'));
			const p = h.getState().pipelines[0];
			expect(p.color).toBe('#xyz');
			expect(p.name).toBe('A');
			expect(p.nodes).toHaveLength(2);
		});
	});
});
