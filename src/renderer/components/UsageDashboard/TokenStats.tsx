/**
 * TokenStats - the Usage Dashboard's "Tokens" tab.
 *
 * Token and cost consumption read from each agent's own on-disk transcripts
 * (see `main/stats/token-usage/`), broken down by agent, model, provider
 * account, and time.
 *
 * Two things this view is careful about:
 * - **Estimated vs reported cost.** Only some agents report a real cost
 *   (OpenCode). Everything else is priced from the `modelPricing` rate table.
 *   Estimated figures are marked with a `~` and explained in the footnote, so a
 *   number is never presented as authoritative when it isn't.
 * - **Multiple provider accounts.** Users commonly run several Claude Max
 *   accounts from separate `CLAUDE_CONFIG_DIR` homes; the Accounts breakdown
 *   shows each one's spend rather than silently blending (or dropping) them.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Coins, Database, RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange } from '../../../shared/stats-types';
import type {
	TokenUsageAggregate,
	TokenUsageGroup,
	TokenUsageQuery,
} from '../../../shared/tokenUsage';
import { formatCost, formatNumber, formatTokensCompact } from '../../../shared/formatters';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';
import { captureException } from '../../utils/sentry';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { ChartTooltip } from './ChartTooltip';
import { EmptyState } from './EmptyState';
import { SummaryCardsSkeleton } from './ChartSkeletons';
import { MetricCard } from './SummaryCards';

interface TokenStatsProps {
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

/** Lookback for each dashboard range, mirroring `getTimeRangeStart` in main. */
const RANGE_DAYS: Record<Exclude<StatsTimeRange, 'all'>, number> = {
	day: 1,
	week: 7,
	month: 30,
	quarter: 90,
	year: 365,
};

/** Translate the dashboard's range selector into the accessor's query window. */
function toQuery(range: StatsTimeRange): TokenUsageQuery {
	if (range === 'all') return { granularity: 'month' };
	const days = RANGE_DAYS[range];
	const granularity = days <= 30 ? 'day' : days <= 90 ? 'week' : 'month';
	return { sinceMs: Date.now() - days * 24 * 60 * 60 * 1000, granularity };
}

/** Total tokens across all four buckets. */
function allTokens(t: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}): number {
	return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;
}

/** Cost string, prefixed with `~` when any part of it was rate-table estimated. */
function costText(costUsd: number, estimated: boolean): string {
	return `${estimated ? '~' : ''}${formatCost(costUsd)}`;
}

// ---------------------------------------------------------------------------
// Horizontal breakdown bars (identity comparison - magnitude by category)
// ---------------------------------------------------------------------------

interface BreakdownProps {
	title: string;
	groups: TokenUsageGroup[];
	theme: Theme;
	colorBlindMode: boolean;
	/** Copy shown when this dimension has nothing to report. */
	emptyNote: string;
	testId: string;
}

/**
 * Ranked horizontal bars, sized by cost (the thing users actually care about)
 * with the token count carried as a direct label. Bars are sorted by the
 * accessor, so color follows rank position only within this one chart, never
 * across charts.
 */
const Breakdown = memo(function Breakdown({
	title,
	groups,
	theme,
	colorBlindMode,
	emptyNote,
	testId,
}: BreakdownProps) {
	const [hovered, setHovered] = useState<{ group: TokenUsageGroup; x: number; y: number } | null>(
		null
	);

	const max = useMemo(() => Math.max(...groups.map((g) => g.costUsd), 0), [groups]);

	if (groups.length === 0) {
		return (
			<div data-testid={testId}>
				<h3 className="text-sm font-semibold mb-3" style={{ color: theme.colors.textMain }}>
					{title}
				</h3>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					{emptyNote}
				</p>
			</div>
		);
	}

	return (
		<div data-testid={testId}>
			<h3 className="text-sm font-semibold mb-3" style={{ color: theme.colors.textMain }}>
				{title}
			</h3>
			<div className="flex flex-col gap-2">
				{groups.map((g, idx) => {
					const color = colorBlindMode
						? COLORBLIND_AGENT_PALETTE[idx % COLORBLIND_AGENT_PALETTE.length]
						: theme.colors.accent;
					// Cost can legitimately be 0 (e.g. an agent with no rate data); fall
					// back to a hairline so the row still reads as present.
					const pct = max > 0 ? Math.max((g.costUsd / max) * 100, 1) : 1;
					return (
						<div
							key={g.key}
							className="flex items-center gap-3"
							onMouseEnter={(e) => setHovered({ group: g, x: e.clientX, y: e.clientY })}
							onMouseMove={(e) => setHovered({ group: g, x: e.clientX, y: e.clientY })}
							onMouseLeave={() => setHovered(null)}
						>
							<span
								className="text-xs truncate shrink-0"
								style={{ color: theme.colors.textDim, width: '38%' }}
								title={g.key}
							>
								{g.label}
							</span>
							<div
								className="flex-1 h-4 rounded-sm overflow-hidden"
								style={{ backgroundColor: `${theme.colors.textDim}14` }}
							>
								<div
									className="h-full rounded-sm transition-all"
									style={{ width: `${pct}%`, backgroundColor: color }}
								/>
							</div>
							<span
								className="text-xs tabular-nums shrink-0 text-right"
								style={{ color: theme.colors.textMain, width: '4.5rem' }}
							>
								{costText(g.costUsd, g.costEstimated)}
							</span>
						</div>
					);
				})}
			</div>

			{hovered && (
				<ChartTooltip anchor={{ x: hovered.x, y: hovered.y }} theme={theme}>
					<div className="font-semibold mb-1">{hovered.group.label}</div>
					<div>Cost: {costText(hovered.group.costUsd, hovered.group.costEstimated)}</div>
					<div>Tokens: {formatNumber(allTokens(hovered.group))}</div>
					<div>
						In {formatTokensCompact(hovered.group.inputTokens)} / Out{' '}
						{formatTokensCompact(hovered.group.outputTokens)}
					</div>
					<div>Sessions: {formatNumber(hovered.group.sessionCount)}</div>
					{hovered.group.costEstimated && (
						<div style={{ color: theme.colors.textDim }}>~ cost estimated from rates</div>
					)}
				</ChartTooltip>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// Timeline (change over time - stacked input/output/cache per bucket)
// ---------------------------------------------------------------------------

interface TimelineProps {
	data: TokenUsageAggregate;
	theme: Theme;
	colorBlindMode: boolean;
}

/**
 * Stacked bars of token composition per time bucket. Stacking (rather than three
 * separate series) is deliberate: the parts sum to a meaningful whole (total
 * tokens), and the composition shift - especially how much is cache reads - is
 * the story.
 */
const Timeline = memo(function Timeline({ data, theme, colorBlindMode }: TimelineProps) {
	const [hovered, setHovered] = useState<{ idx: number; x: number; y: number } | null>(null);

	const series = useMemo(
		() => [
			{
				key: 'inputTokens' as const,
				label: 'Input',
				color: colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : theme.colors.accent,
			},
			{
				key: 'outputTokens' as const,
				label: 'Output',
				color: colorBlindMode ? COLORBLIND_AGENT_PALETTE[1] : theme.colors.success,
			},
			{
				key: 'cacheReadTokens' as const,
				label: 'Cache read',
				color: colorBlindMode ? COLORBLIND_AGENT_PALETTE[2] : theme.colors.warning,
			},
		],
		[theme, colorBlindMode]
	);

	const max = useMemo(
		() =>
			Math.max(...data.timeline.map((b) => b.inputTokens + b.outputTokens + b.cacheReadTokens), 0),
		[data.timeline]
	);

	if (data.timeline.length === 0) return null;

	return (
		<div data-testid="token-timeline">
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					Token Consumption Over Time
				</h3>
				{/* Legend: identity is never carried by color alone. */}
				<div className="flex items-center gap-3">
					{series.map((s) => (
						<span key={s.key} className="flex items-center gap-1.5">
							<span
								className="inline-block w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: s.color }}
							/>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{s.label}
							</span>
						</span>
					))}
				</div>
			</div>

			<div className="flex items-end gap-1 h-40">
				{data.timeline.map((bucket, idx) => {
					const total = bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens;
					const heightPct = max > 0 ? (total / max) * 100 : 0;
					return (
						<div
							key={bucket.startMs}
							className="flex-1 flex flex-col justify-end h-full min-w-0"
							onMouseEnter={(e) => setHovered({ idx, x: e.clientX, y: e.clientY })}
							onMouseMove={(e) => setHovered({ idx, x: e.clientX, y: e.clientY })}
							onMouseLeave={() => setHovered(null)}
						>
							<div
								className="w-full flex flex-col justify-end rounded-t-sm overflow-hidden transition-opacity"
								style={{
									height: `${heightPct}%`,
									opacity: hovered && hovered.idx !== idx ? 0.55 : 1,
								}}
							>
								{/* Rendered top-down so the visual stack reads Input → Output → Cache. */}
								{series.map((s) => {
									const value = bucket[s.key];
									const segPct = total > 0 ? (value / total) * 100 : 0;
									if (segPct === 0) return null;
									return (
										<div key={s.key} style={{ height: `${segPct}%`, backgroundColor: s.color }} />
									);
								})}
							</div>
						</div>
					);
				})}
			</div>

			<div className="flex justify-between mt-2">
				<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
					{new Date(data.timeline[0].startMs).toLocaleDateString()}
				</span>
				<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
					{new Date(data.timeline[data.timeline.length - 1].startMs).toLocaleDateString()}
				</span>
			</div>

			{hovered && data.timeline[hovered.idx] && (
				<ChartTooltip anchor={{ x: hovered.x, y: hovered.y }} theme={theme}>
					<div className="font-semibold mb-1">
						{new Date(data.timeline[hovered.idx].startMs).toLocaleDateString()}
					</div>
					{series.map((s) => (
						<div key={s.key}>
							{s.label}: {formatNumber(data.timeline[hovered.idx][s.key])}
						</div>
					))}
					<div>
						Cost:{' '}
						{costText(data.timeline[hovered.idx].costUsd, data.timeline[hovered.idx].costEstimated)}
					</div>
					<div>Sessions: {formatNumber(data.timeline[hovered.idx].sessionCount)}</div>
				</ChartTooltip>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export const TokenStats = memo(function TokenStats({
	timeRange,
	theme,
	colorBlindMode = false,
}: TokenStatsProps) {
	const [data, setData] = useState<TokenUsageAggregate | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		async (force: boolean) => {
			try {
				if (force) setRefreshing(true);
				const result = await window.maestro.stats.getTokenUsage(toQuery(timeRange), force);
				setData(result);
				setError(null);
			} catch (err) {
				captureException(err);
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
				setRefreshing(false);
			}
		},
		[timeRange]
	);

	useEffect(() => {
		setLoading(true);
		void load(false);
	}, [load]);

	const cacheHitRate = useMemo(() => {
		if (!data) return 0;
		// Share of all input-side tokens served from cache: the lever that most
		// affects spend, and the reason cache reads are surfaced at all.
		const inputSide =
			data.totals.inputTokens + data.totals.cacheReadTokens + data.totals.cacheCreationTokens;
		return inputSide > 0 ? (data.totals.cacheReadTokens / inputSide) * 100 : 0;
	}, [data]);

	if (loading) {
		return <SummaryCardsSkeleton theme={theme} />;
	}

	if (error) {
		return <EmptyState theme={theme} title="Couldn't read token usage" message={error} />;
	}

	if (!data || data.totals.sessionCount === 0) {
		return (
			<EmptyState
				theme={theme}
				title="No token usage yet"
				message="Run an agent and its token consumption will show up here."
			/>
		);
	}

	const { totals } = data;
	const accentColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : theme.colors.accent;

	return (
		<div className="flex flex-col gap-6" data-testid="token-stats">
			{/* Hero tiles: the four numbers worth reading first. */}
			<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
				<MetricCard
					icon={<Coins size={16} />}
					label="Total Cost"
					value={costText(totals.costUsd, totals.costEstimated)}
					theme={theme}
					animationIndex={0}
					variant="filled"
					accentColor={accentColor}
				/>
				<MetricCard
					icon={<ArrowDownToLine size={16} />}
					label="Input Tokens"
					value={formatTokensCompact(totals.inputTokens)}
					theme={theme}
					animationIndex={1}
				/>
				<MetricCard
					icon={<ArrowUpFromLine size={16} />}
					label="Output Tokens"
					value={formatTokensCompact(totals.outputTokens)}
					theme={theme}
					animationIndex={2}
				/>
				<MetricCard
					icon={<Database size={16} />}
					label="Cache Reads"
					value={formatTokensCompact(totals.cacheReadTokens)}
					theme={theme}
					animationIndex={3}
					extra={
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{cacheHitRate.toFixed(0)}% of input served from cache
						</span>
					}
				/>
			</div>

			<ChartErrorBoundary theme={theme} chartName="Token Timeline">
				<Timeline data={data} theme={theme} colorBlindMode={colorBlindMode} />
			</ChartErrorBoundary>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<ChartErrorBoundary theme={theme} chartName="Tokens by Agent">
					<Breakdown
						title="By Agent"
						groups={data.byAgent}
						theme={theme}
						colorBlindMode={colorBlindMode}
						emptyNote="No agent usage in this range."
						testId="token-by-agent"
					/>
				</ChartErrorBoundary>

				<ChartErrorBoundary theme={theme} chartName="Tokens by Model">
					<Breakdown
						title="By Model"
						groups={data.byModel}
						theme={theme}
						colorBlindMode={colorBlindMode}
						emptyNote="No model data in this range."
						testId="token-by-model"
					/>
				</ChartErrorBoundary>

				<ChartErrorBoundary theme={theme} chartName="Tokens by Account">
					<Breakdown
						title="By Account"
						groups={data.byAccount}
						theme={theme}
						colorBlindMode={colorBlindMode}
						emptyNote="No provider accounts detected."
						testId="token-by-account"
					/>
				</ChartErrorBoundary>

				<ChartErrorBoundary theme={theme} chartName="Tokens by Project">
					<Breakdown
						title="By Project"
						groups={data.byProject}
						theme={theme}
						colorBlindMode={colorBlindMode}
						emptyNote="No projects in this range."
						testId="token-by-project"
					/>
				</ChartErrorBoundary>
			</div>

			{/* Provenance footer: what the numbers mean and how fresh they are. */}
			<div
				className="flex items-center justify-between pt-2 text-[11px]"
				style={{ color: theme.colors.textDim, borderTop: `1px solid ${theme.colors.border}` }}
			>
				<span>
					{formatNumber(totals.sessionCount)} sessions read from agent transcripts.
					{totals.costEstimated && ' Costs marked ~ are estimated from model rates.'}
				</span>
				<button
					type="button"
					onClick={() => void load(true)}
					disabled={refreshing}
					className="flex items-center gap-1.5 px-2 py-1 rounded transition-opacity hover:opacity-80 disabled:opacity-50"
					style={{ color: theme.colors.textDim }}
					data-testid="token-stats-refresh"
				>
					<RefreshCw size={12} className={refreshing ? 'animate-spin' : undefined} />
					{refreshing ? 'Refreshing' : 'Refresh'}
				</button>
			</div>
		</div>
	);
});
