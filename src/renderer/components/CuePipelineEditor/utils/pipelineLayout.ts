/**
 * Utilities for merging saved pipeline layout state with live pipeline data.
 *
 * Extracted from CuePipelineEditor so the restore logic is independently testable.
 */

import type {
	CuePipeline,
	CuePipelineState,
	PipelineLayoutState,
} from '../../../../shared/cue-pipeline-types';

/**
 * Merge live pipelines with a saved layout, preserving node positions and
 * the previously selected pipeline.
 *
 * When `savedLayout.selectedPipelineId` is explicitly `null` (meaning
 * "All Pipelines" was selected), that `null` is preserved — it is NOT
 * treated as "missing" and defaulted to the first pipeline.
 */
export function mergePipelinesWithSavedLayout(
	livePipelines: CuePipeline[],
	savedLayout: PipelineLayoutState
): CuePipelineState {
	const savedPositions = new Map<string, { x: number; y: number }>();
	const savedPipelineProps = new Map<string, { name: string; color: string }>();
	for (const sp of savedLayout.pipelines) {
		savedPipelineProps.set(sp.id, { name: sp.name, color: sp.color });
		for (const node of sp.nodes) {
			savedPositions.set(`${sp.id}:${node.id}`, node.position);
		}
	}

	const mergedPipelines = livePipelines.map((pipeline) => {
		const savedProps = savedPipelineProps.get(pipeline.id);
		return {
			...pipeline,
			// Restore saved name and color so they don't change on reload
			...(savedProps && { name: savedProps.name, color: savedProps.color }),
			nodes: pipeline.nodes.map((node) => {
				const savedPos = savedPositions.get(`${pipeline.id}:${node.id}`);
				return savedPos ? { ...node, position: savedPos } : node;
			}),
		};
	});

	return {
		pipelines: mergedPipelines,
		selectedPipelineId:
			'selectedPipelineId' in savedLayout
				? savedLayout.selectedPipelineId
				: (mergedPipelines[0]?.id ?? null),
	};
}
