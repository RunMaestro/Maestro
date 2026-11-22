/**
 * TokenSpeedCards - average and peak tokens per second for output, input, and
 * total, one card each with the average beside the peak.
 *
 * Shared by the Overview (where `OverviewTokenSpeed` fetches the range itself)
 * and the Tokens tab (which already holds the payload), so the two surfaces
 * cannot disagree on what "average" and "peak" mean:
 * - **Average** is token-weighted: all tokens over all measured call time.
 * - **Peak** is the fastest model-hour: one model's calls within one clock
 *   hour, with at least `TOKEN_SPEED_PEAK_MIN_BUCKET_MS` of call time. A single
 *   call is too coarsely timed to trust as a maximum (see `shared/tokenSpeed.ts`).
 * Input counts every prompt token a call processed, cache reads included, which
 * is why it runs orders of magnitude above output.
 */

import { memo } from 'react';
import { format } from 'date-fns';
import { ArrowDownToLine, ArrowUpFromLine, Gauge } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange } from '../../../shared/stats-types';
import {
	TOKEN_SPEED_PEAK_MIN_BUCKET_MS,
	type TokenSpeedStats,
	type TokenSpeedSummary,
} from '../../../shared/tokenSpeed';
import { formatNumber, formatTokensPerSecond } from '../../../shared/formatters';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { MetricCard } from './SummaryCards';
import { SummaryCardsSkeleton } from './ChartSkeletons';
import { DashboardPanelState } from './DashboardPanelState';
import { useTokenUsage } from './useTokenUsage';

interface TokenSpeedCardsProps {
	speed: TokenSpeedSummary;
	theme: Theme;
}

/** What a peak is, in the user's terms. Said once, by the surface's heading. */
const TOKEN_SPEED_PEAK_NOTE = `peak = fastest model-hour (${TOKEN_SPEED_PEAK_MIN_BUCKET_MS / 60_000}+ min of calls)`;

/** Where and on what the output peak happened, for the Output card's detail. */
function peakContext(stats: TokenSpeedStats): string | null {
	if (stats.peakOutputAtMs === undefined) return null;
	const when = format(stats.peakOutputAtMs, 'MMM d, h a');
	return stats.peakOutputModel ? `${stats.peakOutputModel} · ${when}` : when;
}

/** "Claude Code, Codex and OpenCode": the providers whose speed can be measured. */
function measurableAgentsText(agentIds: readonly string[]): string {
	const names = agentIds.map(getAgentDisplayName);
	return names.length <= 1
		? (names[0] ?? '')
		: `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Three cards (Output, Input, Total), each with its average beside its peak:
 * the comparison a reader makes, and narrow enough that a rate never wraps.
 * The unit sits on the label, so the figures stay bare numbers.
 */
export const TokenSpeedCards = memo(function TokenSpeedCards({
	speed,
	theme,
}: TokenSpeedCardsProps) {
	const { overall } = speed;
	const details = (...lines: (string | null)[]) => (
		<div className="text-xs mt-2 space-y-0.5" style={{ color: theme.colors.textDim }}>
			{lines.filter(Boolean).map((line) => (
				<div key={line}>{line}</div>
			))}
		</div>
	);

	if (overall.calls === 0) {
		return (
			<p
				className="text-xs"
				style={{ color: theme.colors.textDim }}
				data-testid="token-speed-empty"
			>
				No timed API calls in this range.
				{speed.measurableAgents.length > 0 &&
					` Speed is measured for ${measurableAgentsText(speed.measurableAgents)}.`}
			</p>
		);
	}

	const peakAt = peakContext(overall);
	const cards = [
		{
			icon: <ArrowUpFromLine size={16} />,
			label: 'Output',
			avg: overall.avgOutputTps,
			peak: overall.peakOutputTps,
			extra: details(
				`${formatNumber(overall.calls)} calls measured${
					speed.measuredAgents.length > 0
						? ` (${speed.measuredAgents.map(getAgentDisplayName).join(', ')})`
						: ''
				}`,
				peakAt && `peak on ${peakAt}`
			),
		},
		{
			icon: <ArrowDownToLine size={16} />,
			label: 'Input',
			avg: overall.avgInputTps,
			peak: overall.peakInputTps,
			extra: details('prompt tokens, cache reads included'),
		},
		{
			icon: <Gauge size={16} />,
			label: 'Total',
			avg: overall.avgTotalTps,
			peak: overall.peakTotalTps,
			// The fleet figure is a different measure (tokens finished in one clock
			// hour / 3,600 s, all agents together), so it is labeled as such
			// rather than sitting beside a per-model peak as if it were one.
			extra: details(
				'input + output per second of call time',
				speed.busiestHour &&
					`all agents' busiest clock hour: ${formatTokensPerSecond(speed.busiestHour.totalTps)} tok/s`
			),
		},
	];

	return (
		<div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="token-speed-cards">
			{cards.map((card, i) => (
				<MetricCard
					key={card.label}
					icon={card.icon}
					label={card.label}
					unit="tok/s"
					valueLabel="Avg"
					value={formatTokensPerSecond(card.avg)}
					secondary={{ label: 'Peak', value: formatTokensPerSecond(card.peak) }}
					theme={theme}
					animationIndex={i}
					extra={card.extra}
				/>
			))}
		</div>
	);
});

interface OverviewTokenSpeedProps {
	timeRange: StatsTimeRange;
	theme: Theme;
}

/** Remembers that the user asked for token speed on the Overview. */
export const OVERVIEW_TOKEN_SPEED_KEY = 'usageDashboard.overview.tokenSpeed.enabled';

/**
 * The Overview's speed row. Reads the same cached token payload as the Tokens
 * tab, so whichever surface loads a range first serves the other instantly.
 *
 * Lazy, like every other token surface (see `TokenSeriesContext`): the payload
 * is a parse of every agent transcript, slow the first time on a large history,
 * so opening the Overview must not start it. Until the user asks once (the
 * choice is remembered), the row shows a cached result if the Tokens tab
 * already loaded one, or a button that loads it.
 */
export const OverviewTokenSpeed = memo(function OverviewTokenSpeed({
	timeRange,
	theme,
}: OverviewTokenSpeedProps) {
	const optIn = usePersistedToggle(OVERVIEW_TOKEN_SPEED_KEY, false);
	const { data, loading, error, refresh } = useTokenUsage(timeRange, optIn.value);

	const heading = (
		<h3 className="text-sm font-semibold mb-3" style={{ color: theme.colors.textMain }}>
			Tokens per Second
			<span className="ml-2 text-xs font-normal" style={{ color: theme.colors.textDim }}>
				{TOKEN_SPEED_PEAK_NOTE}
			</span>
		</h3>
	);

	if (!data && !optIn.value) {
		return (
			<div data-testid="overview-token-speed">
				{heading}
				<div
					className="flex flex-wrap items-center gap-3 text-xs"
					style={{ color: theme.colors.textDim }}
				>
					<span>
						Token speed is read from agent transcripts, which can take a while the first time.
					</span>
					<button
						type="button"
						onClick={() => optIn.setValue(true)}
						className="px-3 py-1 rounded text-xs"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						data-testid="overview-token-speed-load"
					>
						Load token speed
					</button>
				</div>
			</div>
		);
	}

	if (loading) return <SummaryCardsSkeleton theme={theme} />;

	return (
		<div data-testid="overview-token-speed">
			{heading}
			<DashboardPanelState
				theme={theme}
				error={error}
				empty={!data}
				onRetry={() => void refresh()}
				testId="overview-token-speed"
			>
				{data && <TokenSpeedCards speed={data.speed} theme={theme} />}
			</DashboardPanelState>
		</div>
	);
});
