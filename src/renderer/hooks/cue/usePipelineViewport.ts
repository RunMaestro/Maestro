/**
 * usePipelineViewport — Viewport choreography for the pipeline editor.
 *
 * Owns:
 *   - stableYOffsets memo (keyed on pipeline STRUCTURE only — node counts and
 *     ids, NOT positions — so dragging a node does NOT shift all pipelines
 *     below). Critical correctness invariant: both convertToReactFlowNodes
 *     (display) and onNodeDragStop (write-back) must use the same offsets.
 *   - stableYOffsetsRef: render-mirror ref so canvas callbacks can read the
 *     latest offsets without adding them to dep arrays (which would break
 *     ReactFlow memoisation).
 *   - Initial viewport application — either restore saved viewport (fires
 *     immediately, doesn't need node measurement) or fall back to fitView
 *     (must wait for useNodesInitialized()).
 *   - Re-fit on pipeline-selection change, with a 150ms delay to account
 *     for React render → ReactFlow measurement cycle. First change is
 *     suppressed so a saved viewport isn't overwritten on mount.
 *
 * INVARIANT: This hook must be called INSIDE a ReactFlowProvider — it uses
 * useNodesInitialized() which requires the ReactFlow context.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useNodesInitialized, type ReactFlowInstance } from 'reactflow';
import type { CuePipelineState } from '../../../shared/cue-pipeline-types';
import { computePipelineYOffsets } from '../../components/CuePipelineEditor/utils/pipelineGraph';

/** Empirical delay that lets React finish a render → ReactFlow measure nodes
 *  → fitView compute correct bounds. Shorter values race the render cycle on
 *  moderately sized pipelines; longer values feel sluggish. */
const FIT_VIEW_DELAY_MS = 150;

export interface UsePipelineViewportParams {
	pipelineState: CuePipelineState;
	/** Number of computed nodes currently on canvas (used to gate fitView). */
	computedNodeCount: number;
	pendingSavedViewportRef: React.MutableRefObject<{ x: number; y: number; zoom: number } | null>;
	reactFlowInstance: ReactFlowInstance;
}

export interface UsePipelineViewportReturn {
	stableYOffsets: Map<string, number>;
	/** Render-mirror ref updated every render. Callers read `.current` inside
	 *  callbacks that cannot declare stableYOffsets in deps. */
	stableYOffsetsRef: React.MutableRefObject<Map<string, number>>;
}

export function usePipelineViewport({
	pipelineState,
	computedNodeCount,
	pendingSavedViewportRef,
	reactFlowInstance,
}: UsePipelineViewportParams): UsePipelineViewportReturn {
	// Structure key includes node ids + counts but NOT positions — prevents
	// the feedback loop where dragging a node would shift all pipelines below.
	const pipelineStructureKey = useMemo(
		() =>
			pipelineState.pipelines
				.map((p) => `${p.id}:${p.nodes.length}:${p.nodes.map((n) => n.id).join(',')}`)
				.join('|'),
		[pipelineState.pipelines]
	);

	const stableYOffsets = useMemo(
		() => computePipelineYOffsets(pipelineState.pipelines, pipelineState.selectedPipelineId),
		[pipelineStructureKey, pipelineState.selectedPipelineId]
	);

	const stableYOffsetsRef = useRef(stableYOffsets);
	stableYOffsetsRef.current = stableYOffsets;

	// ── Re-fit on pipeline-selection change ────────────────────────────────
	const prevSelectedIdRef = useRef(pipelineState.selectedPipelineId);
	const hasHydratedSelectionRef = useRef(false);
	useEffect(() => {
		if (prevSelectedIdRef.current === pipelineState.selectedPipelineId) return;
		prevSelectedIdRef.current = pipelineState.selectedPipelineId;

		// Skip first change (mount hydration) so saved viewport isn't overwritten.
		if (!hasHydratedSelectionRef.current) {
			hasHydratedSelectionRef.current = true;
			return;
		}

		const timer = setTimeout(() => {
			reactFlowInstance.fitView({ padding: 0.2, duration: 300 });
		}, FIT_VIEW_DELAY_MS);
		return () => clearTimeout(timer);
	}, [pipelineState.selectedPipelineId, reactFlowInstance]);

	// ── Initial viewport (saved OR fitView) ────────────────────────────────
	const nodesInitialized = useNodesInitialized();
	const hasInitialFitRef = useRef(false);
	useEffect(() => {
		if (hasInitialFitRef.current) return;
		const saved = pendingSavedViewportRef.current;
		if (saved) {
			// Restore immediately — setViewport doesn't depend on measurement.
			pendingSavedViewportRef.current = null;
			reactFlowInstance.setViewport(saved);
			hasInitialFitRef.current = true;
			return;
		}
		// fitView path: must wait for nodes to be measured.
		if (!nodesInitialized || computedNodeCount === 0) return;
		reactFlowInstance.fitView({ padding: 0.15, duration: 200 });
		hasInitialFitRef.current = true;
	}, [nodesInitialized, computedNodeCount, reactFlowInstance, pendingSavedViewportRef]);

	return {
		stableYOffsets,
		stableYOffsetsRef,
	};
}
