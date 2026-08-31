/**
 * Tests for the group-level stats rollup.
 *
 * The arithmetic here decides what a user is told a client cost, so the cases
 * that matter most are the ones where a plausible-looking implementation is
 * wrong: dangling group pointers, days that have to merge rather than
 * concatenate, and the difference between "no token data" and "zero tokens".
 */

import { describe, it, expect } from 'vitest';
import {
	rollUpGroupStats,
	rollUpGroup,
	groupSessions,
	totalTokens,
	UNGROUPED_ID,
	UNGROUPED_NAME,
	type GroupLike,
	type GroupMemberSession,
} from '../../shared/statsGroupRollup';
import type { StatsAggregation } from '../../shared/stats-types';

type RollupData = Pick<StatsAggregation, 'bySessionByDay' | 'bySessionSource'> &
	Partial<Pick<StatsAggregation, 'bySessionTokens'>>;

const GROUPS: GroupLike[] = [
	{ id: 'g-acme', name: 'Acme Corp', emoji: '🏢' },
	{ id: 'g-internal', name: 'Internal', emoji: '🔧' },
];

const SESSIONS: GroupMemberSession[] = [
	{ id: 's1', name: 'Acme API', groupId: 'g-acme', toolType: 'claude-code' },
	{ id: 's2', name: 'Acme Web', groupId: 'g-acme', toolType: 'codex' },
	{ id: 's3', name: 'Tooling', groupId: 'g-internal', toolType: 'claude-code' },
	{ id: 's4', name: 'Scratch', toolType: 'claude-code' },
];

function makeData(overrides: Partial<RollupData> = {}): RollupData {
	return {
		bySessionByDay: {},
		bySessionSource: {},
		...overrides,
	};
}

describe('groupSessions', () => {
	it('buckets sessions by groupId and returns Ungrouped last', () => {
		const buckets = groupSessions(GROUPS, SESSIONS);

		expect(buckets).toHaveLength(3);
		expect(buckets[0].group?.id).toBe('g-acme');
		expect(buckets[0].sessions.map((s) => s.id)).toEqual(['s1', 's2']);
		expect(buckets[1].group?.id).toBe('g-internal');
		expect(buckets[2].group).toBeNull();
		expect(buckets[2].sessions.map((s) => s.id)).toEqual(['s4']);
	});

	it('treats a groupId pointing at a deleted group as ungrouped', () => {
		// A dangling pointer must never make an agent vanish from the totals -
		// the Left Bar makes the same call in useSessionCategories.
		const orphan: GroupMemberSession = { id: 's9', name: 'Orphan', groupId: 'g-gone' };
		const buckets = groupSessions(GROUPS, [...SESSIONS, orphan]);

		expect(buckets[2].sessions.map((s) => s.id)).toEqual(['s4', 's9']);
	});

	it('keeps groups with no members as empty buckets', () => {
		const buckets = groupSessions(GROUPS, [SESSIONS[0]]);

		expect(buckets[1].group?.id).toBe('g-internal');
		expect(buckets[1].sessions).toEqual([]);
	});
});

describe('rollUpGroup', () => {
	it('sums queries and duration across members', () => {
		const data = makeData({
			bySessionByDay: {
				s1: [
					{ date: '2026-08-01', count: 3, duration: 3000 },
					{ date: '2026-08-02', count: 2, duration: 2000 },
				],
				s2: [{ date: '2026-08-02', count: 5, duration: 5000 }],
			},
		});

		const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], data);

		expect(result.queries).toBe(10);
		expect(result.duration).toBe(10000);
	});

	it('merges overlapping days into one sorted series rather than concatenating', () => {
		// Two agents active on the same day are one day of group activity. A
		// concatenated series would draw the same date twice and the sparkline
		// would read as a sawtooth instead of a trend.
		const data = makeData({
			bySessionByDay: {
				s1: [{ date: '2026-08-02', count: 3, duration: 3000 }],
				s2: [
					{ date: '2026-08-02', count: 5, duration: 5000 },
					{ date: '2026-08-01', count: 1, duration: 1000 },
				],
			},
		});

		const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], data);

		expect(result.byDay).toEqual([
			{ date: '2026-08-01', count: 1, duration: 1000 },
			{ date: '2026-08-02', count: 8, duration: 8000 },
		]);
	});

	it('computes auto percent from the summed source split', () => {
		const data = makeData({
			bySessionSource: {
				s1: { user: 10, auto: 30 },
				s2: { user: 10, auto: 0 },
			},
		});

		const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], data);

		expect(result.userQueries).toBe(20);
		expect(result.autoQueries).toBe(30);
		expect(result.autoPercent).toBe(60);
	});

	it('returns null auto percent when the group has no recorded queries', () => {
		// null, not 0 - "never ran" and "ran, all interactive" are different
		// facts, and the tile renders an em-dash for the first.
		const result = rollUpGroup([SESSIONS[0]], makeData());

		expect(result.autoPercent).toBeNull();
	});

	it('sums token and cost totals across members', () => {
		const data = makeData({
			bySessionTokens: {
				s1: {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 10,
					cacheCreationTokens: 5,
					costUsd: 1.5,
					pricedQueries: 3,
				},
				s2: {
					inputTokens: 200,
					outputTokens: 100,
					cacheReadTokens: 20,
					cacheCreationTokens: 0,
					costUsd: 2.25,
					pricedQueries: 4,
				},
			},
		});

		const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], data);

		expect(result.tokens.inputTokens).toBe(300);
		expect(result.tokens.outputTokens).toBe(150);
		expect(result.tokens.cacheReadTokens).toBe(30);
		expect(result.tokens.cacheCreationTokens).toBe(5);
		expect(result.tokens.costUsd).toBeCloseTo(3.75);
		expect(result.tokens.pricedQueries).toBe(7);
		expect(totalTokens(result.tokens)).toBe(485);
	});

	it('reports zero priced queries when no member has token data', () => {
		// The distinction the UI needs: 40 queries and no usage rows is "not
		// recorded", not "$0.00 spent".
		const data = makeData({
			bySessionByDay: { s1: [{ date: '2026-08-01', count: 40, duration: 40000 }] },
		});

		const result = rollUpGroup([SESSIONS[0]], data);

		expect(result.queries).toBe(40);
		expect(result.tokens.pricedQueries).toBe(0);
		expect(result.tokens.costUsd).toBe(0);
	});

	it('collects the distinct providers its members use, sorted', () => {
		const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], makeData());

		expect(result.providers).toEqual(['claude-code', 'codex']);
	});

	it('ignores sessions with no recorded activity instead of throwing', () => {
		const result = rollUpGroup([{ id: 'unknown', name: 'Unknown' }], makeData());

		expect(result.queries).toBe(0);
		expect(result.byDay).toEqual([]);
		expect(result.providers).toEqual([]);
	});
});

describe('rollUpGroupStats', () => {
	const data = makeData({
		bySessionByDay: {
			s1: [{ date: '2026-08-01', count: 4, duration: 4000 }],
			s3: [{ date: '2026-08-01', count: 1, duration: 1000 }],
			s4: [{ date: '2026-08-01', count: 7, duration: 7000 }],
		},
	});

	it('returns one rollup per non-empty group plus Ungrouped last', () => {
		const rollups = rollUpGroupStats(GROUPS, SESSIONS, data);

		expect(rollups.map((r) => r.groupId)).toEqual(['g-acme', 'g-internal', UNGROUPED_ID]);
		expect(rollups[2].name).toBe(UNGROUPED_NAME);
		expect(rollups[2].isUngrouped).toBe(true);
		expect(rollups[0].isUngrouped).toBe(false);
	});

	it('omits empty groups by default', () => {
		const rollups = rollUpGroupStats(GROUPS, [SESSIONS[0]], data);

		expect(rollups.map((r) => r.groupId)).toEqual(['g-acme']);
	});

	it('keeps empty groups when asked', () => {
		const rollups = rollUpGroupStats(GROUPS, [SESSIONS[0]], data, {
			includeEmptyGroups: true,
			includeEmptyUngrouped: true,
		});

		expect(rollups.map((r) => r.groupId)).toEqual(['g-acme', 'g-internal', UNGROUPED_ID]);
		expect(rollups[1].memberCount).toBe(0);
	});

	it('carries the group name, emoji, and member list onto the rollup', () => {
		const rollups = rollUpGroupStats(GROUPS, SESSIONS, data);

		expect(rollups[0].name).toBe('Acme Corp');
		expect(rollups[0].emoji).toBe('🏢');
		expect(rollups[0].memberCount).toBe(2);
		expect(rollups[0].sessions.map((s) => s.id)).toEqual(['s1', 's2']);
	});

	it('accounts for every query exactly once across all buckets', () => {
		// The property that makes group totals trustworthy: the tiles must
		// reconcile with the dashboard's overall total, so no session may be
		// counted twice or dropped.
		const rollups = rollUpGroupStats(GROUPS, SESSIONS, data);
		const total = rollups.reduce((sum, r) => sum + r.queries, 0);

		expect(total).toBe(12);
	});

	it('returns no rollups when there are neither groups nor ungrouped agents', () => {
		expect(rollUpGroupStats([], [], data)).toEqual([]);
	});

	it('rolls every agent into Ungrouped when no groups exist', () => {
		const rollups = rollUpGroupStats([], SESSIONS, data);

		expect(rollups).toHaveLength(1);
		expect(rollups[0].groupId).toBe(UNGROUPED_ID);
		expect(rollups[0].memberCount).toBe(4);
	});

	it('tolerates an aggregation with no bySessionTokens (older main-process build)', () => {
		const rollups = rollUpGroupStats(GROUPS, SESSIONS, {
			bySessionByDay: data.bySessionByDay,
			bySessionSource: data.bySessionSource,
		});

		expect(rollups[0].tokens.pricedQueries).toBe(0);
		expect(rollups[0].queries).toBe(4);
	});
});
