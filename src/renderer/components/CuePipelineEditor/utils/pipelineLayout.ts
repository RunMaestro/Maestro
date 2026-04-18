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
		// Name: saved layout wins (users can rename without needing to re-save YAML).
		// Color: YAML is authoritative since `pipeline_color` is persisted there.
		// We only fall back to the layout-JSON color when the live pipeline has
		// no color at all (never happens in practice — palette fallback always
		// yields a value — but defensive against future refactors).
		const mergedName = savedProps?.name ?? pipeline.name;
		const mergedColor = pipeline.color || savedProps?.color || pipeline.color;
		return {
			...pipeline,
			name: mergedName,
			color: mergedColor,
			nodes: pipeline.nodes.map((node) => {
				const savedPos = savedPositions.get(`${pipeline.id}:${node.id}`);
				return savedPos ? { ...node, position: savedPos } : node;
			}),
		};
	});

	// Validate the saved selection against the live pipelines. After a save,
	// `pipelineToYaml`/`subscriptionsToPipelines` regenerates pipeline IDs from
	// the subscription names, so any selectedPipelineId that was created via
	// `createPipeline` (timestamp-based) becomes stale. A stale selection
	// causes `convertToReactFlowNodes` to skip every pipeline, leaving the
	// canvas appearing empty. Fall back to the first pipeline so the user
	// always sees their work.
	let resolvedSelected: string | null;
	if ('selectedPipelineId' in savedLayout) {
		const saved = savedLayout.selectedPipelineId;
		if (saved === null) {
			resolvedSelected = null;
		} else if (mergedPipelines.some((p) => p.id === saved)) {
			resolvedSelected = saved;
		} else {
			resolvedSelected = mergedPipelines[0]?.id ?? null;
		}
	} else {
		resolvedSelected = mergedPipelines[0]?.id ?? null;
	}

	return {
		pipelines: mergedPipelines,
		selectedPipelineId: resolvedSelected,
	};
}
