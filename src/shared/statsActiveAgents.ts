/**
 * Active-agent accounting for the Usage Dashboard.
 *
 * "Active" here is a RANGE question, not a live-status one. An agent is active
 * when it recorded at least one query event inside the dashboard's selected
 * time range - interactive turns, Auto Run tasks, execution-queue drains and
 * Cue runs all land in `query_events`, so one lookup covers every way an agent
 * can do work. Switching the range from This Month to Year to Date therefore
 * widens the answer for free.
 *
 * This deliberately does NOT reuse the dashboard's per-card query count, which
 * falls back to the PROVIDER total when a session has no rows of its own and is
 * the only visible session for that provider. That fallback is right for a card
 * showing "roughly how busy is this provider", and wrong here: it would mark an
 * agent that never ran anything as active because a sibling agent on the same
 * provider did.
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
