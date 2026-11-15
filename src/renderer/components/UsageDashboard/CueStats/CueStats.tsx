/**
 * CueStats
 *
 * Renders the "Cue" tab of the Usage Dashboard. Consumes
 * `window.maestro.cueStats.getAggregation()` and surfaces totals plus a set of
 * focused panels: time series, hour of day, trigger type, pipeline, provider
 * tokens and the slowest runs. One file per panel lives beside this one.
 *
 * Read and display only. Gating lives in the parent dashboard (the tab is
 * hidden when `encoreFeatures.maestroCue` is off) and in the IPC handler,
 * which throws `'CueStatsDisabled'` when either Encore flag is off; that is
 * rendered as a friendly note as defense in depth.
 *
 * Cue runs live in `cue.db`, not the stats DB, so `stats:updated` never names
 * them: the tab refreshes on the Cue engine's own activity events instead.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { Theme } from '../../../types';
import type { StatsTimeRange } from '../../../../shared/stats-types';
import type { CueStatsAggregation } from '../../../../shared/cue-stats-types';
import { ChartErrorBoundary } from '../ChartErrorBoundary';
import { DashboardPanelState } from '../DashboardPanelState';
import { EmptyState } from '../EmptyState';
import { PercentilesCard } from '../PercentilesCard';
import { buildCueSummary } from '../footerSummary';
import { usePublishFooterSummary } from '../useFooterSummary';
import { DASHBOARD_RESOURCE_DEBOUNCE_MS, useDashboardResource } from '../useDashboardResource';
import { CueStatsSkeleton } from './CueStatsSkeleton';
import { DisabledNote } from './DisabledNote';
import { GroupTable } from './GroupTable';
import { HourOfDayChart } from './HourOfDayChart';
import { ProviderTokensChart } from './ProviderTokensChart';
import { RetentionNote } from './RetentionNote';
import { SlowestRunsTable } from './SlowestRunsTable';
import { SummaryCardsRow } from './SummaryCardsRow';
import { TimeSeriesChart } from './TimeSeriesChart';
import { TriggerTypeChart } from './TriggerTypeChart';
import { TriggerTypeFilter } from './TriggerTypeFilter';
import { loadExcludedTriggers, saveExcludedTriggers } from './cueStatsUtils';

interface CueStatsProps {
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

/** What the fetch resolves to: the payload, or the "feature off" state. */
type CueStatsResult = { disabled: false; aggregation: CueStatsAggregation } | { disabled: true };

function isCueStatsDisabled(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)).includes('CueStatsDisabled');
}

export const CueStats = memo(function CueStats({
	timeRange,
	theme,
	colorBlindMode = false,
}: CueStatsProps) {
	// Raw trigger types the user has hidden. Kept as a sorted, joined string so
	// the cache key is a primitive and an equivalent set does not refetch.
	const [excludedTriggers, setExcludedTriggers] = useState<string[]>(loadExcludedTriggers);
	const excludedKey = useMemo(
		() => [...excludedTriggers].sort().join('\u0000'),
		[excludedTriggers]
	);
	const excludedSet = useMemo(() => new Set(excludedTriggers), [excludedTriggers]);

	const { data, loading, error, refresh } = useDashboardResource<CueStatsResult>(
		`cue-stats:${timeRange}:${excludedKey}`,
		async () => {
			try {
				const aggregation = await window.maestro.cueStats.getAggregation(
					timeRange,
					excludedKey.length === 0 ? [] : excludedKey.split('\u0000')
				);
				return { disabled: false, aggregation };
			} catch (err) {
				// The "feature off" sentinel is an expected state, not an error
				// worth a Sentry report.
				if (isCueStatsDisabled(err)) return { disabled: true };
				throw err;
			}
		},
		'fetchCueStats',
		// No stats table holds Cue runs; refetch only on bulk (untyped) updates
		// here and on Cue activity below.
		{ tables: [] }
	);

	useEffect(() => {
		const subscribe = window.maestro.cue?.onActivityUpdate;
		if (!subscribe) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = subscribe(() => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void refresh();
			}, DASHBOARD_RESOURCE_DEBOUNCE_MS);
		});
		return () => {
			if (timer) clearTimeout(timer);
			unsubscribe();
		};
	}, [refresh]);

	const aggregation = data && !data.disabled ? data.aggregation : null;

	const toggleTrigger = useCallback((key: string) => {
		setExcludedTriggers((prev) => {
			const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
			saveExcludedTriggers(next);
			return next;
		});
	}, []);

	const resetTriggers = useCallback(() => {
		setExcludedTriggers([]);
		saveExcludedTriggers([]);
	}, []);

	// Published above the loading / error / empty returns below: a hook cannot
	// sit behind an early return, and a tab that just went empty is exactly the
	// one that must clear its stale footer line.
	usePublishFooterSummary(
		'cue',
		aggregation
			? buildCueSummary({
					runs: aggregation.totals.occurrences,
					failures: aggregation.totals.failureCount,
					pipelines: aggregation.byPipeline.length,
				})
			: null
	);

	if (loading) return <CueStatsSkeleton theme={theme} />;
	if (data?.disabled) return <DisabledNote theme={theme} />;

	const retention = <RetentionNote timeRange={timeRange} theme={theme} />;

	if (!aggregation) {
		return (
			<div className="space-y-6" data-testid="cue-stats">
				{retention}
				<DashboardPanelState
					theme={theme}
					error={error}
					empty
					emptyMessage="No Cue runs in this time range. Trigger a subscription to populate stats."
					onRetry={() => void refresh()}
					minHeight={160}
					testId="cue-stats"
				/>
			</div>
		);
	}

	const triggerFilter =
		aggregation.triggerTypeOptions.length > 0 ? (
			<TriggerTypeFilter
				options={aggregation.triggerTypeOptions}
				excluded={excludedSet}
				onToggle={toggleTrigger}
				onReset={resetTriggers}
				theme={theme}
			/>
		) : null;

	// The filter can empty the window on its own, so the filter row has to
	// render ABOVE the empty state - otherwise hiding every trigger takes the
	// only control that could bring them back off screen with it.
	if (aggregation.totals.occurrences === 0) {
		return (
			<div className="space-y-6" data-testid="cue-stats">
				{retention}
				{triggerFilter}
				<EmptyState
					theme={theme}
					title="No Cue activity"
					message={
						excludedSet.size > 0
							? 'Every Cue run in this time range belongs to a hidden trigger type.'
							: 'No Cue runs in this time range. Trigger a subscription to populate stats.'
					}
				/>
			</div>
		);
	}

	// Token panels are noise when no agent in the range emitted any tokens
	// (command runs, or providers with no token accessor): hide them rather
	// than drawing zeros everywhere.
	const hasTokenData =
		aggregation.totals.totalInputTokens + aggregation.totals.totalOutputTokens > 0;

	return (
		<div className="space-y-6" data-testid="cue-stats">
			{retention}
			{/* A failed refresh keeps the last result on screen, labelled stale. */}
			<DashboardPanelState
				theme={theme}
				error={error}
				onRetry={() => void refresh()}
				testId="cue-stats"
			>
				<div className="space-y-6">
					{triggerFilter}

					<ChartErrorBoundary theme={theme} chartName="Cue Summary">
						<SummaryCardsRow
							totals={aggregation.totals}
							timeSeries={aggregation.timeSeries}
							theme={theme}
							hasTokenData={hasTokenData}
						/>
					</ChartErrorBoundary>

					<ChartErrorBoundary theme={theme} chartName="Cue Run Duration Percentiles">
						<PercentilesCard
							theme={theme}
							title="Completed Run Duration Percentiles"
							unitLabel="completed runs"
							distribution={aggregation.durationPercentiles}
						/>
					</ChartErrorBoundary>

					<ChartErrorBoundary theme={theme} chartName="Cue Time Series">
						<TimeSeriesChart
							buckets={aggregation.timeSeries}
							bucketSizeMs={aggregation.bucketSizeMs}
							theme={theme}
							colorBlindMode={colorBlindMode}
							showTokens={hasTokenData}
						/>
					</ChartErrorBoundary>

					<ChartErrorBoundary theme={theme} chartName="Cue Hour of Day">
						<HourOfDayChart
							buckets={aggregation.byHourOfDay}
							theme={theme}
							colorBlindMode={colorBlindMode}
						/>
					</ChartErrorBoundary>

					<ChartErrorBoundary theme={theme} chartName="Cue Trigger Types">
						<TriggerTypeChart
							rows={aggregation.byTriggerType}
							theme={theme}
							colorBlindMode={colorBlindMode}
						/>
					</ChartErrorBoundary>

					<ChartErrorBoundary theme={theme} chartName="Cue By Pipeline">
						<GroupTable
							title="By Pipeline"
							rows={aggregation.byPipeline}
							theme={theme}
							testId="cue-stats-pipeline-table"
							keyLabel="Pipeline"
							hideTokenColumns={!hasTokenData}
						/>
					</ChartErrorBoundary>

					{hasTokenData && (
						<ChartErrorBoundary theme={theme} chartName="Cue By Provider">
							<ProviderTokensChart
								rows={aggregation.byAgent}
								theme={theme}
								colorBlindMode={colorBlindMode}
							/>
						</ChartErrorBoundary>
					)}

					<ChartErrorBoundary theme={theme} chartName="Cue Slowest Runs">
						<SlowestRunsTable runs={aggregation.slowestRuns ?? []} theme={theme} />
					</ChartErrorBoundary>
				</div>
			</DashboardPanelState>
		</div>
	);
});
