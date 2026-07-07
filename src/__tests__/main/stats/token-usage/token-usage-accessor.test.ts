/**
 * Tests for the Cost & Tokens accessor's pure derivation + aggregation logic
 * (exposed via `_internal`): turning an `AgentSessionInfo` into a per-session
 * breakdown, rolling breakdowns up into the dashboard aggregate, and time
 * bucketing. The storage-reading / caching path is covered separately.
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// The accessor imports the cache, which imports electron.app at module load.
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => path.join(os.tmpdir(), 'maestro-token-usage-accessor-test')),
	},
}));

import { _internal } from '../../../../main/stats/token-usage/token-usage-accessor';
import type { AgentSessionInfo } from '../../../../main/agents/session-storage';
import type { ModelTokenUsage, SessionTokenBreakdown } from '../../../../shared/tokenUsage';

const { toBreakdown, aggregate, bucketStart } = _internal;

function makeInfo(overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
	return {
		sessionId: 'sess-1',
		projectPath: '/proj/alpha',
		firstMessage: '',
		messageCount: 1,
		timestamp: '2026-01-15T12:00:00Z',
		modifiedAt: '2026-01-15T12:00:00Z',
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		sizeBytes: 10,
		durationSeconds: 0,
		...overrides,
	} as AgentSessionInfo;
}

function model(overrides: Partial<ModelTokenUsage> = {}): ModelTokenUsage {
	return {
		model: 'claude-opus-4-8',
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0,
		costEstimated: false,
		...overrides,
	};
}

function breakdown(overrides: Partial<SessionTokenBreakdown> = {}): SessionTokenBreakdown {
	const byModel = overrides.byModel ?? [model({ inputTokens: 100, costUsd: 1 })];
	return {
		sessionId: 'sess-1',
		agentType: 'claude-code',
		projectPath: '/proj/alpha',
		timestampMs: Date.parse('2026-01-15T12:00:00Z'),
		byModel,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0,
		costEstimated: false,
		coverage: 'full',
		...overrides,
	};
}

describe('toBreakdown', () => {
	it('trusts a storage-supplied per-model split and sums it into the totals', () => {
		const info = makeInfo({
			byModel: [
				model({ model: 'claude-opus-4-8', inputTokens: 100, costUsd: 1 }),
				model({ model: 'claude-fable-5', outputTokens: 200, costUsd: 2 }),
			],
		});

		const bd = toBreakdown('claude-code', info);
		expect(bd.byModel).toHaveLength(2);
		expect(bd.inputTokens).toBe(100);
		expect(bd.outputTokens).toBe(200);
		expect(bd.costUsd).toBeCloseTo(3, 10);
		expect(bd.coverage).toBe('full');
	});

	it('falls back to a single unknown-model bucket from session totals when no split exists', () => {
		const info = makeInfo({ inputTokens: 50, outputTokens: 10, costUsd: 0.25 });

		const bd = toBreakdown('opencode', info);
		expect(bd.byModel).toHaveLength(1);
		expect(bd.byModel[0].model).toBe('');
		expect(bd.byModel[0].inputTokens).toBe(50);
		// Provider reported a cost -> trusted, not estimated.
		expect(bd.byModel[0].costUsd).toBeCloseTo(0.25, 10);
		expect(bd.byModel[0].costEstimated).toBe(false);
	});

	it('marks the fallback bucket estimated when the agent reports no cost', () => {
		const info = makeInfo({ inputTokens: 50, outputTokens: 10 }); // costUsd undefined

		const bd = toBreakdown('codex', info);
		expect(bd.byModel[0].costEstimated).toBe(true);
		expect(bd.coverage).toBe('partial');
	});

	it('produces an empty split for a session with no tokens at all', () => {
		const bd = toBreakdown('claude-code', makeInfo());
		expect(bd.byModel).toEqual([]);
	});

	it('reports unsupported coverage for an unknown agent type', () => {
		const bd = toBreakdown('made-up-agent', makeInfo({ inputTokens: 1 }));
		expect(bd.coverage).toBe('unsupported');
	});
});

describe('aggregate', () => {
	it('rolls sessions up into totals and by-agent / by-model / by-project groups', () => {
		const all: SessionTokenBreakdown[] = [
			breakdown({
				sessionId: 's1',
				agentType: 'claude-code',
				projectPath: '/proj/alpha',
				byModel: [model({ model: 'claude-opus-4-8', inputTokens: 100, costUsd: 1 })],
			}),
			breakdown({
				sessionId: 's2',
				agentType: 'opencode',
				projectPath: '/proj/beta',
				byModel: [model({ model: 'claude-fable-5', outputTokens: 200, costUsd: 4 })],
			}),
		];

		const agg = aggregate(all, {});
		expect(agg.totals.sessionCount).toBe(2);
		expect(agg.totals.inputTokens).toBe(100);
		expect(agg.totals.outputTokens).toBe(200);
		expect(agg.totals.costUsd).toBeCloseTo(5, 10);
		expect(agg.byAgent.map((g) => g.key).sort()).toEqual(['claude-code', 'opencode']);
		expect(agg.byModel.map((g) => g.key).sort()).toEqual(['claude-fable-5', 'claude-opus-4-8']);
		expect(agg.byProject.map((g) => g.label).sort()).toEqual(['alpha', 'beta']);
	});

	it('sorts groups by highest spend first', () => {
		const all: SessionTokenBreakdown[] = [
			breakdown({ sessionId: 'cheap', agentType: 'codex', byModel: [model({ costUsd: 1 })] }),
			breakdown({
				sessionId: 'pricey',
				agentType: 'claude-code',
				byModel: [model({ costUsd: 9 })],
			}),
		];
		const agg = aggregate(all, {});
		expect(agg.byAgent[0].key).toBe('claude-code');
		expect(agg.byAgent[0].costUsd).toBeCloseTo(9, 10);
	});

	it('counts a session once per agent group even when it spans multiple models', () => {
		const all: SessionTokenBreakdown[] = [
			breakdown({
				sessionId: 'multi',
				agentType: 'claude-code',
				byModel: [
					model({ model: 'claude-opus-4-8', inputTokens: 10, costUsd: 1 }),
					model({ model: 'claude-fable-5', outputTokens: 10, costUsd: 1 }),
				],
			}),
		];
		const agg = aggregate(all, {});
		expect(agg.totals.sessionCount).toBe(1);
		expect(agg.byAgent[0].sessionCount).toBe(1);
		// But both models still show up as distinct model groups.
		expect(agg.byModel).toHaveLength(2);
	});

	it('excludes sessions outside the query time window', () => {
		const inWindow = breakdown({
			sessionId: 'in',
			timestampMs: Date.parse('2026-06-15T00:00:00Z'),
		});
		const tooOld = breakdown({
			sessionId: 'old',
			timestampMs: Date.parse('2026-01-01T00:00:00Z'),
		});

		const agg = aggregate([inWindow, tooOld], {
			sinceMs: Date.parse('2026-06-01T00:00:00Z'),
			untilMs: Date.parse('2026-06-30T00:00:00Z'),
		});
		expect(agg.totals.sessionCount).toBe(1);
	});

	it('skips sessions with an empty model split', () => {
		const agg = aggregate([breakdown({ byModel: [] })], {});
		expect(agg.totals.sessionCount).toBe(0);
		expect(agg.timeline).toEqual([]);
	});

	it('records per-agent coverage in the aggregate', () => {
		const agg = aggregate(
			[breakdown({ agentType: 'claude-code' }), breakdown({ sessionId: 's2', agentType: 'codex' })],
			{}
		);
		expect(agg.coverageByAgent['claude-code']).toBe('full');
		expect(agg.coverageByAgent['codex']).toBe('partial');
	});

	it('buckets the timeline and returns it in ascending order', () => {
		const all: SessionTokenBreakdown[] = [
			breakdown({ sessionId: 'a', timestampMs: Date.parse('2026-03-10T09:00:00Z') }),
			breakdown({ sessionId: 'b', timestampMs: Date.parse('2026-03-12T09:00:00Z') }),
		];
		const agg = aggregate(all, { granularity: 'day' });
		expect(agg.timeline).toHaveLength(2);
		expect(agg.timeline[0].startMs).toBeLessThan(agg.timeline[1].startMs);
	});
});

describe('bucketStart', () => {
	it('rounds down to local midnight for day granularity', () => {
		const ms = new Date(2026, 2, 15, 13, 45, 30).getTime();
		const start = new Date(bucketStart(ms, 'day'));
		expect(start.getHours()).toBe(0);
		expect(start.getMinutes()).toBe(0);
		expect(start.getDate()).toBe(15);
	});

	it('rounds down to the first of the month for month granularity', () => {
		const ms = new Date(2026, 2, 15, 13, 45, 30).getTime();
		const start = new Date(bucketStart(ms, 'month'));
		expect(start.getDate()).toBe(1);
		expect(start.getMonth()).toBe(2);
	});

	it('rounds down to Monday for week granularity', () => {
		// 2026-03-15 is a Sunday; the containing week (Mon-start) begins 2026-03-09.
		const ms = new Date(2026, 2, 15, 13, 0, 0).getTime();
		const start = new Date(bucketStart(ms, 'week'));
		expect(start.getDay()).toBe(1); // Monday
		expect(start.getDate()).toBe(9);
	});
});
