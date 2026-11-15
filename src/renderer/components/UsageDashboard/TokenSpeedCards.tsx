/**
 * TokenSpeedCards - average and peak tokens per second, split into input,
 * output, and total.
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
import { ArrowDownToLine, ArrowUpFromLine, Gauge, Zap } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange } from '../../../shared/stats-types';
import {
	TOKEN_SPEED_AGENTS,
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
	/** Grid columns at the widest breakpoint (default 6). */
	columns?: number;
}

function rate(tps: number): string {
	const text = formatTokensPerSecond(tps);
	return text === '-' ? text : `${text} tok/s`;
}

/** Where and on what the output peak happened, for the peak card's sub-line. */
function peakContext(stats: TokenSpeedStats): string | null {
	if (stats.peakOutputAtMs === undefined) return null;
	const when = format(stats.peakOutputAtMs, 'MMM d, h a');
	return stats.peakOutputModel ? `${stats.peakOutputModel} · ${when}` : when;
}

/** Sub-line for a peak card: what a peak is, in the user's terms. */
const PEAK_NOTE = `fastest model-hour (${TOKEN_SPEED_PEAK_MIN_BUCKET_MS / 60_000}+ min of calls)`;

/** "Claude Code and Codex": the providers whose transcripts time their calls. */
function measurableAgentsText(): string {
	const names = TOKEN_SPEED_AGENTS.map(getAgentDisplayName);
	return names.length <= 1
		? (names[0] ?? '')
		: `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const TokenSpeedCards = memo(function TokenSpeedCards({
	speed,
	theme,
	columns = 6,
}: TokenSpeedCardsProps) {
	const { overall } = speed;
	const dim = (text: string) => (
		<span className="text-xs" style={{ color: theme.colors.textDim }}>
			{text}
		</span>
	);

	if (overall.calls === 0) {
		return (
			<p
				className="text-xs"
				style={{ color: theme.colors.textDim }}
				data-testid="token-speed-empty"
			>
				No timed API calls in this range. Speed is measured from {measurableAgentsText()}{' '}
				transcripts.
			</p>
		);
	}

	const peakNote = peakContext(overall);
	const gridCols =
		columns >= 6 ? 'lg:grid-cols-3 xl:grid-cols-6' : columns >= 3 ? 'lg:grid-cols-3' : '';

	return (
		<div
			className={`grid grid-cols-1 sm:grid-cols-2 ${gridCols} gap-3`}
			data-testid="token-speed-cards"
		>
			<MetricCard
				icon={<ArrowUpFromLine size={16} />}
				label="Avg Output"
				value={rate(overall.avgOutputTps)}
				theme={theme}
				animationIndex={0}
				extra={dim(
					`${formatNumber(overall.calls)} calls measured${
						speed.measuredAgents.length > 0
							? ` (${speed.measuredAgents.map(getAgentDisplayName).join(', ')})`
							: ''
					}`
				)}
			/>
			<MetricCard
				icon={<ArrowDownToLine size={16} />}
				label="Avg Input"
				value={rate(overall.avgInputTps)}
				theme={theme}
				animationIndex={1}
				extra={dim('prompt tokens, cache reads included')}
			/>
			<MetricCard
				icon={<Gauge size={16} />}
				label="Avg Total"
				value={rate(overall.avgTotalTps)}
				theme={theme}
				animationIndex={2}
				extra={dim('input + output per second of call time')}
			/>
			<MetricCard
				icon={<Zap size={16} />}
				label="Peak Output"
				value={rate(overall.peakOutputTps)}
				theme={theme}
				animationIndex={3}
				extra={dim(peakNote ?? PEAK_NOTE)}
			/>
			<MetricCard
				icon={<Zap size={16} />}
				label="Peak Input"
				value={rate(overall.peakInputTps)}
				theme={theme}
				animationIndex={4}
				extra={dim(PEAK_NOTE)}
			/>
			<MetricCard
				icon={<Zap size={16} />}
				label="Peak Total"
				value={rate(overall.peakTotalTps)}
				theme={theme}
				animationIndex={5}
				// The fleet figure is a different measure (tokens finished in one clock
				// hour / 3,600 s, all agents together), so it is labeled as such
				// rather than sitting under a per-model peak as if it were one.
				extra={dim(
					speed.busiestHour
						? `${PEAK_NOTE}; all agents' busiest clock hour averaged ${rate(speed.busiestHour.totalTps)}`
						: PEAK_NOTE
				)}
			/>
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
