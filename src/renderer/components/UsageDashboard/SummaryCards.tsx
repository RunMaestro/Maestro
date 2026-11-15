/**
 * SummaryCards
 *
 * The grid of headline figures at the top of the Usage Dashboard's Overview.
 *
 * Every card answers for the SELECTED RANGE except the ones marked otherwise:
 * Agents and Open Tabs describe the app right now (caption "now"), and the
 * streak counts over all recorded history (caption "all time") so a short range
 * cannot cut it off.
 *
 * `MetricCard` here is the dashboard's single metric tile; other tabs import it.
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import {
	MessageSquare,
	Clock,
	Timer,
	Bot,
	Layers,
	Zap,
	PanelTop,
	DollarSign,
	Flame,
	Trophy,
	CalendarCheck,
	PenLine,
	Coins,
	Split,
} from 'lucide-react';
import type { Theme, Session } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import {
	formatCalendarDay,
	formatDurationHuman as formatDuration,
	formatNumber,
	formatCost,
	formatTokensCompact,
} from '../../../shared/formatters';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { aggregateRangeUsage } from '../../../shared/usageStats';
import { countTabStrip } from '../../../shared/tabStripMembership';
import { countActiveAgents } from '../../../shared/statsActiveAgents';
import { Sparkline } from '../widgets';
import { DelegationSplitBar } from './DelegationSplitBar';
import { rankProvidersByCount } from './chartUtils';
import type { DelegationTotals } from '../../../shared/delegation';
import { delegationPercent, trackedMs } from '../../../shared/delegation';

type ByDayEntry = StatsAggregation['byDay'][number];

/** The one placeholder for "no value" on this grid. */
const EMPTY_VALUE = '-';

const SPARKLINE_DAYS = 7;

/**
 * The last {@link SPARKLINE_DAYS} days of a per-day measure, oldest first.
 *
 * `byDay` is gap-filled over the range's window and ends today, so its tail IS
 * the last N calendar days, zeros included: an idle stretch at the end shows as
 * a drop instead of the line stopping at the last busy day. A range shorter
 * than the window (Today) yields fewer points, and the caller hides a
 * sparkline with fewer than two.
 */
export function lastDaysSeries(byDay: ByDayEntry[], pick: (entry: ByDayEntry) => number): number[] {
	return byDay.slice(-SPARKLINE_DAYS).map(pick);
}

/**
 * Pick the single day with the most queries. Returns null when the byDay
 * series has no activity (so callers can render the placeholder instead of a
 * zero-value card).
 */
export function findBestDay(byDay: ByDayEntry[]): { date: string; count: number } | null {
	let best: ByDayEntry | null = null;
	for (const day of byDay) {
		if (day.count > 0 && (!best || day.count > best.count)) best = day;
	}
	return best ? { date: best.date, count: best.count } : null;
}

/**
 * Count days with at least one query in the range. `byDay` is gap-filled, so
 * its length is the number of days in the range and this is "N of length".
 */
export function countActiveDays(byDay: ByDayEntry[]): number {
	let n = 0;
	for (const day of byDay) {
		if (day.count > 0) n += 1;
	}
	return n;
}

interface SummaryCardsProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Number of columns for responsive layout (default: 3 for 2 rows × 3 cols) */
	columns?: number;
	/** Sessions array for accurate agent count (filters terminal sessions) */
	sessions?: Session[];
	/**
	 * Interactive vs delegated split for the same range, merged across the
	 * stats DB and the Cue DB. Omit (or pass null) to hide the ratio card - it
	 * is the one metric here that can't be derived from `data`, since Cue runs
	 * are not query events and per-source durations are not in the aggregation.
	 */
	delegation?: DelegationTotals | null;
	/**
	 * Set when the range reaches further back than Cue keeps its run history:
	 * the ratio card's Cue share then covers only the last N days, and it says so.
	 */
	cueRetentionDays?: number | null;
	/** Enable colorblind-friendly colors in the ratio card's split bar. */
	colorBlindMode?: boolean;
}

/**
 * Visual variants for metric cards.
 *
 * - `elevated`: solid background, subtle border + shadow (default)
 * - `filled`: tinted accent background with accent border
 */
export type CardVariant = 'elevated' | 'filled';

/**
 * Compute variant-specific card styles. The accent color falls back to the
 * theme's accent when not provided so callers can tint cards independently.
 */
export function getCardStyles(
	variant: CardVariant,
	theme: Theme,
	accentColor?: string
): React.CSSProperties {
	const accent = accentColor ?? theme.colors.accent;
	const base: React.CSSProperties = {
		borderRadius: '10px',
		transition: 'all 200ms cubic-bezier(0.4, 0, 0.2, 1)',
	};

	if (variant === 'filled') {
		return {
			...base,
			backgroundColor: `${accent}26`,
			border: `1px solid ${accent}4D`,
		};
	}
	return {
		...base,
		backgroundColor: theme.colors.bgActivity,
		border: `1px solid ${theme.colors.border}`,
		borderTop: `2px solid ${accent}`,
		boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
	};
}

/**
 * Parses a metric value to determine if it can be animated as a count-up.
 * Matches pure numeric values with an optional `K` / `M` / `%` suffix
 * (the formats produced by `formatNumber` and percentage formatters).
 *
 * Returns `null` for strings like durations (`"12h 34m"`), provider names,
 * or the placeholder - these display immediately.
 */
function parseAnimatedValue(
	value: string
): { target: number; suffix: string; decimals: number } | null {
	const match = value.match(/^(\d+(?:\.\d+)?)([KM%])?$/);
	if (!match) return null;
	const numStr = match[1];
	const suffix = match[2] ?? '';
	const dotIdx = numStr.indexOf('.');
	const decimals = dotIdx >= 0 ? numStr.length - dotIdx - 1 : 0;
	return { target: parseFloat(numStr), suffix, decimals };
}

function formatProgress(current: number, decimals: number, suffix: string): string {
	return `${current.toFixed(decimals)}${suffix}`;
}

interface AnimatedNumberProps {
	/** Final value to display. Numeric strings count up; non-numeric display immediately. */
	value: string;
	/** Animation duration in ms (default: 600) */
	duration?: number;
}

/**
 * Animates a numeric `value` from 0 to its target using an ease-out cubic
 * curve. String values that don't parse as pure numbers (durations, names,
 * etc.) are rendered immediately without animation. Respects the user's
 * `prefers-reduced-motion` setting.
 */
export const AnimatedNumber = memo(function AnimatedNumber({
	value,
	duration = 600,
}: AnimatedNumberProps) {
	const parsed = useMemo(() => parseAnimatedValue(value), [value]);
	const [display, setDisplay] = useState(() =>
		parsed ? formatProgress(0, parsed.decimals, parsed.suffix) : value
	);

	useEffect(() => {
		if (!parsed) {
			setDisplay(value);
			return;
		}

		const prefersReducedMotion =
			typeof window !== 'undefined' &&
			window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		if (prefersReducedMotion) {
			setDisplay(value);
			return;
		}

		const { target, suffix, decimals } = parsed;
		setDisplay(formatProgress(0, decimals, suffix));

		let raf = 0;
		let start = 0;

		const tick = (now: number) => {
			if (start === 0) start = now;
			const progress = Math.min(1, (now - start) / duration);
			const eased = 1 - Math.pow(1 - progress, 3);
			setDisplay(formatProgress(target * eased, decimals, suffix));
			if (progress < 1) {
				raf = requestAnimationFrame(tick);
			}
		};

		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [value, parsed, duration]);

	return <>{display}</>;
});

/**
 * The dashboard's metric tile: icon, label, headline value, optional detail.
 */
export interface MetricCardProps {
	icon: React.ReactNode;
	label: string;
	value: string;
	theme: Theme;
	/**
	 * A word beside the label naming a scope other than the selected range
	 * ("now", "all time"), so a live or lifetime figure is never read as part
	 * of the range the grid around it answers for.
	 */
	labelHint?: string;
	/** Animation delay index for staggered entrance (0-based) */
	animationIndex?: number;
	/** Optional content rendered below the value (e.g. status breakdown) */
	extra?: React.ReactNode;
	/** Optional plain-text line under the value (shorthand for a dim `extra`). */
	subValue?: string;
	/** Visual variant - defaults to `'elevated'` */
	variant?: CardVariant;
	/** Optional accent color override for the `filled` variant */
	accentColor?: string;
	/** Optional 7-day trend data rendered as a mini sparkline in the corner */
	sparklineData?: number[];
	/** Sparkline stroke + fill color; defaults to the theme accent */
	sparklineColor?: string;
	/** Test id for the card root (defaults to `metric-card`). */
	testId?: string;
}

export const MetricCard = memo(function MetricCard({
	icon,
	label,
	value,
	theme,
	labelHint,
	animationIndex = 0,
	extra,
	subValue,
	variant = 'elevated',
	accentColor,
	sparklineData,
	sparklineColor,
	testId = 'metric-card',
}: MetricCardProps) {
	const [hovered, setHovered] = useState(false);

	return (
		<div
			className="relative p-4 flex items-start gap-3 card-enter"
			style={{
				...getCardStyles(variant, theme, accentColor),
				animationDelay: `${animationIndex * 80}ms`,
				transform: hovered ? 'scale(0.98)' : undefined,
				filter: hovered ? 'brightness(1.1)' : undefined,
			}}
			data-testid={testId}
			role="group"
			aria-label={`${label}${labelHint ? ` (${labelHint})` : ''}: ${value}${
				subValue ? `, ${subValue}` : ''
			}`}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<div
				className="flex-shrink-0 p-2 rounded-md"
				style={{
					backgroundColor: `${theme.colors.accent}15`,
					color: theme.colors.accent,
				}}
			>
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<div
					className="flex items-baseline gap-1.5 text-xs uppercase tracking-wide mb-1"
					style={{ color: theme.colors.textDim }}
				>
					<span>{label}</span>
					{labelHint && (
						<span
							className="text-3xs normal-case tracking-normal px-1 rounded"
							style={{ border: `1px solid ${theme.colors.border}` }}
							data-testid="metric-card-label-hint"
						>
							{labelHint}
						</span>
					)}
				</div>
				<div
					className="font-bold"
					style={{
						color: theme.colors.textMain,
						fontSize: 'clamp(18px, 3vw, 28px)',
						// A formatted figure carries no spaces, so without this a
						// value too wide for its column (`~$39,605.06` in a 176px
						// card on a phone) had nowhere to break and painted
						// straight out past the card's own edge. Wrapping rather
						// than truncating: the whole number is the point.
						overflowWrap: 'anywhere',
					}}
					title={value}
				>
					<AnimatedNumber value={value} />
				</div>
				{subValue && (
					<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						{subValue}
					</div>
				)}
				{extra}
			</div>
			{sparklineData && sparklineData.length >= 2 && (
				<div className="absolute bottom-2 right-2 opacity-60 pointer-events-none">
					<Sparkline
						data={sparklineData}
						color={sparklineColor ?? theme.colors.accent}
						width={60}
						height={20}
					/>
				</div>
			)}
		</div>
	);
});

/** A dim, uppercase detail line under a card's value. */
function DetailLine({ theme, children }: { theme: Theme; children: React.ReactNode }) {
	return (
		<div className="text-2xs mt-1 uppercase tracking-wide" style={{ color: theme.colors.textDim }}>
			{children}
		</div>
	);
}

export const SummaryCards = memo(function SummaryCards({
	data,
	theme,
	columns = 3,
	sessions,
	delegation = null,
	cueRetentionDays = null,
	colorBlindMode = false,
}: SummaryCardsProps) {
	// Agents that exist right now (terminal-only agents excluded). Without the
	// live list, fall back to the agents that ran a query in the range.
	const agentCount = useMemo(() => {
		if (sessions) {
			return sessions.filter((s) => s.toolType !== 'terminal').length;
		}
		return data.totalSessions;
	}, [sessions, data.totalSessions]);

	// Token & cost usage for the SELECTED RANGE, read from the aggregation's
	// per-session totals.
	//
	// These cards used to sum each agent's persisted `usageStats`, which is a
	// LIFETIME counter: it cannot move when the range selector does, so Tokens
	// and Cost reported the same number on a 7-day range as on a 365-day one
	// while every other card on the tab changed (issue #1399). `bySessionTokens`
	// is already scoped to the range main filtered on, so the fix is to read it.
	//
	// The model lookup is what keeps the Cost card populated: the stats DB stores
	// provider-REPORTED cost only, so agents on a provider that prices nothing
	// itself fall back to the same rate-table estimate the lifetime path used.
	const usageAgg = useMemo(() => {
		const modelBySession = new Map((sessions ?? []).map((s) => [s.id, s.customModel]));
		return aggregateRangeUsage(data.bySessionTokens, (id) => modelBySession.get(id));
	}, [data.bySessionTokens, sessions]);

	// Open tabs: every chip the tab strips draw (AI, file, browser, terminal).
	// Hidden AI tabs (consults) draw no chip. The same rules answer
	// `maestro-cli session list --type all`, so the two numbers agree (#2008).
	const openTabs = useMemo(() => {
		const byType = { ai: 0, file: 0, browser: 0, terminal: 0 };
		for (const s of sessions ?? []) {
			const counts = countTabStrip(s);
			byType.ai += counts.ai.visible;
			byType.file += counts.file.visible;
			byType.browser += counts.browser.visible;
			byType.terminal += counts.terminal.visible;
		}
		return {
			byType,
			total: byType.ai + byType.file + byType.browser + byType.terminal,
		};
	}, [sessions]);

	// Per-state agent counts for the mini status breakdown shown under the Agents card.
	// Excludes terminal sessions to match `agentCount`.
	const statusCounts = useMemo(() => {
		if (!sessions) return null;
		let busy = 0;
		let idle = 0;
		let error = 0;
		for (const s of sessions) {
			if (s.toolType === 'terminal') continue;
			if (s.state === 'busy') busy++;
			else if (s.state === 'error') error++;
			else if (s.state === 'idle') idle++;
		}
		return { busy, idle, error };
	}, [sessions]);

	// How many of the agents that exist now did something inside the selected
	// range. A different question from the status dots beside it: those are
	// live state right now, this one moves with the range picker.
	const activeAgentCount = useMemo(() => {
		if (!sessions) return null;
		return countActiveAgents(
			sessions.filter((s) => s.toolType !== 'terminal'),
			data.bySessionByDay
		);
	}, [sessions, data.bySessionByDay]);

	const openTabBreakdown = sessions ? (
		<div
			className="mt-1.5 text-2xs"
			style={{ color: theme.colors.textDim }}
			data-testid="open-tab-breakdown"
		>
			{formatNumber(openTabs.byType.ai)} AI · {formatNumber(openTabs.byType.file)} file ·{' '}
			{formatNumber(openTabs.byType.browser)} browser · {formatNumber(openTabs.byType.terminal)}{' '}
			terminal
		</div>
	) : undefined;

	const statusBreakdown = statusCounts ? (
		<div
			className="flex items-center gap-2 mt-1.5 text-2xs"
			style={{ color: theme.colors.textDim }}
			data-testid="agent-status-breakdown"
			aria-label={`${statusCounts.busy} busy, ${statusCounts.idle} idle, ${statusCounts.error} errors${
				activeAgentCount !== null ? `, ${activeAgentCount} active in range` : ''
			}`}
		>
			<span className="flex items-center gap-1" title={`${statusCounts.busy} busy`}>
				<span
					className="w-1.5 h-1.5 rounded-full"
					style={{ backgroundColor: theme.colors.warning }}
					aria-hidden="true"
				/>
				{statusCounts.busy}
			</span>
			<span className="flex items-center gap-1" title={`${statusCounts.idle} idle`}>
				<span
					className="w-1.5 h-1.5 rounded-full"
					style={{ backgroundColor: theme.colors.success }}
					aria-hidden="true"
				/>
				{statusCounts.idle}
			</span>
			<span className="flex items-center gap-1" title={`${statusCounts.error} errors`}>
				<span
					className="w-1.5 h-1.5 rounded-full"
					style={{ backgroundColor: theme.colors.error }}
					aria-hidden="true"
				/>
				{statusCounts.error}
			</span>
			{activeAgentCount !== null && (
				<>
					<span style={{ opacity: 0.4 }} aria-hidden="true">
						|
					</span>
					<span
						className="tabular-nums"
						title={`${activeAgentCount} of ${agentCount} agents ran a query in this time range`}
						data-testid="agent-active-count"
					>
						{formatNumber(activeAgentCount)} active in range
					</span>
				</>
			)}
		</div>
	) : null;

	// Top provider: the first entry of the shared provider order, the same
	// ranking (query count) Provider Comparison opens on and colors by.
	const topProvider = useMemo(() => rankProvidersByCount(data.byAgent)[0] ?? null, [data.byAgent]);

	// Queries per ACTIVE agent: `totalSessions` is the distinct agents with a
	// query in range, so the ratio moves with the range rather than with how
	// many agents happen to exist today.
	const queriesPerAgent =
		data.totalSessions > 0 ? (data.totalQueries / data.totalSessions).toFixed(1) : EMPTY_VALUE;

	const bestDay = useMemo(() => findBestDay(data.byDay), [data.byDay]);
	const activeDays = useMemo(() => countActiveDays(data.byDay), [data.byDay]);
	const queriesSparkline = useMemo(() => lastDaysSeries(data.byDay, (d) => d.count), [data.byDay]);
	const durationSparkline = useMemo(
		() => lastDaysSeries(data.byDay, (d) => d.duration),
		[data.byDay]
	);

	// The Tokens headline sums all four buckets, so the detail names all four,
	// and says how much of the range it covers when some queries carried no
	// usage (rows from before the token columns existed, providers that report
	// nothing): a partial total must not read as a complete one.
	const tokenCoverage =
		data.totalQueries > 0 && usageAgg.pricedQueries < data.totalQueries
			? `${formatNumber(usageAgg.pricedQueries)} of ${formatNumber(data.totalQueries)} queries priced`
			: null;
	const cacheTokens = usageAgg.cacheReadInputTokens + usageAgg.cacheCreationInputTokens;

	const metrics: Array<{
		icon: React.ReactNode;
		label: string;
		labelHint?: string;
		value: string;
		extra?: React.ReactNode;
		sparklineData?: number[];
	}> = [
		{
			icon: <Layers className="w-4 h-4" />,
			label: 'Agents',
			labelHint: 'now',
			value: formatNumber(agentCount),
			extra: statusBreakdown,
		},
		{
			icon: <PanelTop className="w-4 h-4" />,
			label: 'Open Tabs',
			labelHint: 'now',
			value: formatNumber(openTabs.total),
			extra: openTabBreakdown,
		},
		{
			icon: <MessageSquare className="w-4 h-4" />,
			label: 'Total Queries',
			value: formatNumber(data.totalQueries),
			sparklineData: queriesSparkline,
		},
		{
			icon: <Zap className="w-4 h-4" />,
			label: 'Queries/Agent',
			value: queriesPerAgent,
			extra:
				data.totalSessions > 0 ? (
					<DetailLine theme={theme}>
						across {formatNumber(data.totalSessions)} active{' '}
						{data.totalSessions === 1 ? 'agent' : 'agents'}
					</DetailLine>
				) : undefined,
		},
		{
			icon: <Coins className="w-4 h-4" />,
			label: 'Tokens',
			value: usageAgg.totalTokens > 0 ? formatTokensCompact(usageAgg.totalTokens) : EMPTY_VALUE,
			extra:
				usageAgg.totalTokens > 0 ? (
					<div data-testid="tokens-card-detail">
						<DetailLine theme={theme}>
							{formatTokensCompact(usageAgg.inputTokens)} in ·{' '}
							{formatTokensCompact(usageAgg.outputTokens)} out · {formatTokensCompact(cacheTokens)}{' '}
							cache
						</DetailLine>
						{tokenCoverage && <DetailLine theme={theme}>{tokenCoverage}</DetailLine>}
					</div>
				) : undefined,
		},
		{
			icon: <DollarSign className="w-4 h-4" />,
			label: usageAgg.costEstimated ? 'Est. Cost' : 'Cost',
			value:
				usageAgg.costUsd > 0
					? `${usageAgg.costEstimated ? '~' : ''}${formatCost(usageAgg.costUsd)}`
					: EMPTY_VALUE,
			extra:
				usageAgg.costUsd > 0 && tokenCoverage ? (
					<DetailLine theme={theme}>{tokenCoverage}</DetailLine>
				) : undefined,
		},
		{
			icon: <Clock className="w-4 h-4" />,
			label: 'Total Time',
			value: formatDuration(data.totalDuration),
			sparklineData: durationSparkline,
		},
		{
			icon: <Timer className="w-4 h-4" />,
			label: 'Avg Duration',
			value: data.totalQueries > 0 ? formatDuration(data.avgDuration) : EMPTY_VALUE,
		},
		{
			icon: <Bot className="w-4 h-4" />,
			label: 'Top Provider',
			value: topProvider ? getAgentDisplayName(topProvider) : EMPTY_VALUE,
			extra: topProvider ? (
				<DetailLine theme={theme}>
					{formatNumber(data.byAgent[topProvider].count)}{' '}
					{data.byAgent[topProvider].count === 1 ? 'query' : 'queries'}
				</DetailLine>
			) : undefined,
		},
		{
			icon: <Flame className="w-4 h-4" />,
			label: 'Current Streak',
			labelHint: 'all time',
			value: `${data.streak.current}d`,
			extra:
				data.streak.longest > 0 ? (
					<DetailLine theme={theme}>Best: {data.streak.longest}d</DetailLine>
				) : undefined,
		},
		{
			icon: <Trophy className="w-4 h-4" />,
			label: 'Best Day',
			value: bestDay ? formatNumber(bestDay.count) : EMPTY_VALUE,
			extra: bestDay ? (
				<DetailLine theme={theme}>{formatCalendarDay(bestDay.date)}</DetailLine>
			) : undefined,
		},
		{
			icon: <CalendarCheck className="w-4 h-4" />,
			label: 'Active Days',
			value: formatNumber(activeDays),
			extra:
				data.byDay.length > 0 ? (
					<DetailLine theme={theme}>
						of {formatNumber(data.byDay.length)} {data.byDay.length === 1 ? 'day' : 'days'}
					</DetailLine>
				) : undefined,
		},
		{
			icon: <PenLine className="w-4 h-4" />,
			label: 'Image Annotations',
			value: data.imageAnnotations > 0 ? formatNumber(data.imageAnnotations) : EMPTY_VALUE,
		},
	];

	// Interactive vs delegated, as a share of TIME rather than of turns: an
	// Auto Run batch is a few long turns while an afternoon of chat is hundreds
	// of short ones, so a turn-count ratio reports a heavily delegated range as
	// barely delegated. Hidden entirely when the split failed to load, rather
	// than shown as a confident "0 / 100".
	if (delegation && trackedMs(delegation) > 0) {
		const delegatedPct = Math.round(delegationPercent(delegation));
		metrics.push({
			icon: <Split className="w-4 h-4" />,
			label: 'Interactive vs Delegated',
			value: `${100 - delegatedPct} / ${delegatedPct}`,
			extra: (
				<div className="mt-1.5" data-testid="summary-delegation-ratio">
					<DelegationSplitBar
						totals={delegation}
						theme={theme}
						colorBlindMode={colorBlindMode}
						mergeDelegated
						height={4}
					/>
					<div className="text-2xs mt-1" style={{ color: theme.colors.textDim }}>
						{delegatedPct}% ran without you
					</div>
					{cueRetentionDays != null && (
						<div
							className="text-2xs mt-1"
							style={{ color: theme.colors.textDim }}
							data-testid="summary-cue-retention"
						>
							Cue time covers only the last {cueRetentionDays} days (Cue history retention)
						</div>
					)}
				</div>
			),
		});
	}

	return (
		<div
			className="grid gap-4"
			style={{
				gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
			}}
			data-testid="summary-cards"
			role="region"
			aria-label="Usage summary metrics"
		>
			{metrics.map((metric, index) => (
				<MetricCard
					key={metric.label}
					icon={metric.icon}
					label={metric.label}
					labelHint={metric.labelHint}
					value={metric.value}
					theme={theme}
					animationIndex={index}
					extra={metric.extra}
					sparklineData={metric.sparklineData}
				/>
			))}
		</div>
	);
});

export default SummaryCards;
