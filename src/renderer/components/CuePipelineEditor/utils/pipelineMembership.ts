/**
 * Which pipelines belong to a given agent.
 *
 * "Belongs" has two independent senses, and the Cue dashboard needs both:
 *
 *   - PARTICIPATION - the agent is drawn in the pipeline: an agent node bound
 *     to its session, or a command node that runs in its project root.
 *   - DECLARATION - the pipeline is defined in that agent's own cue.yaml, even
 *     when no node in it points back at the agent (a fan-out that only
 *     dispatches to other agents is the common case).
 *
 * The earlier lookup checked agent nodes only. An `action: command` pipeline -
 * trigger plus shell node, no agent node anywhere - therefore looked like it
 * belonged to nobody: the Sessions table printed an empty dash under Pipelines, and
 * "View in Graph" resolved to nothing and dropped the user into the unfiltered
 * All Pipelines view showing every pipeline on the machine.
 */

import type {
	AgentNodeData,
	CommandNodeData,
	CueGraphSession,
	CuePipeline,
} from '../../../../shared/cue-pipeline-types';
import { getPipelineKey } from './yamlToPipeline';

/** True when the agent is drawn somewhere in the pipeline. */
export function pipelineInvolvesSession(pipeline: CuePipeline, sessionId: string): boolean {
	return pipeline.nodes.some((node) => {
		if (node.type === 'agent') return (node.data as AgentNodeData).sessionId === sessionId;
		if (node.type === 'command')
			return (node.data as CommandNodeData).owningSessionId === sessionId;
		// Trigger nodes carry no session; error nodes are unresolved by definition.
		return false;
	});
}

/**
 * Pipeline names declared in one agent's cue.yaml. Names are the grouping key
 * used by `subscriptionsToPipelines`, so they match `CuePipeline.name` exactly.
 */
export function pipelineNamesDeclaredBySession(
	sessionId: string,
	graphSessions: CueGraphSession[]
): Set<string> {
	const names = new Set<string>();
	for (const gs of graphSessions) {
		if (gs.sessionId !== sessionId) continue;
		for (const sub of gs.subscriptions) names.add(getPipelineKey(sub));
	}
	return names;
}

/**
 * Every pipeline the agent participates in or declares, in the order the
 * pipelines were built (stable across renders for a given graph payload).
 */
export function pipelinesForSession(
	sessionId: string,
	pipelines: CuePipeline[],
	graphSessions: CueGraphSession[] = []
): CuePipeline[] {
	const declared = pipelineNamesDeclaredBySession(sessionId, graphSessions);
	return pipelines.filter((p) => declared.has(p.name) || pipelineInvolvesSession(p, sessionId));
}
