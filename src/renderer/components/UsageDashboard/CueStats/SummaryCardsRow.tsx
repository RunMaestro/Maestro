import { memo, useMemo } from 'react';
import { CheckCircle2, Clock, Coins, Zap } from 'lucide-react';
import type { Theme } from '../../../types';
import type { CueStatsTotals, CueTimeBucket } from '../../../../shared/cue-stats-types';
import {
	formatCost,
	formatDurationHuman,
	formatNumber,
	formatTokensCompact,
} from '../../../../shared/formatters';
import { StatCardGrid } from '../../widgets';
import type { StatCardDatum } from '../../widgets';
import {
	averageRunMs,
	formatPercent,
	lastBucketCounts,
	successRate,
	totalTokens,
} from './cueStatsUtils';

/**
 * The Cue tab's headline figures. Run time counts COMPLETED runs only (a
 * failed or swept run's span is not run time); the average divides by those
 * same runs.
 */
export const SummaryCardsRow = memo(function SummaryCardsRow({
	totals,
	timeSeries,
	theme,
	hasTokenData,
}: {
	totals: CueStatsTotals;
	timeSeries: CueTimeBucket[];
	theme: Theme;
	/** When false, the Total Tokens card is left out. */
	hasTokenData: boolean;
}) {
	const runTrend = useMemo(() => lastBucketCounts(timeSeries, (b) => b.occurrences), [timeSeries]);
	const tokenTrend = useMemo(
		() => lastBucketCounts(timeSeries, (b) => b.inputTokens + b.outputTokens),
		[timeSeries]
	);
	const successTrend = useMemo(
		() =>
			lastBucketCounts(timeSeries, (b) => {
				const tracked = b.successCount + b.failureCount;
				return tracked === 0 ? 0 : Math.round((b.successCount / tracked) * 100);
			}),
		[timeSeries]
	);

	const cards: StatCardDatum[] = [
		{ label: 'Runs', icon: Zap, value: totals.occurrences, trend: runTrend },
		{
			label: 'Success Rate',
			icon: CheckCircle2,
			value: successRate(totals),
			displayValue: formatPercent(successRate(totals)),
			trend: successTrend,
			color: theme.colors.success,
			caption: `${formatNumber(totals.successCount)} ok / ${formatNumber(totals.failureCount)} failed`,
		},
		{
			label: 'Run Time',
			icon: Clock,
			value: totals.totalDurationMs,
			displayValue: formatDurationHuman(totals.totalDurationMs),
			caption:
				totals.timedRunCount > 0
					? `${formatDurationHuman(averageRunMs(totals))} avg over ${formatNumber(totals.timedRunCount)} completed`
					: 'no completed runs',
		},
	];
	if (hasTokenData) {
		cards.push({
			label: 'Total Tokens',
			icon: Coins,
			value: totalTokens(totals),
			displayValue: formatTokensCompact(totalTokens(totals)),
			trend: tokenTrend,
			caption:
				totals.totalCostUsd != null && totals.totalCostUsd > 0
					? formatCost(totals.totalCostUsd)
					: undefined,
		});
	}

	return (
		<div data-testid="cue-stats-summary-cards">
			<StatCardGrid theme={theme} cards={cards} minColumnWidth={180} />
		</div>
	);
});
