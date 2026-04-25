/**
 * Utilities for merging saved pipeline layout state with live pipeline data.
 *
 * Extracted from CuePipelineEditor so the restore logic is independently testable.
 */

import type {
	AgentNodeData,
	CommandNodeData,
	CuePipeline,
	CuePipelineState,
	ErrorNodeData,
	PipelineLayoutState,
	PipelineNode,
	TriggerNodeData,
} from '../../../../shared/cue-pipeline-types';

/**
 * A semantic key for a node that stays stable across save → reload. UI-created
 * nodes use timestamp-based ids (`trigger-1741234567890`, `agent-s1-1741234567900`)
 * while `yamlToPipeline` regenerates ids from a deterministic scheme on reload
 * (`trigger-0`, `agent-${sessionName}-${size}`). If we looked up positions by
 * node.id alone, first-save positions — keyed by the UI timestamp id —
 * would miss every lookup on the next open and every node would snap back to
 * the auto-layout default. Keying by content (event type + trigger index
 * within the pipeline, sessionId, command subscription name, error identity)
 * instead survives the id regeneration.
 *
 * The `triggerIndex` for trigger nodes comes from the node's position among
 * other triggers in `allNodes` — both UI-created pipelines and reloaded
 * pipelines iterate triggers in `pipeline.nodes` insertion order, so the
 * index matches across the round-trip.
 */
function semanticNodeKey(node: PipelineNode, allNodes: PipelineNode[]): string | null {
	switch (node.type) {
		case 'trigger': {
			const triggers = allNodes.filter((n) => n.type === 'trigger');
			const idx = triggers.findIndex((n) => n.id === node.id);
			const data = node.data as TriggerNodeData;
			// Fall back to label when eventType is absent (shouldn't happen
			// for well-formed nodes, but defensive against malformed saves).
			return `trigger:${data.eventType ?? data.label ?? 'unknown'}:${idx}`;
		}
		case 'agent': {
			const data = node.data as AgentNodeData;
			const sessionKey = data.sessionId || data.sessionName;
			if (!sessionKey) return null;
			// Disambiguate when the same session appears in the pipeline more
			// than once (e.g. chain A → B → A uses `forceNew` in yamlToPipeline).
			const sameSession = allNodes.filter(
				(n) =>
					n.type === 'agent' &&
					((n.data as AgentNodeData).sessionId || (n.data as AgentNodeData).sessionName) ===
						sessionKey
			);
			const idx = sameSession.findIndex((n) => n.id === node.id);
			return `agent:${sessionKey}:${idx}`;
		}
		case 'command': {
			const data = node.data as CommandNodeData;
			// Subscription name is unique within the owning project's cue.yaml,
			// which makes it a stable content-derived key that survives id
			// regeneration across save/reload.
			return data.name ? `command:${data.name}` : null;
		}
		case 'error': {
			const data = node.data as ErrorNodeData;
			return `error:${data.subscriptionName}:${data.reason}`;
		}
		default:
			return null;
	}
}

/**
 * Merge live pipelines with a saved layout, preserving node positions and
 * the previously selected pipeline.
 *
 * When `savedLayout.selectedPipelineId` is explicitly `null` (meaning
 * "All Pipelines" was selected), that `null` is preserved — it is NOT
 * treated as "missing" and defaulted to the first pipeline.
 *
 * Each live pipeline is matched to a saved pipeline by id first (the normal
 * post-reload case) and falls back to name (covers the unsaved-rename case:
 * saved layout has the rename, live YAML does not). Node positions are then
 * resolved within the matched saved pipeline, preferring a content-derived
 * semantic key so first-save positions survive even though `yamlToPipeline`
 * regenerates node ids on reload. The legacy id-based key remains as a
 * fallback for layouts written before the semantic key was introduced.
 */
export function mergePipelinesWithSavedLayout(
	livePipelines: CuePipeline[],
	savedLayout: PipelineLayoutState
): CuePipelineState {
	const savedById = new Map<string, CuePipeline>();
	const savedByName = new Map<string, CuePipeline>();
	for (const sp of savedLayout.pipelines) {
		savedById.set(sp.id, sp);
		// First wins on name duplicates (unlikely, but defensive: two saved
		// pipelines sharing a name would collide on grouping anyway).
		if (!savedByName.has(sp.name)) savedByName.set(sp.name, sp);
	}

	const mergedPipelines = livePipelines.map((pipeline) => {
		// Resolve which saved pipeline corresponds to this live one:
		//   1. Id match — the normal case once ids have converged across a
		//      save-reload cycle. Required for the unsaved-rename case where
		//      the saved pipeline's name differs from the live YAML name but
		//      the id (derived from the original name) still matches.
		//   2. Name match — catches the first-save case where the saved
		//      layout was written under a different id scheme (e.g. legacy
		//      timestamp ids from before this fix).
		const savedMatch = savedById.get(pipeline.id) ?? savedByName.get(pipeline.name);

		// Name: saved layout wins (users can rename without needing to re-save YAML).
		// Color: YAML is authoritative since `pipeline_color` is persisted there.
		const mergedName = savedMatch?.name ?? pipeline.name;
		// YAML is authoritative for color (round-tripped via `pipeline_color`).
		// Layout-JSON color is only consulted when the live pipeline has none —
		// which doesn't happen in practice because palette fallback always
		// yields a value, but the fallback keeps the merge safe against future
		// refactors that relax `pipeline.color`'s required-ness.
		const mergedColor = pipeline.color || savedMatch?.color || '';

		// Build per-pipeline position lookup maps from the matched saved
		// pipeline. Two indices are maintained so both old (id-based) and
		// new (semantic) layouts resolve.
		const positionsByNodeId = new Map<string, { x: number; y: number }>();
		const positionsBySemantic = new Map<string, { x: number; y: number }>();
		if (savedMatch) {
			for (const savedNode of savedMatch.nodes) {
				positionsByNodeId.set(savedNode.id, savedNode.position);
				const semKey = semanticNodeKey(savedNode, savedMatch.nodes);
				if (semKey) positionsBySemantic.set(semKey, savedNode.position);
			}
		}

		return {
			...pipeline,
			name: mergedName,
			color: mergedColor,
			nodes: pipeline.nodes.map((node) => {
				// Prefer semantic lookup so first-save positions (keyed
				// under UI timestamp ids on disk) still apply after reload
				// regenerates node ids. Fall back to id-based lookup for
				// layouts written when both sides happened to share ids.
				const semKey = semanticNodeKey(node, pipeline.nodes);
				const bySemantic = semKey ? positionsBySemantic.get(semKey) : undefined;
				const byId = positionsByNodeId.get(node.id);
				const savedPos = bySemantic ?? byId;
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
