/**
 * Pure graph traversal that surfaces every agent whose output reaches a given
 * target node — either directly (edge → target) or transitively via one or
 * more intermediate agents that forward it through (edge with
 * `forwardOutput: true`).
 *
 * Used by the UpstreamSourcesPanel to show users the complete list of data
 * streams arriving at the target, not just direct upstream.
 */

import type {
	AgentNodeData,
	CuePipeline,
	PipelineNode,
} from '../../../../shared/cue-pipeline-types';

export interface TransitiveUpstream {
	/** Upstream agent's session name (matches perSourceOutputs / forwardedOutputs keys). */
	source: string;
	/** Pipeline node id of the upstream agent (stable across renames). */
	sourceNodeId: string;
	/** `true` if this is a direct upstream (there is an edge source → target).
	 *  `false` if the output reaches the target via one or more relays. */
	isDirect: boolean;
	/** Session-name chain from the upstream to the node that delivers it to
	 *  target, NOT including the target itself. For a direct source the path
	 *  is `[source]`; for a transitive source reached via B, it is
	 *  `[source, B]`. Useful for the "via B" UI label. */
	path: string[];
	/** For transitive sources only: the edge id where `source → next-in-path`
	 *  carries `forwardOutput: true`. This is the edge the user would flip
	 *  off (via the "stop at upstream" control) to cut the source off from
	 *  the target. Undefined for direct sources. */
	relayEdgeId?: string;
}

function agentNode(nodeById: Map<string, PipelineNode>, id: string): PipelineNode | undefined {
	const node = nodeById.get(id);
	return node?.type === 'agent' ? node : undefined;
}

function sessionName(node: PipelineNode): string {
	return (node.data as AgentNodeData).sessionName;
}

export function computeTransitiveUpstream(
	pipeline: CuePipeline,
	targetNodeId: string
): TransitiveUpstream[] {
	const nodeById = new Map(pipeline.nodes.map((n) => [n.id, n]));
	if (!nodeById.has(targetNodeId)) return [];

	// Index incoming agent edges once — traversal hits these repeatedly.
	const incomingAgentEdges = new Map<string, typeof pipeline.edges>();
	for (const edge of pipeline.edges) {
		if (!agentNode(nodeById, edge.source)) continue;
		const list = incomingAgentEdges.get(edge.target) ?? [];
		list.push(edge);
		incomingAgentEdges.set(edge.target, list);
	}

	const targetAgent = agentNode(nodeById, targetNodeId);

	const results: TransitiveUpstream[] = [];
	const seenSources = new Set<string>();
	// Prevent the target from appearing as its own transitive source when the
	// pipeline contains a cycle back to it.
	if (targetAgent) seenSources.add(sessionName(targetAgent));

	// 1. Direct sources.
	for (const edge of incomingAgentEdges.get(targetNodeId) ?? []) {
		const src = agentNode(nodeById, edge.source);
		if (!src) continue;
		const name = sessionName(src);
		if (seenSources.has(name)) continue;
		seenSources.add(name);
		results.push({
			source: name,
			sourceNodeId: src.id,
			isDirect: true,
			path: [name],
		});
	}

	// 2. Transitive sources: starting from each direct source, walk upward
	//    along edges that carry forwardOutput=true. Use a visited set to
	//    terminate cycles (pipelines may legitimately contain them via fan-in
	//    loopbacks).
	const directs = [...results];
	const visitedRelays = new Set<string>([targetNodeId]);

	function walk(fromNodeId: string, pathToTarget: string[]) {
		if (visitedRelays.has(fromNodeId)) return;
		visitedRelays.add(fromNodeId);
		for (const edge of incomingAgentEdges.get(fromNodeId) ?? []) {
			if (!edge.forwardOutput) continue;
			const src = agentNode(nodeById, edge.source);
			if (!src) continue;
			const name = sessionName(src);
			if (seenSources.has(name)) continue;
			seenSources.add(name);
			const newPath = [name, ...pathToTarget];
			results.push({
				source: name,
				sourceNodeId: src.id,
				isDirect: false,
				path: newPath,
				relayEdgeId: edge.id,
			});
			walk(src.id, newPath);
		}
	}

	for (const direct of directs) {
		walk(direct.sourceNodeId, [direct.source]);
	}

	return results;
}
