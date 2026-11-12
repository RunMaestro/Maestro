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
	TOKEN_SPEED_PEAK_MIN_BUCKET_MS,
	type TokenSpeedStats,
	type TokenSpeedSummary,
} from '../../../shared/tokenSpeed';
import { formatNumber, formatTokensPerSecond } from '../../../shared/formatters';
import { MetricCard } from './SummaryCards';
import { SummaryCardsSkeleton } from './ChartSkeletons';
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
				No timed API calls in this range. Speed is measured from Claude Code and Codex transcripts.
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
				extra={dim(`${formatNumber(overall.calls)} calls measured`)}
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
				extra={dim(
					speed.busiestHour
						? `busiest hour: ${rate(speed.busiestHour.totalTps)} across all agents`
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

/**
 * The Overview's speed row. Reads the same cached token payload as the Tokens
 * tab, so whichever surface loads a range first serves the other instantly.
 */
export const OverviewTokenSpeed = memo(function OverviewTokenSpeed({
	timeRange,
	theme,
}: OverviewTokenSpeedProps) {
	const { data, loading, error } = useTokenUsage(timeRange);

	if (loading) return <SummaryCardsSkeleton theme={theme} />;
	if (!data?.speed) {
		return error ? (
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				Couldn't read token speed: {error}
			</p>
		) : null;
	}

	return (
		<div data-testid="overview-token-speed">
			<h3 className="text-sm font-semibold mb-3" style={{ color: theme.colors.textMain }}>
				Tokens per Second
			</h3>
			<TokenSpeedCards speed={data.speed} theme={theme} />
		</div>
	);
});
