/**
 * Active-agent accounting for the Usage Dashboard.
 *
 * "Active" here is a RANGE question, not a live-status one. An agent is active
 * when it recorded at least one query event inside the dashboard's selected
 * time range. Interactive turns and Auto Run tasks both land in `query_events`;
 * Cue runs do not (they are recorded in cue.db), so an agent driven only by Cue
 * reads as inactive here. Switching the range from Last 30 Days to Last 365 Days
 * therefore widens the answer for free.
 *
 * Counted from the agent's OWN rows only, never a provider-wide total: crediting
 * a sibling agent's work would mark an agent that never ran anything as active.
 */

import type { StatsAggregation } from './stats-types';

/** The only slice of `StatsAggregation` this module needs. */
export type BySessionByDay = StatsAggregation['bySessionByDay'];

/** An agent-shaped record: anything carrying the Maestro session id. */
export interface AgentIdentity {
	id: string;
}

/**
 * Whether one agent recorded work in the range. A session id is present in
 * `bySessionByDay` only when the aggregation found rows for it, so presence
 * alone would nearly always be enough - the count sum still guards against a
 * future aggregation emitting an empty or zeroed day series.
 */
export function isAgentActiveInRange(sessionId: string, bySessionByDay?: BySessionByDay): boolean {
	const days = bySessionByDay?.[sessionId];
	if (!days || days.length === 0) return false;
	return days.some((d) => d.count > 0);
}

/** How many of `agents` recorded work in the range. */
export function countActiveAgents(
	agents: readonly AgentIdentity[],
	bySessionByDay?: BySessionByDay
): number {
	let active = 0;
	for (const agent of agents) {
		if (isAgentActiveInRange(agent.id, bySessionByDay)) active++;
	}
	return active;
}
