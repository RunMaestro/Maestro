/**
 * How many agents existed on each day of a Usage Dashboard range.
 *
 * Rebuilt from two sources, because neither alone covers the fleet:
 *
 * - The LIVE agent list. Every agent still in the Left Bar carries its own
 *   `createdAt`, including agents created before `session_lifecycle` existed or
 *   whose creation row was pruned by stats retention.
 * - The `session_lifecycle` table. It is the only record of an agent that was
 *   deleted: its creation and closure timestamps.
 *
 * An agent counts on day D when it existed at the END of D (created before the
 * next local midnight, not yet deleted then). Today's point is therefore the
 * live agent count. A lifecycle row with no closure whose agent is gone is
 * dropped: there is no way to know when it stopped existing, and guessing
 * "still here" would inflate every later day.
 *
 * Terminals are not agents anywhere in the dashboard, so both sources skip them.
 *
 * Pure and electron-free so the renderer and the CLI share it.
 */

import type { StatsTimeRange } from './stats-types';
import { addLocalDays, parseLocalYmd, toLocalYmd } from './localDay';
import { getTimeRangeStart } from './statsTimeRange';

/** The slice of a live agent this module reads. */
export interface LiveAgentRecord {
	id: string;
	toolType: string;
	createdAt?: number;
}

/** The slice of a `session_lifecycle` row this module reads. */
export interface AgentLifecycleRecord {
	sessionId: string;
	agentType: string;
	createdAt: number;
	closedAt?: number | null;
}

/** When one agent existed. `closedAt: null` means it still exists. */
export interface AgentLifespan {
	id: string;
	createdAt: number;
	closedAt: number | null;
}

export interface AgentCountPoint {
	/** Local `YYYY-MM-DD`. */
	date: string;
	/** Agents that existed at the end of `date`. */
	count: number;
}

export interface AgentCountTimeline {
	points: AgentCountPoint[];
	/** Agents created inside the range. */
	created: number;
	/** Agents deleted inside the range. */
	removed: number;
}

const TERMINAL = 'terminal';

function isValidTimestamp(value: number | null | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * One lifespan per agent. A live agent's own `createdAt` wins; its lifecycle
 * row fills in when the agent has none. An agent with neither is treated as
 * having always existed (`createdAt: 0`), which is the only reading that keeps
 * today's point equal to the live count.
 */
export function buildAgentLifespans(
	liveAgents: readonly LiveAgentRecord[],
	lifecycle: readonly AgentLifecycleRecord[]
): AgentLifespan[] {
	// Earliest creation and latest closure per id: a re-recorded agent keeps
	// the span it really had.
	const rows = new Map<string, { createdAt: number; closedAt: number | null }>();
	for (const row of lifecycle) {
		if (row.agentType === TERMINAL || !isValidTimestamp(row.createdAt)) continue;
		const closedAt = isValidTimestamp(row.closedAt) ? row.closedAt : null;
		const prev = rows.get(row.sessionId);
		rows.set(row.sessionId, {
			createdAt: prev ? Math.min(prev.createdAt, row.createdAt) : row.createdAt,
			closedAt: Math.max(closedAt ?? 0, prev?.closedAt ?? 0) || null,
		});
	}

	const spans: AgentLifespan[] = [];
	const liveIds = new Set<string>();
	for (const agent of liveAgents) {
		if (agent.toolType === TERMINAL) continue;
		liveIds.add(agent.id);
		const createdAt = isValidTimestamp(agent.createdAt)
			? agent.createdAt
			: (rows.get(agent.id)?.createdAt ?? 0);
		spans.push({ id: agent.id, createdAt, closedAt: null });
	}
	for (const [id, row] of rows) {
		if (liveIds.has(id) || row.closedAt === null) continue;
		spans.push({ id, createdAt: row.createdAt, closedAt: row.closedAt });
	}
	return spans;
}

/** Local midnight (ms) that ends `ymd`. */
function endOfLocalDay(ymd: string): number {
	return parseLocalYmd(addLocalDays(ymd, 1))?.getTime() ?? Number.POSITIVE_INFINITY;
}

/**
 * Agent count at the end of every day from `startYmd` to `endYmd` inclusive.
 * One sweep over sorted creation (+1) and deletion (-1) events, so a multi-year
 * range costs the same per day as a week.
 */
export function agentCountByDay(
	spans: readonly AgentLifespan[],
	startYmd: string,
	endYmd: string
): AgentCountPoint[] {
	if (startYmd > endYmd) return [];
	const events: Array<[number, number]> = [];
	for (const span of spans) {
		events.push([span.createdAt, 1]);
		if (span.closedAt !== null) events.push([span.closedAt, -1]);
	}
	events.sort((a, b) => a[0] - b[0]);

	const points: AgentCountPoint[] = [];
	let count = 0;
	let next = 0;
	for (let day = startYmd; day <= endYmd; day = addLocalDays(day, 1)) {
		const boundary = endOfLocalDay(day);
		while (next < events.length && events[next][0] < boundary) {
			count += events[next][1];
			next++;
		}
		points.push({ date: day, count });
	}
	return points;
}

/**
 * The agent-count series for one dashboard range, plus how many agents were
 * created and deleted inside it. All-time starts on the day of the earliest
 * known creation.
 */
export function buildAgentCountTimeline(
	spans: readonly AgentLifespan[],
	range: StatsTimeRange,
	now: number = Date.now()
): AgentCountTimeline {
	let rangeStart = getTimeRangeStart(range, now);
	if (rangeStart === 0) {
		const known = spans.map((s) => s.createdAt).filter((t) => t > 0);
		rangeStart = known.length > 0 ? Math.min(...known) : now;
	}

	let created = 0;
	let removed = 0;
	for (const span of spans) {
		if (span.createdAt >= rangeStart && span.createdAt <= now) created++;
		if (span.closedAt !== null && span.closedAt >= rangeStart && span.closedAt <= now) removed++;
	}

	return {
		points: agentCountByDay(spans, toLocalYmd(rangeStart), toLocalYmd(now)),
		created,
		removed,
	};
}
