/**
 * Group-level stats rollup.
 *
 * The stats DB records one row per turn keyed by Maestro session id, and the
 * Left Bar's groups are a `groupId` pointer on each agent. Neither side knows
 * about the other, so "how much did this client cost me" is a join that has to
 * happen somewhere. It happens here, once, over the per-session maps the
 * aggregation already returns (`bySessionByDay`, `bySessionSource`,
 * `bySessionTokens`).
 *
 * The join is deliberately LIVE rather than snapshotted into the DB at write
 * time: moving an agent into a different group re-buckets its whole history,
 * which is what "bundle these agents under a client" implies. The cost of that
 * choice is that a deleted agent's rows can no longer be attributed, so they
 * land in the synthetic "Ungrouped" bucket along with agents the user never
 * filed. That keeps the group totals reconcilable with the dashboard's overall
 * totals - every recorded query belongs to exactly one bucket.
 *
 * Pure and dependency-free (structural inputs, no renderer types) so both the
 * dashboard and any future CLI/web surface can call it, and so the arithmetic
 * is unit-testable without a store.
 */

import type { StatsAggregation } from './stats-types';

/** Synthetic group id for agents with no `groupId`. Not a real group. */
export const UNGROUPED_ID = '__ungrouped__';

/** Display name for the synthetic bucket. */
export const UNGROUPED_NAME = 'Ungrouped';

/** The slice of a `Group` this module needs. */
export interface GroupLike {
	id: string;
	name: string;
	emoji?: string;
}

/** The slice of a `Session` this module needs. */
export interface GroupMemberSession {
	id: string;
	name: string;
	groupId?: string;
	/** Provider id. Terminal sessions are excluded by the caller, not here. */
	toolType?: string;
}

/** Token and cost totals for one group. */
export interface GroupTokenTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	/**
	 * How many of the group's queries carried token data. Rows recorded before
	 * the token columns existed report nothing, so a group can have hundreds of
	 * queries and a handful of priced ones - the UI needs to say "since we
	 * started recording" rather than present a total as if it covered them all.
	 */
	pricedQueries: number;
}

/** Everything one group tile needs. */
export interface GroupStatRollup {
	groupId: string;
	name: string;
	emoji?: string;
	/** True for the synthetic Ungrouped bucket. */
	isUngrouped: boolean;
	/** Member sessions, in the order the caller supplied them. */
	sessions: GroupMemberSession[];
	memberCount: number;
	queries: number;
	/** Summed query duration in ms. */
	duration: number;
	userQueries: number;
	autoQueries: number;
	/** 0-100, or null when the group has no recorded queries. */
	autoPercent: number | null;
	/** Daily query counts across the whole group, oldest to newest. */
	byDay: Array<{ date: string; count: number; duration: number }>;
	tokens: GroupTokenTotals;
	/** Distinct providers used by the group's members, sorted. */
	providers: string[];
}

const EMPTY_TOKENS: GroupTokenTotals = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	costUsd: 0,
	pricedQueries: 0,
};

/** Total tokens across every bucket. Cache reads are included - they are real
 *  tokens the provider processed and priced, just cheaply. */
export function totalTokens(tokens: GroupTokenTotals): number {
	return (
		tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens
	);
}

/**
 * Group members by `groupId`, in the order `groups` defines. Agents whose
 * `groupId` points at a group that no longer exists fall into Ungrouped, which
 * mirrors how `useSessionCategories` renders the Left Bar - a dangling pointer
 * must never make an agent disappear from a total.
 */
export function groupSessions<T extends GroupMemberSession>(
	groups: GroupLike[],
	sessions: T[]
): Array<{ group: GroupLike | null; sessions: T[] }> {
	const liveIds = new Set(groups.map((g) => g.id));
	const byGroup = new Map<string, T[]>();
	const ungrouped: T[] = [];

	for (const session of sessions) {
		const id = session.groupId;
		if (!id || !liveIds.has(id)) {
			ungrouped.push(session);
			continue;
		}
		const bucket = byGroup.get(id);
		if (bucket) {
			bucket.push(session);
		} else {
			byGroup.set(id, [session]);
		}
	}

	const result: Array<{ group: GroupLike | null; sessions: T[] }> = groups.map((group) => ({
		group,
		sessions: byGroup.get(group.id) ?? [],
	}));
	result.push({ group: null, sessions: ungrouped });
	return result;
}

/**
 * Sum one group's slice of the aggregation.
 *
 * Every input map is keyed by Maestro session id, so this is a straight
 * accumulate over the members. Days are merged into a single sorted series
 * rather than concatenated, otherwise a group of five agents would draw five
 * overlapping sawteeth instead of one activity curve.
 */
export function rollUpGroup(
	sessions: GroupMemberSession[],
	data: Pick<StatsAggregation, 'bySessionByDay' | 'bySessionSource'> &
		Partial<Pick<StatsAggregation, 'bySessionTokens'>>
): Omit<
	GroupStatRollup,
	'groupId' | 'name' | 'emoji' | 'isUngrouped' | 'sessions' | 'memberCount'
> {
	const dayTotals = new Map<string, { count: number; duration: number }>();
	let queries = 0;
	let duration = 0;
	let userQueries = 0;
	let autoQueries = 0;
	const tokens: GroupTokenTotals = { ...EMPTY_TOKENS };
	const providers = new Set<string>();

	for (const session of sessions) {
		if (session.toolType) providers.add(session.toolType);

		for (const day of data.bySessionByDay?.[session.id] ?? []) {
			queries += day.count;
			duration += day.duration;
			const existing = dayTotals.get(day.date);
			if (existing) {
				existing.count += day.count;
				existing.duration += day.duration;
			} else {
				dayTotals.set(day.date, { count: day.count, duration: day.duration });
			}
		}

		const split = data.bySessionSource?.[session.id];
		if (split) {
			userQueries += split.user;
			autoQueries += split.auto;
		}

		const usage = data.bySessionTokens?.[session.id];
		if (usage) {
			tokens.inputTokens += usage.inputTokens;
			tokens.outputTokens += usage.outputTokens;
			tokens.cacheReadTokens += usage.cacheReadTokens;
			tokens.cacheCreationTokens += usage.cacheCreationTokens;
			tokens.costUsd += usage.costUsd;
			tokens.pricedQueries += usage.pricedQueries;
		}
	}

	const sourceTotal = userQueries + autoQueries;
	const byDay = [...dayTotals.entries()]
		.map(([date, totals]) => ({ date, ...totals }))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

	return {
		queries,
		duration,
		userQueries,
		autoQueries,
		autoPercent: sourceTotal > 0 ? Math.round((autoQueries / sourceTotal) * 100) : null,
		byDay,
		tokens,
		providers: [...providers].sort(),
	};
}

export interface RollUpGroupStatsOptions {
	/**
	 * Keep groups with no members. Off by default: an empty group is noise on a
	 * usage dashboard, and the user already sees it in the Left Bar.
	 */
	includeEmptyGroups?: boolean;
	/** Keep the Ungrouped bucket even when it has no members. Off by default. */
	includeEmptyUngrouped?: boolean;
}

/**
 * Build one rollup per group, plus the Ungrouped bucket last.
 *
 * The caller owns filtering (terminal sessions) and sorting - this returns the
 * groups in their stored order so the dashboard can match the Left Bar, and any
 * other order is a display decision.
 */
export function rollUpGroupStats(
	groups: GroupLike[],
	sessions: GroupMemberSession[],
	data: Pick<StatsAggregation, 'bySessionByDay' | 'bySessionSource'> &
		Partial<Pick<StatsAggregation, 'bySessionTokens'>>,
	options: RollUpGroupStatsOptions = {}
): GroupStatRollup[] {
	const buckets = groupSessions(groups, sessions);
	const rollups: GroupStatRollup[] = [];

	for (const { group, sessions: members } of buckets) {
		const isUngrouped = group === null;
		if (members.length === 0) {
			if (isUngrouped ? !options.includeEmptyUngrouped : !options.includeEmptyGroups) {
				continue;
			}
		}
		rollups.push({
			groupId: group?.id ?? UNGROUPED_ID,
			name: group?.name ?? UNGROUPED_NAME,
			emoji: group?.emoji,
			isUngrouped,
			sessions: members,
			memberCount: members.length,
			...rollUpGroup(members, data),
		});
	}

	return rollups;
}
