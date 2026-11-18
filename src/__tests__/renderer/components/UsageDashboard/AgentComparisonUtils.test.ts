import { describe, expect, it } from 'vitest';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES } from '../../../../shared/themes';
import { buildProviderComparisonRows } from '../../../../renderer/components/UsageDashboard/agentComparisonUtils';
import { rankProvidersByCount } from '../../../../renderer/components/UsageDashboard/chartUtils';
import { COLORBLIND_AGENT_PALETTE } from '../../../../renderer/constants/colorblindPalettes';

const theme = THEMES.dracula;

type Input = Pick<StatsAggregation, 'byAgent' | 'byAgentWorktree'>;

const base: Input = {
	byAgent: {
		'claude-code': { count: 10, duration: 1_000 },
		codex: { count: 30, duration: 600 },
	},
	byAgentWorktree: {},
};

describe('rankProvidersByCount', () => {
	it('orders providers by query count, ties broken by key', () => {
		expect(
			rankProvidersByCount({
				b: { count: 5 },
				a: { count: 5 },
				c: { count: 9 },
			})
		).toEqual(['c', 'a', 'b']);
	});

	it('returns an empty list for missing input', () => {
		expect(rankProvidersByCount(undefined)).toEqual([]);
	});
});

describe('buildProviderComparisonRows', () => {
	it('labels rows with the provider display name', () => {
		const rows = buildProviderComparisonRows({
			data: base,
			mode: 'count',
			theme,
			colorBlindMode: false,
		});
		expect(rows.map((r) => r.label)).toEqual(['Codex', 'Claude Code']);
	});

	it('sorts by the active mode and computes shares for count and duration', () => {
		const byCount = buildProviderComparisonRows({
			data: base,
			mode: 'count',
			theme,
			colorBlindMode: false,
		});
		expect(byCount.map((r) => r.provider)).toEqual(['codex', 'claude-code']);
		expect(byCount[0].share).toBeCloseTo(75);

		const byDuration = buildProviderComparisonRows({
			data: base,
			mode: 'duration',
			theme,
			colorBlindMode: false,
		});
		expect(byDuration.map((r) => r.provider)).toEqual(['claude-code', 'codex']);
		expect(byDuration[0].share).toBeCloseTo(62.5);
	});

	it('plots mean time per query in average mode, with no share', () => {
		const rows = buildProviderComparisonRows({
			data: base,
			mode: 'average',
			theme,
			colorBlindMode: false,
		});
		expect(rows.map((r) => [r.provider, r.value])).toEqual([
			['claude-code', 100],
			['codex', 20],
		]);
		expect(rows.every((r) => r.share === null)).toBe(true);
	});

	it('keeps each provider on its shared color whatever the sort', () => {
		const byCount = buildProviderComparisonRows({
			data: base,
			mode: 'count',
			theme,
			colorBlindMode: true,
		});
		const byDuration = buildProviderComparisonRows({
			data: base,
			mode: 'duration',
			theme,
			colorBlindMode: true,
		});
		const color = (rows: typeof byCount, p: string) => rows.find((r) => r.provider === p)?.color;
		// codex has the most queries, so it holds index 0 in both modes.
		expect(color(byCount, 'codex')).toBe(COLORBLIND_AGENT_PALETTE[0]);
		expect(color(byDuration, 'codex')).toBe(COLORBLIND_AGENT_PALETTE[0]);
		expect(color(byDuration, 'claude-code')).toBe(COLORBLIND_AGENT_PALETTE[1]);
	});

	it('splits worktree queries into their own row from the recorded flag', () => {
		const rows = buildProviderComparisonRows({
			data: {
				...base,
				byAgentWorktree: {
					'claude-code': {
						worktree: { count: 4, duration: 400 },
						parent: { count: 6, duration: 600 },
					},
				},
			},
			mode: 'count',
			theme,
			colorBlindMode: false,
		});
		const worktree = rows.find((r) => r.isWorktree);
		const parent = rows.find((r) => r.key === 'claude-code');
		expect(worktree).toMatchObject({
			key: 'claude-code__worktree',
			label: 'Claude Code (Worktree)',
			count: 4,
			duration: 400,
		});
		expect(parent).toMatchObject({ count: 6, duration: 600 });
		expect(worktree?.color).toBe(parent?.color);
	});

	it('draws no worktree rows when no query ran in a worktree', () => {
		const rows = buildProviderComparisonRows({
			data: {
				...base,
				byAgentWorktree: {
					codex: { worktree: { count: 0, duration: 0 }, parent: { count: 30, duration: 600 } },
				},
			},
			mode: 'count',
			theme,
			colorBlindMode: false,
		});
		expect(rows.some((r) => r.isWorktree)).toBe(false);
	});

	it('drops a parent row with no queries left after the worktree split', () => {
		const rows = buildProviderComparisonRows({
			data: {
				byAgent: { codex: { count: 3, duration: 30 } },
				byAgentWorktree: {
					codex: { worktree: { count: 3, duration: 30 }, parent: { count: 0, duration: 0 } },
				},
			},
			mode: 'count',
			theme,
			colorBlindMode: false,
		});
		expect(rows.map((r) => r.key)).toEqual(['codex__worktree']);
	});
});
