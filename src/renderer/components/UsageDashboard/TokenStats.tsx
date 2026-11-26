/**
 * TokenStats - the Usage Dashboard's "Tokens" tab.
 *
 * Token and cost consumption read from each agent's own on-disk transcripts
 * (see `main/stats/token-usage/`), broken down by agent, model, provider
 * account, and time.
 *
 * Things this view is careful about:
 * - **API-equivalent, not spend.** Most of these tokens run on a plan account
 *   (Claude Max, ChatGPT), which bills by subscription, so the cost is what the
 *   same tokens would cost at API rates. Only some agents report a real cost
 *   (OpenCode); everything else is priced from the `modelPricing` rate table
 *   and marked with a `~`.
 * - **Cost evidence.** Reported amounts, partial ledgers and unavailable costs
 *   remain distinct; a compatibility zero never overrides canonical
 *   missing-cost evidence.
 * - **Coverage.** An agent whose conversations are stored on another computer
 *   is counted on that computer and merged in, so every agent adds up the same
 *   way. The footer names what is still not counted (an agent whose computer
 *   could not answer, a provider with no transcript storage) and which
 *   providers report partial token data, from the aggregate's `excluded` and
 *   `coverageByAgent`.
 * - **Attribution.** A conversation's tokens land on the slice of its LAST
 *   activity (the per-session parse has no per-message timestamps to split by),
 *   and the footer says so.
 * - **Multiple provider accounts.** Users commonly run several accounts from
 *   separate provider homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
 *   `COPILOT_HOME`); the Accounts breakdown shows each one's spend rather than
 *   silently blending (or dropping) them. Its rows are keyed and labeled
 *   through `providerProfiles`, so an account reads the same here as it does in
 *   the Agents tab filter and the quota badges.
 */

import { memo, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Coins, Database, RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange } from '../../../shared/stats-types';
import type {
	TokenUsageAggregate,
	TokenUsageGroup,
	TokenUsageTotals,
} from '../../../shared/tokenUsage';
import { usageCostUsd } from '../../../shared/maestro-lib/streaming/usage-totals';
import { formatCost, formatNumber, formatTokensCompact } from '../../../shared/formatters';
import { parseProviderProfileKey } from '../../../shared/providerProfiles';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { BAR_CHART_GRID_CLASS, BAR_CHART_GRID_STYLE, BAR_CHART_ROW_STYLE } from './chartUtils';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { ChartTooltip } from '../widgets';
import { DashboardPanelState } from './DashboardPanelState';
import { MetricCard } from './SummaryCards';
import { formatTokenSlice, TokenSpeedStats } from './TokenSpeedStats';
import { useTokenUsage } from './useTokenUsage';

interface TokenStatsProps {
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

/**
 * Total tokens across all four buckets. The accessor stores input as fresh
 * tokens only for every provider (Codex included), so the four add up without
 * counting a cached token twice.
 */
function allTokens(t: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}): number {
	return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;
}

/** Canonical cost evidence takes precedence over legacy numeric projections. */
function costText(
	costUsd: number,
	estimated: boolean,
	accounting?: TokenUsageTotals['accounting']
): string {
	const cost = accounting?.cost;
	const amount = cost ? usageCostUsd(cost) : costUsd;
	const partial =
		cost?.status === 'partial' ||
		(cost?.status === 'estimated' && cost.completeness !== 'complete');
	if (amount === undefined) return partial ? 'Unknown (partial)' : 'Unknown';
	const prefix = (cost ? cost.status === 'estimated' : estimated) ? '~' : '';
	return `${prefix}${formatCost(amount)}${partial ? ' (partial)' : ''}`;
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
	/**
	 * Native-tooltip text for a row, defaulting to the group key. The account
	 * breakdown overrides it: its key carries the provider id as well, and what
	 * a truncated account label is hiding is the directory.
	 */
	rowTitle?: (group: TokenUsageGroup) => string;
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
	rowTitle,
}: BreakdownProps) {
	const [hovered, setHovered] = useState<{ group: TokenUsageGroup; x: number; y: number } | null>(
		null
	);

	const max = useMemo(
		() =>
			Math.max(
				...groups.map((g) => (g.accounting ? (usageCostUsd(g.accounting.cost) ?? 0) : g.costUsd)),
				0
			),
		[groups]
	);

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
			<div className={BAR_CHART_GRID_CLASS} style={BAR_CHART_GRID_STYLE}>
				{groups.map((g, idx) => {
					const color = colorBlindMode
						? COLORBLIND_AGENT_PALETTE[idx % COLORBLIND_AGENT_PALETTE.length]
						: theme.colors.accent;
					// Cost can legitimately be 0 (e.g. an agent with no rate data); fall
					// back to a hairline so the row still reads as present.
					// Unknown amounts have no magnitude; known zero keeps a visible hairline.
					const amount = g.accounting ? usageCostUsd(g.accounting.cost) : g.costUsd;
					const pct = amount === undefined ? 0 : max > 0 ? Math.max((amount / max) * 100, 1) : 1;
					return (
						<div
							key={g.key}
							style={BAR_CHART_ROW_STYLE}
							onMouseEnter={(e) => setHovered({ group: g, x: e.clientX, y: e.clientY })}
							onMouseMove={(e) => setHovered({ group: g, x: e.clientX, y: e.clientY })}
							onMouseLeave={() => setHovered(null)}
						>
							<span
								className="text-xs truncate min-w-0"
								style={{ color: theme.colors.textDim }}
								title={rowTitle ? rowTitle(g) : g.key}
							>
								{g.label}
							</span>
							<div
								className="h-4 rounded-sm overflow-hidden"
								style={{ backgroundColor: `${theme.colors.textDim}14` }}
							>
								<div
									className="h-full rounded-sm transition-all"
									style={{ width: `${pct}%`, backgroundColor: color }}
								/>
							</div>
							<span
								className="text-xs tabular-nums text-right"
								style={{ color: theme.colors.textMain, minWidth: '4.5rem' }}
							>
								{costText(g.costUsd, g.costEstimated, g.accounting)}
							</span>
						</div>
					);
				})}
			</div>

			{hovered && (
				<ChartTooltip anchor={{ x: hovered.x, y: hovered.y }} theme={theme}>
					<div className="font-semibold mb-1">{hovered.group.label}</div>
					<div>
						API-equivalent cost:{' '}
						{costText(hovered.group.costUsd, hovered.group.costEstimated, hovered.group.accounting)}
					</div>
					<div>Tokens: {formatNumber(allTokens(hovered.group))}</div>
					<div>
						In {formatTokensCompact(hovered.group.inputTokens)} / Out{' '}
						{formatTokensCompact(hovered.group.outputTokens)} / Cache{' '}
						{formatTokensCompact(hovered.group.cacheReadTokens + hovered.group.cacheCreationTokens)}
					</div>
					<div>Conversations: {formatNumber(hovered.group.sessionCount)}</div>
					{(hovered.group.accounting
						? hovered.group.accounting.cost.status === 'estimated'
						: hovered.group.costEstimated) && (
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

/**
 * Hover text for an account row: the account's config dir, which is the part
 * the label drops. Falls back to the label for a provider with no account
 * split, whose key is just the provider id.
 */
function accountRowTitle(group: TokenUsageGroup): string {
	return parseProviderProfileKey(group.key).accountKey ?? group.label;
}

interface TimelineProps {
	data: TokenUsageAggregate;
	theme: Theme;
	colorBlindMode: boolean;
}

/** localStorage prefix for the timeline's remembered per-series visibility. */
const SERIES_VISIBILITY_KEY = 'usageDashboard.tokens.timelineSeries';

/**
 * Stacked bars of token composition per time bucket. Stacking (rather than three
 * separate series) is deliberate: the parts sum to a meaningful whole (total
 * tokens), and the composition shift - especially how much is cache reads - is
 * the story.
 *
 * Cache reads routinely dwarf input and output by two orders of magnitude, which
 * flattens the other two into invisibility. So the legend is a set of toggles:
 * hiding a series drops it from the stack AND from the scale, which is the only
 * way to read the smaller series at all. The choice is remembered per series
 * across restarts, because it is a way of looking at the chart rather than a
 * one-off. The last visible series cannot be hidden - an empty chart tells
 * nobody anything.
 */
const Timeline = memo(function Timeline({ data, theme, colorBlindMode }: TimelineProps) {
	const [hovered, setHovered] = useState<{ idx: number; x: number; y: number } | null>(null);

	// Hooks cannot be called from a loop over the series list, so the four keys
	// are spelled out here and threaded into `series` below.
	const inputToggle = usePersistedToggle(`${SERIES_VISIBILITY_KEY}.inputTokens`, true);
	const outputToggle = usePersistedToggle(`${SERIES_VISIBILITY_KEY}.outputTokens`, true);
	const cacheToggle = usePersistedToggle(`${SERIES_VISIBILITY_KEY}.cacheReadTokens`, true);
	const cacheWriteToggle = usePersistedToggle(`${SERIES_VISIBILITY_KEY}.cacheCreationTokens`, true);

	const series = useMemo(
		() => [
			{
				key: 'inputTokens' as const,
				label: 'Input',
				color: colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : theme.colors.accent,
				toggle: inputToggle,
			},
			{
				key: 'outputTokens' as const,
				label: 'Output',
				color: colorBlindMode ? COLORBLIND_AGENT_PALETTE[1] : theme.colors.success,
				toggle: outputToggle,
			},
			{
				key: 'cacheReadTokens' as const,
				label: 'Cache read',
				color: colorBlindMode ? COLORBLIND_AGENT_PALETTE[2] : theme.colors.warning,
				toggle: cacheToggle,
			},
			{
				key: 'cacheCreationTokens' as const,
				label: 'Cache write',
				color: colorBlindMode ? COLORBLIND_AGENT_PALETTE[3] : theme.colors.textDim,
				toggle: cacheWriteToggle,
			},
		],
		[theme, colorBlindMode, inputToggle, outputToggle, cacheToggle, cacheWriteToggle]
	);

	/** The series the chart, the scale, and the tooltip all agree to show. */
	const visible = useMemo(() => series.filter((s) => s.toggle.value), [series]);

	const max = useMemo(
		() => Math.max(...data.timeline.map((b) => visible.reduce((sum, s) => sum + b[s.key], 0)), 0),
		[data.timeline, visible]
	);

	if (data.timeline.length === 0) return null;

	const granularity = data.granularity;
	const first = data.timeline[0];
	const last = data.timeline[data.timeline.length - 1];
	const hoveredBucket = hovered ? data.timeline[hovered.idx] : undefined;

	return (
		<div data-testid="token-timeline">
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					Token Consumption Over Time
					<span className="ml-2 font-normal text-xs" style={{ color: theme.colors.textDim }}>
						per {granularity}
					</span>
				</h3>
				{/*
				  Legend: identity is never carried by color alone, and each entry is
				  also the control that shows or hides its series. A hidden series keeps
				  its swatch as an outline so the color mapping survives being off.
				*/}
				<div className="flex flex-wrap items-center gap-1">
					{series.map((s) => {
						const on = s.toggle.value;
						const isLastVisible = on && visible.length === 1;
						return (
							<button
								key={s.key}
								type="button"
								onClick={() => s.toggle.toggle()}
								disabled={isLastVisible}
								aria-pressed={on}
								title={
									isLastVisible
										? 'At least one series has to stay visible'
										: on
											? `Hide ${s.label}`
											: `Show ${s.label}`
								}
								data-testid={`token-timeline-legend-${s.key}`}
								className="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-opacity hover:opacity-100"
								style={{
									opacity: on ? 1 : 0.45,
									cursor: isLastVisible ? 'default' : 'pointer',
								}}
							>
								<span
									className="inline-block w-2.5 h-2.5 rounded-sm"
									style={{
										backgroundColor: on ? s.color : 'transparent',
										boxShadow: `inset 0 0 0 1px ${s.color}`,
									}}
								/>
								<span
									className="text-xs"
									style={{
										color: theme.colors.textDim,
										textDecoration: on ? undefined : 'line-through',
									}}
								>
									{s.label}
								</span>
							</button>
						);
					})}
				</div>
			</div>

			<div className="flex items-end gap-px h-40">
				{data.timeline.map((bucket, idx) => {
					const total = visible.reduce((sum, s) => sum + bucket[s.key], 0);
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
								{visible.map((s) => {
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
				<span className="text-2xs" style={{ color: theme.colors.textDim }}>
					{formatTokenSlice(first.startMs, granularity, { span: true })}
				</span>
				<span className="text-2xs" style={{ color: theme.colors.textDim }}>
					{formatTokenSlice(last.startMs, granularity, { span: true })}
				</span>
			</div>

			{hovered && hoveredBucket && (
				<ChartTooltip anchor={{ x: hovered.x, y: hovered.y }} theme={theme}>
					<div className="font-semibold mb-1">
						{formatTokenSlice(hoveredBucket.startMs, granularity, { span: true })}
					</div>
					{visible.map((s) => (
						<div key={s.key}>
							{s.label}: {formatNumber(hoveredBucket[s.key])}
						</div>
					))}
					<div>
						API-equivalent cost:{' '}
						{costText(hoveredBucket.costUsd, hoveredBucket.costEstimated, hoveredBucket.accounting)}
					</div>
					<div>Conversations: {formatNumber(hoveredBucket.sessionCount)}</div>
				</ChartTooltip>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

/**
 * The footer's coverage sentences: what the totals leave out and where the
 * data is partial, read from the aggregate rather than hard-coded so a new
 * provider (or a user whose agents all run here) gets an accurate line. The
 * line names agents and where their transcripts are, never the agent's mode: a
 * remote and a hosted agent read the same.
 */
export function tokenCoverageNotes(data: TokenUsageAggregate): string[] {
	const notes: string[] = [];
	const partial = Object.entries(data.coverageByAgent)
		.filter(([, coverage]) => coverage === 'partial')
		.map(([agent]) => getAgentDisplayName(agent));
	if (partial.length > 0) {
		notes.push(
			`Partial token data for ${partial.join(', ')} (no cache-write split, or tokens only once a conversation ends).`
		);
	}
	const skipped: string[] = [];
	// Agents on another computer are counted there; only the ones that computer
	// could not answer for are named, and removed agents whose computer nothing
	// here can reach are counted as one group.
	const unread = [...(data.excluded.notCountedAgents ?? [])];
	const removed = data.excluded.remoteProjects;
	if (removed > 0) unread.push(removed === 1 ? '1 removed agent' : `${removed} removed agents`);
	if (unread.length > 0) {
		skipped.push(`${unread.join(', ')} (conversations on another computer that could not be read)`);
	}
	if (data.excluded.unsupportedAgents.length > 0) {
		skipped.push(
			`${data.excluded.unsupportedAgents.map(getAgentDisplayName).join(', ')} (no transcripts to read)`
		);
	}
	if (skipped.length > 0) {
		notes.push(`Not counted: ${skipped.join('; ')}.`);
	}
	return notes;
}

export const TokenStats = memo(function TokenStats({
	timeRange,
	theme,
	colorBlindMode = false,
}: TokenStatsProps) {
	// Served from the shared cache, so a reopened dashboard shows the last
	// result at once and refreshes it in place. Not a `useDashboardResource`:
	// this reads agent transcripts (an expensive parse), not stats tables, so it
	// refreshes on demand rather than on every recorded query.
	const { data, loading, refreshing, error, forceRefresh } = useTokenUsage(timeRange);

	const cacheHitRate = useMemo(() => {
		if (!data) return 0;
		// Share of all input-side tokens served from cache: the lever that most
		// affects spend, and the reason cache reads are surfaced at all.
		const inputSide =
			data.totals.inputTokens + data.totals.cacheReadTokens + data.totals.cacheCreationTokens;
		return inputSide > 0 ? (data.totals.cacheReadTokens / inputSide) * 100 : 0;
	}, [data]);

	const empty = !data || data.totals.sessionCount === 0;
	if (loading || empty) {
		return (
			<DashboardPanelState
				theme={theme}
				loading={loading}
				error={error}
				empty={empty}
				emptyMessage="No token usage in this range. Run an agent and its token consumption shows up here."
				loadingMessage="Reading agent transcripts..."
				onRetry={() => void forceRefresh()}
				testId="token-stats"
			/>
		);
	}

	const { totals } = data;
	const accentColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : theme.colors.accent;
	const coverageNotes = tokenCoverageNotes(data);

	return (
		<DashboardPanelState
			theme={theme}
			error={error}
			onRetry={() => void forceRefresh()}
			testId="token-stats"
		>
			<div className="flex flex-col gap-6" data-testid="token-stats">
				{/* Hero tiles: the four numbers worth reading first. One column below
				    `sm`, because two of these on a phone leave each tile ~90px of
				    text and a cost like `~$39,641.83` has to break mid-number to
				    fit. The desktop app's viewport is never below `sm`, so this
				    rung only ever fires in the browser. */}
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
					<MetricCard
						icon={<Coins size={16} />}
						label="API-equivalent Cost"
						value={costText(totals.costUsd, totals.costEstimated, totals.accounting)}
						theme={theme}
						animationIndex={0}
						variant="filled"
						accentColor={accentColor}
						extra={
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								at API rates; plan accounts are billed by subscription
							</span>
						}
					/>
					<MetricCard
						icon={<ArrowDownToLine size={16} />}
						label="Input Tokens"
						value={formatTokensCompact(totals.inputTokens)}
						theme={theme}
						animationIndex={1}
						extra={
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								fresh input, cache excluded
							</span>
						}
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

				<TokenSpeedStats speed={data.speed} theme={theme} colorBlindMode={colorBlindMode} />

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

					<ChartErrorBoundary theme={theme} chartName="Tokens by Account">
						<Breakdown
							title="By Account"
							groups={data.byAccount}
							theme={theme}
							colorBlindMode={colorBlindMode}
							emptyNote="No provider accounts detected."
							testId="token-by-account"
							rowTitle={accountRowTitle}
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

				{/* Provenance footer: what the numbers mean, what they leave out,
				    and how fresh they are. */}
				<div
					className="flex flex-wrap items-start justify-between gap-2 pt-2 text-xs-plus"
					style={{ color: theme.colors.textDim, borderTop: `1px solid ${theme.colors.border}` }}
				>
					<div className="flex flex-col gap-0.5 min-w-0 flex-1" data-testid="token-stats-coverage">
						<span>
							{formatNumber(totals.sessionCount)} conversations read from agent transcripts. Each
							conversation&apos;s tokens count toward the {data.granularity} of its last activity.
						</span>
						{totals.costEstimated && (
							<span>Costs marked ~ are estimated from published model rates.</span>
						)}
						{totals.accounting && (
							<span>Unknown costs are unavailable; partial amounts include only known spend.</span>
						)}
						{coverageNotes.map((note) => (
							<span key={note}>{note}</span>
						))}
					</div>
					<button
						type="button"
						onClick={() => void forceRefresh()}
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
		</DashboardPanelState>
	);
});
