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
 * Semantic keys for a node that stay stable across save → reload. UI-created
 * nodes use timestamp-based ids (`trigger-1741234567890`, `agent-s1-1741234567900`)
 * while `yamlToPipeline` regenerates ids from a deterministic scheme on reload
 * (`trigger-0`, `agent-${sessionName}-${size}`). If we looked up positions by
 * node.id alone, first-save positions - keyed by the UI timestamp id -
 * would miss every lookup on the next open and every node would snap back to
 * the auto-layout default.
 *
 * Returns an array of keys in priority order. The first key is the most
 * stable identifier available; subsequent keys are fallbacks for layouts
 * written before that identifier was persisted on the node. When matching,
 * both sides write under EVERY key they produce; lookup tries each live key
 * in priority order against the saved index and uses the first hit.
 *
 * Stable identifiers used (in priority order):
 *   - trigger: `subscriptionName` (unique within the pipeline; written to
 *     YAML as the subscription `name` and re-stamped on every load).
 *   - agent:   `nodeKey` (UUID; round-trips through YAML via
 *     `target_node_key` / `fan_out_node_keys`).
 *   - command: `nodeKey` (UUID; same round-trip as agents).
 *
 * Legacy fallbacks (kept so old saved layouts without these fields still
 * resolve):
 *   - trigger: `eventType + index_among_all_triggers` - fragile to YAML
 *     reordering (e.g. the topo-sort introduced in #981 swaps trigger
 *     positions), which is why the subscriptionName key above was added.
 *   - agent:   `sessionKey + index_among_same_session_agents` - fragile to
 *     same-session-multiple-instance reordering across reload.
 */
function semanticNodeKeys(node: PipelineNode, allNodes: PipelineNode[]): string[] {
	switch (node.type) {
		case 'trigger': {
			const data = node.data as TriggerNodeData;
			const keys: string[] = [];
			if (data.subscriptionName) {
				keys.push(`trigger:sub:${data.subscriptionName}`);
			}
			const triggers = allNodes.filter((n) => n.type === 'trigger');
			const idx = triggers.findIndex((n) => n.id === node.id);
			// Legacy fallback: eventType + index among all triggers.
			keys.push(`trigger:${data.eventType ?? data.label ?? 'unknown'}:${idx}`);
			return keys;
		}
		case 'agent': {
			const data = node.data as AgentNodeData;
			const keys: string[] = [];
			if (data.nodeKey) {
				keys.push(`agent:key:${data.nodeKey}`);
			}
			const sessionKey = data.sessionId || data.sessionName;
			if (sessionKey) {
				// Legacy fallback: sessionKey + index among same-session agents.
				const sameSession = allNodes.filter(
					(n) =>
						n.type === 'agent' &&
						((n.data as AgentNodeData).sessionId || (n.data as AgentNodeData).sessionName) ===
							sessionKey
				);
				const idx = sameSession.findIndex((n) => n.id === node.id);
				keys.push(`agent:${sessionKey}:${idx}`);
			}
			return keys;
		}
		case 'command': {
			const data = node.data as CommandNodeData;
			const keys: string[] = [];
			if (data.nodeKey) {
				keys.push(`command:key:${data.nodeKey}`);
			}
			// Subscription name is unique within the owning project's cue.yaml,
			// which makes it a stable content-derived key that survives id
			// regeneration for legacy layouts written before `nodeKey` was
			// persisted on command nodes.
			if (data.name) {
				keys.push(`command:${data.name}`);
			}
			return keys;
		}
		case 'error': {
			const data = node.data as ErrorNodeData;
			return [`error:${data.subscriptionName}:${data.reason}`];
		}
		default:
			return [];
	}
}

/**
 * Merge live pipelines with a saved layout, preserving node positions and
 * the previously selected pipeline.
 *
 * When `savedLayout.selectedPipelineId` is explicitly `null` (meaning
 * "All Pipelines" was selected), that `null` is preserved - it is NOT
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
		//   1. Id match - the normal case once ids have converged across a
		//      save-reload cycle. Required for the unsaved-rename case where
		//      the saved pipeline's name differs from the live YAML name but
		//      the id (derived from the original name) still matches.
		//   2. Name match - catches the first-save case where the saved
		//      layout was written under a different id scheme (e.g. legacy
		//      timestamp ids from before this fix).
		const savedMatch = savedById.get(pipeline.id) ?? savedByName.get(pipeline.name);

		// Name: saved layout wins (users can rename without needing to re-save YAML).
		// Color: YAML is authoritative since `pipeline_color` is persisted there.
		const mergedName = savedMatch?.name ?? pipeline.name;
		// YAML is authoritative for color (round-tripped via `pipeline_color`).
		// Layout-JSON color is only consulted when the live pipeline has none -
		// which doesn't happen in practice because palette fallback always
		// yields a value, but the fallback keeps the merge safe against future
		// refactors that relax `pipeline.color`'s required-ness.
		const mergedColor = pipeline.color || savedMatch?.color || '';

		// Build per-pipeline position lookup maps from the matched saved
		// pipeline. Two indices are maintained so both old (id-based) and
		// new (semantic) layouts resolve. Each saved node contributes to
		// EVERY semantic key it produces, so a live node looking up via a
		// stable key (e.g. nodeKey-based) hits even when the saved layout
		// only had the legacy fallback key (older saves).
		const positionsByNodeId = new Map<string, { x: number; y: number }>();
		const positionsBySemantic = new Map<string, { x: number; y: number }>();
		if (savedMatch) {
			for (const savedNode of savedMatch.nodes) {
				positionsByNodeId.set(savedNode.id, savedNode.position);
				const semKeys = semanticNodeKeys(savedNode, savedMatch.nodes);
				for (const k of semKeys) {
					// First wins - earlier keys are more stable identifiers,
					// so a stable-key save shouldn't be overwritten by a
					// fallback key produced by another saved node.
					if (!positionsBySemantic.has(k)) {
						positionsBySemantic.set(k, savedNode.position);
					}
				}
			}
		}

		return {
			...pipeline,
			name: mergedName,
			color: mergedColor,
			// viewOffset is layout-only and lives only in the saved layout JSON,
			// not in YAML. Pull it from the saved match so manual All-Pipelines
			// arrangements survive a reload.
			viewOffset: savedMatch?.viewOffset,
			nodes: pipeline.nodes.map((node) => {
				// Prefer semantic lookup so first-save positions (keyed
				// under UI timestamp ids on disk) still apply after reload
				// regenerates node ids. Try keys in priority order: the
				// most stable identifier (subscriptionName / nodeKey) wins
				// over index-based fallbacks, so a YAML reorder (e.g. the
				// chain-sub topo-sort in #981) can't shuffle positions
				// onto the wrong nodes.
				const semKeys = semanticNodeKeys(node, pipeline.nodes);
				let bySemantic: { x: number; y: number } | undefined;
				for (const k of semKeys) {
					const hit = positionsBySemantic.get(k);
					if (hit) {
						bySemantic = hit;
						break;
					}
				}
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
