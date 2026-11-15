/**
 * SourceDistributionChart ("Query Source")
 *
 * Donut showing where the range's AI work came from: Interactive (a prompt you
 * typed), Auto Run, and Cue (when the Cue Encore Feature is on).
 *
 * Queries and Time read the per-source split the main process merges from the
 * stats DB and the Cue DB (`DelegationTotals`), the same numbers the summary
 * ratio card and the Delegation Score use, so the three cannot disagree. Time is
 * each source's real recorded duration, not the total split by query count.
 * Tokens mode reads the transcript-derived token series for Interactive and
 * Auto Run, and Cue's own token totals for the Cue slice.
 */

import { memo, useMemo } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import type { DelegationTotals } from '../../../shared/delegation';
import type { CueStatsSourceTotals } from '../../../shared/cue-stats-types';
import {
	MetricModeToggle,
	OVERVIEW_METRIC_LABELS,
	formatMetricValue,
	metricModeNoun,
	type ChartMetricMode,
} from './MetricModeToggle';
import { useTokenSeries } from './TokenSeriesContext';
import { ChartLoadingOverlay } from './ChartLoadingOverlay';
import { DistributionDonut, type DonutSliceDatum } from './DistributionDonut';
import { delegationColors } from './delegationColors';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';

/** Cue run totals for the selected range, as the dashboard data hook reads them. */
/** Cue's share of the source split: the totals-only Cue read. */
export type CueSourceTotals = CueStatsSourceTotals;

const METRIC_MODES: readonly ChartMetricMode[] = ['count', 'duration', 'tokens'];
const METRIC_STORAGE_KEY = 'usageDashboard.querySource.metric';

interface SourceDistributionChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
	/**
	 * Interactive / Auto Run / Cue split for the selected range. Null when it
	 * failed to load: Queries then falls back to the aggregation's own source
	 * counts (no Cue slice) and Time is not offered, since nothing else records
	 * a real per-source duration.
	 */
	delegation?: DelegationTotals | null;
	/** Draw the Cue slice. False when the Cue Encore Feature is off. */
	includeCue?: boolean;
	/** Input + output tokens across Cue runs in range, for Tokens mode. */
	cueTokens?: number | null;
	/**
	 * Set when the range reaches further back than Cue keeps its run history: the
	 * Cue slice then only covers the last N days, and the chart says so.
	 */
	cueRetentionDays?: number | null;
}

export const SourceDistributionChart = memo(function SourceDistributionChart({
	data,
	theme,
	colorBlindMode = false,
	delegation = null,
	includeCue = false,
	cueTokens = null,
	cueRetentionDays = null,
}: SourceDistributionChartProps) {
	const stored = usePersistedChoice(METRIC_STORAGE_KEY, METRIC_MODES, 'count');
	const modes = useMemo<ChartMetricMode[]>(
		() => (delegation ? ['count', 'duration', 'tokens'] : ['count', 'tokens']),
		[delegation]
	);
	const metricMode: ChartMetricMode = modes.includes(stored.value) ? stored.value : 'count';
	const {
		series: tokenSeries,
		loading: tokensLoading,
		error: tokensError,
	} = useTokenSeries(metricMode === 'tokens');

	const slices = useMemo((): DonutSliceDatum[] => {
		const colors = delegationColors(theme, colorBlindMode);
		const values = (): { interactive: number; auto: number; cue: number } => {
			if (metricMode === 'tokens') {
				return {
					interactive: tokenSeries?.bySource?.user ?? 0,
					auto: tokenSeries?.bySource?.auto ?? 0,
					cue: cueTokens ?? 0,
				};
			}
			if (!delegation) {
				return { interactive: data.bySource.user, auto: data.bySource.auto, cue: 0 };
			}
			if (metricMode === 'duration') {
				return {
					interactive: delegation.interactive.durationMs,
					auto: delegation.autoRun.durationMs,
					cue: delegation.cue.durationMs,
				};
			}
			return {
				interactive: delegation.interactive.count,
				auto: delegation.autoRun.count,
				cue: delegation.cue.count,
			};
		};
		const v = values();
		const result: DonutSliceDatum[] = [
			{ key: 'interactive', label: 'Interactive', value: v.interactive, color: colors.interactive },
			{ key: 'auto', label: 'Auto Run', value: v.auto, color: colors.autoRun },
		];
		if (includeCue) result.push({ key: 'cue', label: 'Cue', value: v.cue, color: colors.cue });
		return result;
	}, [
		data.bySource,
		delegation,
		metricMode,
		tokenSeries,
		cueTokens,
		includeCue,
		theme,
		colorBlindMode,
	]);

	const total = slices.reduce((sum, slice) => sum + slice.value, 0);
	const showTokenError = metricMode === 'tokens' && !tokensLoading && !!tokensError;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Query source chart showing ${metricModeNoun(metricMode)} by source: ${
				includeCue ? 'Interactive, Auto Run, and Cue' : 'Interactive and Auto Run'
			}.`}
		>
			<div className="flex flex-wrap items-center justify-between gap-2 mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Query Source
				</h3>
				<MetricModeToggle
					mode={metricMode}
					onChange={stored.setValue}
					theme={theme}
					modes={modes}
					labels={OVERVIEW_METRIC_LABELS}
					tokensLoading={tokensLoading}
				/>
			</div>

			<div className="relative">
				<ChartLoadingOverlay visible={tokensLoading} theme={theme} />
				{showTokenError ? (
					<div
						className="flex items-center justify-center h-40 text-sm text-center"
						style={{ color: theme.colors.error }}
						data-testid="source-token-error"
					>
						Could not load token usage: {tokensError}
					</div>
				) : total === 0 ? (
					<div
						className="flex items-center justify-center h-40 text-sm"
						style={{ color: theme.colors.textDim }}
					>
						No queries in this range
					</div>
				) : (
					<DistributionDonut
						slices={slices}
						theme={theme}
						formatValue={(value) => formatMetricValue(metricMode, value)}
						centerCaption={metricModeNoun(metricMode)}
						ariaLabel="Query source"
						testId="source-donut"
					/>
				)}
			</div>

			{includeCue && cueRetentionDays != null && (
				<p
					className="mt-3 text-2xs"
					style={{ color: theme.colors.textDim }}
					data-testid="source-cue-retention"
				>
					Cue keeps {cueRetentionDays} days of run history, so the Cue slice covers only the last{' '}
					{cueRetentionDays} days of this range.
				</p>
			)}
		</div>
	);
});

export default SourceDistributionChart;
