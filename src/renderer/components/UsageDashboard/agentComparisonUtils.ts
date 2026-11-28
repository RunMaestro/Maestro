import type { StatsAggregation } from '../../hooks/stats/useStats';
import type { Theme } from '../../types';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { getSeriesColor, rankProvidersByCount } from './chartUtils';

/** What Provider Comparison plots: queries, total time, or mean time per query. */
export type ComparisonMode = 'count' | 'duration' | 'average';

export interface ProviderComparisonRow {
	/** Unique row key: the provider id, plus `__worktree` for its worktree row. */
	key: string;
	label: string;
	provider: string;
	count: number;
	duration: number;
	/** Mean time per query in ms (0 when the row has no queries). */
	average: number;
	/** The value the active mode plots. */
	value: number;
	/** Share of the column total, for count and duration (null for average). */
	share: number | null;
	color: string;
	isWorktree: boolean;
}

function valueFor(mode: ComparisonMode, count: number, duration: number): number {
	if (mode === 'count') return count;
	if (mode === 'duration') return duration;
	return count > 0 ? duration / count : 0;
}

/**
 * One row per provider, sorted by the active mode, busiest first.
 *
 * When any query in range ran in a worktree agent, each provider with worktree
 * queries gets a second "(Worktree)" row. The split comes from
 * `byAgentWorktree`, the flag recorded on each query when it ran, so it stays
 * exact after the worktree agent is deleted.
 *
 * Colors follow `rankProvidersByCount`, the order Provider Trends uses, so a
 * provider is the same color in both charts whatever the active mode.
 */
export function buildProviderComparisonRows({
	data,
	mode,
	theme,
	colorBlindMode,
}: {
	data: Pick<StatsAggregation, 'byAgent' | 'byAgentWorktree'>;
	mode: ComparisonMode;
	theme: Theme;
	colorBlindMode: boolean;
}): ProviderComparisonRow[] {
	const order = rankProvidersByCount(data.byAgent);
	const split = data.byAgentWorktree ?? {};
	const hasWorktree = Object.values(split).some((entry) => entry.worktree.count > 0);

	const raw: Array<Omit<ProviderComparisonRow, 'value' | 'share'>> = [];
	order.forEach((provider, index) => {
		const color = getSeriesColor(index, theme, colorBlindMode);
		const label = getAgentDisplayName(provider);
		const totals = data.byAgent[provider];
		const worktree = hasWorktree ? split[provider]?.worktree : undefined;
		const parentCount = totals.count - (worktree?.count ?? 0);
		const parentDuration = totals.duration - (worktree?.duration ?? 0);
		if (parentCount > 0) {
			raw.push({
				key: provider,
				label,
				provider,
				count: parentCount,
				duration: parentDuration,
				average: parentCount > 0 ? parentDuration / parentCount : 0,
				color,
				isWorktree: false,
			});
		}
		if (worktree && worktree.count > 0) {
			raw.push({
				key: `${provider}__worktree`,
				label: `${label} (Worktree)`,
				provider,
				count: worktree.count,
				duration: worktree.duration,
				average: worktree.duration / worktree.count,
				color,
				isWorktree: true,
			});
		}
	});

	const columnTotal = raw.reduce((sum, row) => sum + valueFor(mode, row.count, row.duration), 0);
	return raw
		.map((row) => {
			const value = valueFor(mode, row.count, row.duration);
			return {
				...row,
				value,
				share: mode === 'average' || columnTotal <= 0 ? null : (value / columnTotal) * 100,
			};
		})
		.sort((a, b) => b.value - a.value);
}
