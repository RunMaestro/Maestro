/**
 * Tests for the Usage Dashboard's agent-count-over-time series.
 *
 * The series is rebuilt from the live agent list (every agent still present)
 * plus `session_lifecycle` rows (the only record of deleted agents). An agent
 * counts on a day when it existed at the END of that local day.
 */

import { describe, it, expect } from 'vitest';
import {
	buildAgentLifespans,
	agentCountByDay,
	buildAgentCountTimeline,
} from '../../shared/agentCountTimeline';

/** Local timestamp for `YYYY-MM-DD` at `hour`:00. */
const at = (ymd: string, hour = 12): number => {
	const [y, m, d] = ymd.split('-').map(Number);
	return new Date(y, m - 1, d, hour).getTime();
};

describe('buildAgentLifespans', () => {
	it('keeps every live agent open-ended, using its own createdAt', () => {
		const spans = buildAgentLifespans(
			[{ id: 'a', toolType: 'claude-code', createdAt: at('2026-11-01') }],
			[{ sessionId: 'a', agentType: 'claude-code', createdAt: at('2026-10-01') }]
		);
		expect(spans).toEqual([{ id: 'a', createdAt: at('2026-11-01'), closedAt: null }]);
	});

	it('falls back to the lifecycle row, then to always-existed, when a live agent has no createdAt', () => {
		const spans = buildAgentLifespans(
			[
				{ id: 'a', toolType: 'codex' },
				{ id: 'b', toolType: 'codex', createdAt: 0 },
			],
			[{ sessionId: 'a', agentType: 'codex', createdAt: at('2026-10-01') }]
		);
		expect(spans).toEqual([
			{ id: 'a', createdAt: at('2026-10-01'), closedAt: null },
			{ id: 'b', createdAt: 0, closedAt: null },
		]);
	});

	it('adds deleted agents from closed lifecycle rows', () => {
		const spans = buildAgentLifespans(
			[],
			[
				{
					sessionId: 'gone',
					agentType: 'claude-code',
					createdAt: at('2026-10-01'),
					closedAt: at('2026-10-05'),
				},
			]
		);
		expect(spans).toEqual([
			{ id: 'gone', createdAt: at('2026-10-01'), closedAt: at('2026-10-05') },
		]);
	});

	it('drops a vanished agent with no closure, since its end is unknown', () => {
		const spans = buildAgentLifespans(
			[],
			[{ sessionId: 'lost', agentType: 'claude-code', createdAt: at('2026-10-01') }]
		);
		expect(spans).toEqual([]);
	});

	it('skips terminals in both sources', () => {
		const spans = buildAgentLifespans(
			[{ id: 't', toolType: 'terminal', createdAt: at('2026-10-01') }],
			[
				{
					sessionId: 't2',
					agentType: 'terminal',
					createdAt: at('2026-10-01'),
					closedAt: at('2026-10-02'),
				},
			]
		);
		expect(spans).toEqual([]);
	});

	it('merges duplicate lifecycle rows into the widest span', () => {
		const spans = buildAgentLifespans(
			[],
			[
				{
					sessionId: 'x',
					agentType: 'codex',
					createdAt: at('2026-10-03'),
					closedAt: at('2026-10-04'),
				},
				{ sessionId: 'x', agentType: 'codex', createdAt: at('2026-10-01') },
				{
					sessionId: 'x',
					agentType: 'codex',
					createdAt: at('2026-10-02'),
					closedAt: at('2026-10-06'),
				},
			]
		);
		expect(spans).toEqual([{ id: 'x', createdAt: at('2026-10-01'), closedAt: at('2026-10-06') }]);
	});
});

describe('agentCountByDay', () => {
	it('counts agents alive at the end of each day', () => {
		const points = agentCountByDay(
			[
				{ id: 'a', createdAt: at('2026-10-01'), closedAt: null },
				{ id: 'b', createdAt: at('2026-10-02'), closedAt: at('2026-10-03') },
				{ id: 'c', createdAt: at('2026-10-03', 9), closedAt: null },
			],
			'2026-09-30',
			'2026-10-04'
		);
		expect(points).toEqual([
			{ date: '2026-09-30', count: 0 },
			{ date: '2026-10-01', count: 1 },
			{ date: '2026-10-02', count: 2 },
			// b was deleted on the 3rd, c was created the same day.
			{ date: '2026-10-03', count: 2 },
			{ date: '2026-10-04', count: 2 },
		]);
	});

	it('counts an agent created and deleted inside one day nowhere', () => {
		const points = agentCountByDay(
			[{ id: 'a', createdAt: at('2026-10-01', 9), closedAt: at('2026-10-01', 17) }],
			'2026-10-01',
			'2026-10-01'
		);
		expect(points).toEqual([{ date: '2026-10-01', count: 0 }]);
	});

	it('returns nothing for an inverted range', () => {
		expect(agentCountByDay([], '2026-10-02', '2026-10-01')).toEqual([]);
	});
});

describe('buildAgentCountTimeline', () => {
	const now = at('2026-11-14', 15);

	it('ends on today with the live count and tallies range churn', () => {
		const timeline = buildAgentCountTimeline(
			[
				{ id: 'old', createdAt: at('2026-01-01'), closedAt: null },
				{ id: 'new', createdAt: at('2026-11-12'), closedAt: null },
				{ id: 'gone', createdAt: at('2026-01-01'), closedAt: at('2026-11-10') },
			],
			'week',
			now
		);
		expect(timeline.points[0].date).toBe('2026-11-07');
		expect(timeline.points[timeline.points.length - 1]).toEqual({ date: '2026-11-14', count: 2 });
		expect(timeline.created).toBe(1);
		expect(timeline.removed).toBe(1);
	});

	it('starts all-time on the earliest known creation', () => {
		const timeline = buildAgentCountTimeline(
			[
				{ id: 'ancient', createdAt: 0, closedAt: null },
				{ id: 'a', createdAt: at('2026-11-10'), closedAt: null },
			],
			'all',
			now
		);
		expect(timeline.points[0]).toEqual({ date: '2026-11-10', count: 2 });
		expect(timeline.points).toHaveLength(5);
	});

	it('draws a single point for today when there are no agents at all', () => {
		const timeline = buildAgentCountTimeline([], 'all', now);
		expect(timeline.points).toEqual([{ date: '2026-11-14', count: 0 }]);
		expect(timeline.created).toBe(0);
		expect(timeline.removed).toBe(0);
	});
});
