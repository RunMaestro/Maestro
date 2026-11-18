/**
 * ResilienceStats - Agent Resilience outcomes for the Usage Dashboard.
 *
 * Answers one question: how often did a provider refuse work (quota wall,
 * overload) and Maestro carried the turn through anyway? Metric tiles up top,
 * then a per-day timeline of outages split by outcome.
 *
 * Data source: `resilience_events` (one row per RESOLVED outage - recovered or
 * user-stopped; live countdowns are never recorded). Self-contained on purpose:
 * fetches its own data and takes only `{ timeRange, theme }`.
 */

import { memo, useMemo } from 'react';
import { ShieldCheck, Clock, RefreshCw, Percent } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange, ResilienceEvent } from '../../../shared/stats-types';
import { formatDurationHuman, formatNumber } from '../../../shared/formatters';
import { toLocalYmd } from '../../../shared/localDay';
import { localDaysBetween } from '../../../shared/daySeries';
import { usageReadWindow } from '../../../shared/usageDashboardReads';
import { StatCardGrid } from '../widgets';
import type { StatCardDatum } from '../widgets';
import { DashboardPanelState } from './DashboardPanelState';
import { DayBarTimeline, type DayBarEntry } from './DayBarTimeline';
import { useDashboardResource } from './useDashboardResource';

interface ResilienceStatsProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

const NO_EVENTS: ResilienceEvent[] = [];

export interface ResilienceSummary {
	total: number;
	recovered: number;
	quotaRecovered: number;
	availabilityRecovered: number;
	bridgedMs: number;
	longestMs: number;
	retries: number;
	rate: number;
}

export function summarizeResilience(events: ResilienceEvent[]): ResilienceSummary {
	const recovered = events.filter((e) => e.outcome === 'recovered');
	const quotaRecovered = recovered.filter((e) => e.strategy === 'token-exhaustion').length;
	return {
		total: events.length,
		recovered: recovered.length,
		quotaRecovered,
		availabilityRecovered: recovered.length - quotaRecovered,
		// Downtime the user did NOT have to babysit: summed wait of recovered
		// outages. Stopped outages are excluded - that wait ended in the user
		// taking over, so nothing was bridged.
		bridgedMs: recovered.reduce((sum, e) => sum + (e.resolvedAt - e.startedAt), 0),
		longestMs: recovered.reduce((max, e) => Math.max(max, e.resolvedAt - e.startedAt), 0),
		retries: events.reduce((sum, e) => sum + e.retries, 0),
		rate: events.length > 0 ? Math.round((recovered.length / events.length) * 100) : 0,
	};
}

/** One entry per day of the range: recovered outages, then stopped ones. */
export function buildResilienceDays(
	events: ResilienceEvent[],
	timeRange: StatsTimeRange,
	colors: { recovered: string; stopped: string },
	now: number = Date.now()
): Array<DayBarEntry & { recovered: number; stopped: number }> {
	if (events.length === 0) return [];
	const earliest = toLocalYmd(Math.min(...events.map((e) => e.startedAt)));
	const window = usageReadWindow(timeRange, earliest, now);
	const byDay = new Map<string, { recovered: number; stopped: number }>();
	for (const event of events) {
		const key = toLocalYmd(event.startedAt);
		const day = byDay.get(key) ?? { recovered: 0, stopped: 0 };
		if (event.outcome === 'recovered') day.recovered++;
		else day.stopped++;
		byDay.set(key, day);
	}
	return localDaysBetween(window.startYmd, window.endYmd).map((date) => {
		const day = byDay.get(date) ?? { recovered: 0, stopped: 0 };
		return {
			date,
			...day,
			segments: [
				{ value: day.recovered, color: colors.recovered },
				{ value: day.stopped, color: colors.stopped },
			],
		};
	});
}

export const ResilienceStats = memo(function ResilienceStats({
	timeRange,
	theme,
}: ResilienceStatsProps) {
	const { data, loading, error, refresh } = useDashboardResource(
		`resilience:${timeRange}`,
		() => window.maestro.stats.getResilience(timeRange),
		'fetchResilienceStats',
		{ tables: ['resilience'] }
	);
	const events = data ?? NO_EVENTS;
	const summary = useMemo(() => summarizeResilience(events), [events]);
	const days = useMemo(
		() =>
			buildResilienceDays(events, timeRange, {
				recovered: theme.colors.success,
				stopped: theme.colors.error,
			}),
		[events, timeRange, theme.colors.success, theme.colors.error]
	);

	const cards: StatCardDatum[] = [
		{
			label: 'Outages Survived',
			icon: ShieldCheck,
			value: summary.recovered,
			caption: `${summary.quotaRecovered} quota · ${summary.availabilityRecovered} availability`,
		},
		{
			label: 'Downtime Bridged',
			icon: Clock,
			value: summary.bridgedMs,
			displayValue: summary.bridgedMs > 0 ? formatDurationHuman(summary.bridgedMs) : '0m',
			caption:
				summary.longestMs > 0 ? `longest ${formatDurationHuman(summary.longestMs)}` : undefined,
		},
		{
			label: 'Recovery Rate',
			icon: Percent,
			value: summary.rate,
			displayValue: `${summary.rate}%`,
			caption: `${summary.recovered} of ${summary.total} outages`,
		},
		{
			label: 'Auto-Retries Sent',
			icon: RefreshCw,
			value: summary.retries,
		},
	];

	return (
		<div data-testid="resilience-stats" role="region" aria-label="Resilience statistics">
			<h3
				className="text-sm font-medium mb-3 flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<ShieldCheck className="w-4 h-4" style={{ color: theme.colors.accent }} />
				Resilience
			</h3>
			<DashboardPanelState
				theme={theme}
				loading={loading}
				error={error}
				empty={events.length === 0}
				emptyMessage="No provider outages in this time range. When a quota wall or overload interrupts a turn, the automatic recovery shows up here."
				onRetry={() => void refresh()}
				testId="resilience-stats"
			>
				<div className="space-y-4">
					<StatCardGrid theme={theme} cards={cards} />
					<DayBarTimeline
						days={days}
						theme={theme}
						title="Outages Over Time"
						legend={[
							{ label: 'Recovered', color: theme.colors.success },
							{ label: 'Stopped', color: theme.colors.error },
						]}
						ariaLabel="Provider outages per day, split by outcome"
						testId="resilience-timeline"
						describeDay={(day) => {
							const d = day as (typeof days)[number];
							return `${day.date}: ${formatNumber(d.recovered)} recovered, ${formatNumber(d.stopped)} stopped`;
						}}
						renderTooltip={(day) => {
							const d = day as (typeof days)[number];
							if (d.recovered + d.stopped === 0) return <div>No outages</div>;
							return (
								<>
									{d.recovered > 0 && <div>{formatNumber(d.recovered)} recovered</div>}
									{d.stopped > 0 && <div>{formatNumber(d.stopped)} stopped</div>}
								</>
							);
						}}
					/>
				</div>
			</DashboardPanelState>
		</div>
	);
});
