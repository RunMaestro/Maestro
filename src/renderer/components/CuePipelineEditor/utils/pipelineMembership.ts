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

/**
 * The one agent a pipeline is filed under on the canvas. A pipeline can belong
 * to several agents (see above), but it can only be DRAWN in one place, so the
 * All Pipelines view clusters each pipeline under a single home and an agent
 * filter pulls the rest in from wherever they live.
 */
export interface PipelineHome {
	sessionId: string;
	sessionName: string;
}

/**
 * Resolve every pipeline's home agent in one pass.
 *
 * The home is the agent whose cue.yaml declares the pipeline. A pipeline can
 * be declared in several files (each leg of a chain lives in the cue.yaml of
 * the agent it runs on), so the agent declaring the MOST of its subscriptions
 * wins, ties going to the agent that also appears in the pipeline and then to
 * the alphabetically first name - deterministic, so the canvas does not
 * reshuffle between renders. A pipeline nobody declares (unsaved, or written
 * by hand) falls back to its first agent or command node. Pipelines with none
 * of those are absent from the map: they have no home to be filed under.
 */
export function resolvePipelineHomes(
	pipelines: CuePipeline[],
	graphSessions: CueGraphSession[] = []
): Map<string, PipelineHome> {
	// pipeline name → sessionId → declared subscription count
	const declaredCounts = new Map<string, Map<string, number>>();
	const sessionNames = new Map<string, string>();
	for (const gs of graphSessions) {
		sessionNames.set(gs.sessionId, gs.sessionName);
		for (const sub of gs.subscriptions) {
			const key = getPipelineKey(sub);
			const perSession = declaredCounts.get(key) ?? new Map<string, number>();
			perSession.set(gs.sessionId, (perSession.get(gs.sessionId) ?? 0) + 1);
			declaredCounts.set(key, perSession);
		}
	}

	const homes = new Map<string, PipelineHome>();
	for (const pipeline of pipelines) {
		const declarers = declaredCounts.get(pipeline.name);
		if (declarers && declarers.size > 0) {
			let best: { sessionId: string; count: number; involved: boolean; name: string } | null = null;
			for (const [sessionId, count] of declarers) {
				const candidate = {
					sessionId,
					count,
					involved: pipelineInvolvesSession(pipeline, sessionId),
					name: sessionNames.get(sessionId) ?? sessionId,
				};
				if (
					!best ||
					candidate.count > best.count ||
					(candidate.count === best.count && candidate.involved && !best.involved) ||
					(candidate.count === best.count &&
						candidate.involved === best.involved &&
						candidate.name.localeCompare(best.name) < 0)
				) {
					best = candidate;
				}
			}
			homes.set(pipeline.id, { sessionId: best!.sessionId, sessionName: best!.name });
			continue;
		}
		for (const node of pipeline.nodes) {
			if (node.type === 'agent') {
				const data = node.data as AgentNodeData;
				homes.set(pipeline.id, { sessionId: data.sessionId, sessionName: data.sessionName });
				break;
			}
			if (node.type === 'command') {
				const data = node.data as CommandNodeData;
				if (!data.owningSessionId) continue;
				homes.set(pipeline.id, {
					sessionId: data.owningSessionId,
					sessionName: data.owningSessionName || data.owningSessionId,
				});
				break;
			}
		}
	}
	return homes;
}

/** An agent the graph can be narrowed to, with every pipeline it belongs to. */
export interface PipelineAgentScope {
	sessionId: string;
	sessionName: string;
	pipelineIds: string[];
}

/**
 * Every agent that owns at least one pipeline, alphabetical. Feeds the graph's
 * Agents picker, so membership is `pipelinesForSession` - the same answer the
 * dashboard's "View in Graph" gives for the same agent.
 */
export function pipelineAgentScopes(
	sessions: { id: string; name: string }[],
	pipelines: CuePipeline[],
	graphSessions: CueGraphSession[] = []
): PipelineAgentScope[] {
	const scopes: PipelineAgentScope[] = [];
	for (const session of sessions) {
		const owned = pipelinesForSession(session.id, pipelines, graphSessions);
		if (owned.length === 0) continue;
		scopes.push({
			sessionId: session.id,
			sessionName: session.name,
			pipelineIds: owned.map((p) => p.id),
		});
	}
	return scopes.sort((a, b) => a.sessionName.localeCompare(b.sessionName));
}
