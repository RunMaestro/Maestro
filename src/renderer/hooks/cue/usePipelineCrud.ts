/**
 * usePipelineCrud — Pipeline-level CRUD operations for the pipeline editor.
 *
 * Owns the create/delete/rename/select/recolor callbacks that operate at the
 * whole-pipeline granularity (not node/edge level — see usePipelineMutations).
 * All callbacks stay stable across renders via useCallback; pipeline state is
 * read via the setState callback form so no pipelineState dependency is needed.
 */

import { useCallback } from 'react';
import type { CuePipelineState, CuePipeline } from '../../../shared/cue-pipeline-types';
import { getNextPipelineColor } from '../../components/CuePipelineEditor/pipelineColors';
import { getModalActions } from '../../stores/modalStore';

export interface UsePipelineCrudParams {
	state: { pipelineState: CuePipelineState };
	setters: { setPipelineState: React.Dispatch<React.SetStateAction<CuePipelineState>> };
	actions: { persistLayout: () => void };
	drawers: {
		setTriggerDrawerOpen: (open: boolean) => void;
		setAgentDrawerOpen: (open: boolean) => void;
	};
}

export interface UsePipelineCrudReturn {
	createPipeline: () => void;
	deletePipeline: (id: string) => void;
	renamePipeline: (id: string, name: string) => void;
	selectPipeline: (id: string | null) => void;
	changePipelineColor: (id: string, color: string) => void;
}

export function usePipelineCrud({
	state,
	setters,
	actions,
	drawers,
}: UsePipelineCrudParams): UsePipelineCrudReturn {
	const { pipelineState } = state;
	const { setPipelineState } = setters;
	const { persistLayout } = actions;
	const { setTriggerDrawerOpen, setAgentDrawerOpen } = drawers;

	const createPipeline = useCallback(() => {
		setPipelineState((prev) => {
			// Find the highest existing pipeline number to avoid duplicates after deletions
			let maxNum = 0;
			for (const p of prev.pipelines) {
				const match = p.name.match(/^Pipeline (\d+)$/);
				if (match) {
					maxNum = Math.max(maxNum, parseInt(match[1], 10));
				}
			}
			const name = `Pipeline ${maxNum + 1}`;
			const newPipeline: CuePipeline = {
				// ID must match the form yamlToPipeline generates on reload
				// (`pipeline-${baseName}`). If we used `pipeline-${Date.now()}`
				// here, the first save would persist node positions keyed by
				// the timestamp id; the next open would load the pipeline
				// under the name-derived id, the position lookup would miss,
				// and every node would snap back to the LAYOUT auto-layout.
				// See `yamlToPipeline.ts` (the canonical reload-side id) and
				// `mergePipelinesWithSavedLayout` (the merge that depends on
				// these ids lining up).
				id: `pipeline-${name}`,
				name,
				color: getNextPipelineColor(prev.pipelines),
				nodes: [],
				edges: [],
			};
			return {
				pipelines: [...prev.pipelines, newPipeline],
				selectedPipelineId: newPipeline.id,
			};
		});
	}, [setPipelineState]);

	const deletePipeline = useCallback(
		(id: string) => {
			const pipeline = pipelineState.pipelines.find((p) => p.id === id);
			if (!pipeline) return;

			const doDelete = () => {
				setPipelineState((prev) => {
					const otherPipelines = prev.pipelines.filter((p) => p.id !== id);
					const newSelectedId = prev.selectedPipelineId === id ? null : prev.selectedPipelineId;
					return { pipelines: otherPipelines, selectedPipelineId: newSelectedId };
				});
			};

			if (pipeline.nodes.length > 0) {
				getModalActions().showConfirmation(
					`Delete pipeline "${pipeline.name}" and its nodes?`,
					doDelete
				);
			} else {
				doDelete();
			}
		},
		[pipelineState, setPipelineState]
	);

	const renamePipeline = useCallback(
		(id: string, name: string) => {
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => (p.id === id ? { ...p, name } : p)),
			}));
		},
		[setPipelineState]
	);

	const selectPipeline = useCallback(
		(id: string | null) => {
			setPipelineState((prev) => ({ ...prev, selectedPipelineId: id }));
			if (id === null) {
				setTriggerDrawerOpen(false);
				setAgentDrawerOpen(false);
			}
			persistLayout();
		},
		[persistLayout, setPipelineState, setTriggerDrawerOpen, setAgentDrawerOpen]
	);

	const changePipelineColor = useCallback(
		(id: string, color: string) => {
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => (p.id === id ? { ...p, color } : p)),
			}));
		},
		[setPipelineState]
	);

	return {
		createPipeline,
		deletePipeline,
		renamePipeline,
		selectPipeline,
		changePipelineColor,
	};
}
