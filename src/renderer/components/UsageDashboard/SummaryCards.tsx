/**
 * SummaryCards
 *
 * Displays key metrics in card format at the top of the Usage Dashboard.
 *
 * Metrics displayed:
 * - Total queries
 * - Total time (formatted: "12h 34m")
 * - Average duration
 * - Most active agent
 * - Interactive vs Auto ratio
 *
 * Features:
 * - Theme-aware styling with inline styles
 * - Subtle icons for each metric
 * - Responsive horizontal card layout
 * - Formatted values for readability
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import {
	MessageSquare,
	Clock,
	Timer,
	Bot,
	Layers,
	Sunrise,
	Zap,
	PanelTop,
	Cpu,
	DollarSign,
	Activity,
	Flame,
	Trophy,
	CalendarCheck,
	GitBranch,
} from 'lucide-react';
import type { Theme, Session } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import {
	formatDurationHuman as formatDuration,
	formatNumber,
	formatCost,
} from '../../../shared/formatters';
import { Sparkline } from './Sparkline';

type ByDayEntry = StatsAggregation['byDay'][number];

const SPARKLINE_DAYS = 7;

/**
 * Build a fixed last-7-days window indexing the byDay series by its YYYY-MM-DD
 * date string and falling back to zero for absent days. This keeps the
 * sparkline geometrically faithful — sparse byDay rows would otherwise compress
 * gaps and overstate momentum.
 *
 * The window ends on the latest date present in byDay (or today if byDay is
 * empty) so the helper still works on historical / unit-test fixtures that
 * don't contain today's row.
 */
function buildLast7DaysWindow(byDay: ByDayEntry[], pick: (entry: ByDayEntry) => number): number[] {
	const ymd = (d: Date) =>
		`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	const parseYmd = (s: string): Date | null => {
		const parts = s.split('-').map(Number);
		if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
		return new Date(parts[0], parts[1] - 1, parts[2]);
	};

	const lookup = new Map<string, number>();
	let latest: Date | null = null;
	for (const entry of byDay) {
		lookup.set(entry.date, pick(entry));
		const d = parseYmd(entry.date);
		if (d && (!latest || d > latest)) latest = d;
	}

	const cursor = latest ?? new Date();
	cursor.setHours(0, 0, 0, 0);

	const values: number[] = [];
	for (let i = SPARKLINE_DAYS - 1; i >= 0; i--) {
		const day = new Date(cursor);
		day.setDate(cursor.getDate() - i);
		values.push(lookup.get(ymd(day)) ?? 0);
	}
	return values;
}

/**
 * Returns the last 7 days of query counts oldest → newest. Days with no
 * activity are zero-filled rather than skipped so the sparkline shape matches
 * calendar reality.
 */
export function getLast7Days(byDay: ByDayEntry[]): number[] {
	return buildLast7DaysWindow(byDay, (d) => d.count);
}

/**
 * Walk a `byDay` series newest → oldest and return both:
 *   - `current`: consecutive days *up to and including today* with non-zero
 *     activity. Today missing? Streak is 0 (we don't pad — a streak that
 *     hasn't been touched today is broken, period).
 *   - `max`: longest run of consecutive non-zero days anywhere in the series.
 *
 * Operates on the `byDay` rows the aggregation already produces; gaps in the
 * array are treated as zeros (the series isn't always dense for short ranges).
 */
export function computeStreaks(byDay: ByDayEntry[]): { current: number; max: number } {
	if (byDay.length === 0) return { current: 0, max: 0 };

	// Build a Set of YYYY-MM-DD strings with non-zero counts so we can probe
	// arbitrary days without index gymnastics.
	const activeDays = new Set<string>();
	for (const day of byDay) {
		if (day.count > 0) activeDays.add(day.date);
	}
	if (activeDays.size === 0) return { current: 0, max: 0 };

	// Local YYYY-MM-DD formatter — matches what the aggregation emits and
	// avoids the UTC-shift trap of `.toISOString().slice(0,10)`.
	const ymd = (d: Date) =>
		`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

	let current = 0;
	const cursor = new Date();
	while (activeDays.has(ymd(cursor))) {
		current += 1;
		cursor.setDate(cursor.getDate() - 1);
	}

	// Sort the active days ascending and walk for the max-run computation.
	const sortedDates = [...activeDays].sort();
	let max = 0;
	let run = 0;
	let prev: Date | null = null;
	for (const dateStr of sortedDates) {
		const [y, m, d] = dateStr.split('-').map(Number);
		const date = new Date(y, m - 1, d);
		if (prev) {
			const dayDiff = Math.round((date.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000));
			run = dayDiff === 1 ? run + 1 : 1;
		} else {
			run = 1;
		}
		if (run > max) max = run;
		prev = date;
	}

	return { current, max };
}

/**
 * Pick the single day with the most queries. Returns null when the byDay
 * series has no activity (so callers can render an "N/A" affordance instead
 * of a zero-value card).
 */
export function findBestDay(byDay: ByDayEntry[]): { date: string; count: number } | null {
	let best: ByDayEntry | null = null;
	for (const day of byDay) {
		if (day.count > 0 && (!best || day.count > best.count)) best = day;
	}
	return best ? { date: best.date, count: best.count } : null;
}

/**
 * Count days with at least one query inside the byDay series. This is the
 * "active days in range" stat — different from the streak because gaps are
 * allowed.
 */
export function countActiveDays(byDay: ByDayEntry[]): number {
	let n = 0;
	for (const day of byDay) {
		if (day.count > 0) n += 1;
	}
	return n;
}

/**
 * Format a YYYY-MM-DD date string as a short "Mon DD" label (e.g. "Apr 17")
 * without going through a full `Date` lookup chain at every render. The
 * input format is what `byDay` produces; bail to the original string if
 * parsing fails so we never render a literal `Invalid Date`.
 */
export function formatShortDate(dateStr: string): string {
	const parts = dateStr.split('-').map(Number);
	if (parts.length !== 3 || parts.some(Number.isNaN)) return dateStr;
	const [y, m, d] = parts;
	const date = new Date(y, m - 1, d);
	return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Same as {@link getLast7Days} but pulls each day's total `duration`
 * (in ms) instead of the query count. Densified the same way.
 */
export function getLast7DaysDuration(byDay: ByDayEntry[]): number[] {
	return buildLast7DaysWindow(byDay, (d) => d.duration);
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
}

/**
 * Visual variants for metric cards.
 *
 * - `elevated`: solid background, subtle border + shadow (default)
 * - `outlined`: transparent background, accent-colored border
 * - `filled`: tinted accent background with accent border
 * - `ghost`: transparent background, no border
 */
export type CardVariant = 'elevated' | 'outlined' | 'filled' | 'ghost';

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

	switch (variant) {
		case 'elevated':
			return {
				...base,
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
				borderTop: `2px solid ${accent}`,
				boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
			};
		case 'outlined':
			return {
				...base,
				backgroundColor: 'transparent',
				border: `1px solid ${accent}66`,
			};
		case 'filled':
			return {
				...base,
				backgroundColor: `${accent}26`,
				border: `1px solid ${accent}4D`,
			};
		case 'ghost':
			return {
				...base,
				backgroundColor: 'transparent',
				border: 'none',
			};
	}
}

/**
 * Parses a metric value to determine if it can be animated as a count-up.
 * Matches pure numeric values with an optional `K` / `M` / `%` suffix
 * (the formats produced by `formatNumber` and percentage formatters).
 *
 * Returns `null` for strings like durations (`"12h 34m"`), peak hour
 * (`"9 AM"`), agent names, or `"N/A"` — these display immediately.
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
 * curve. String values that don't parse as pure numbers (durations, agent
 * names, etc.) are rendered immediately without animation. Respects the
 * user's `prefers-reduced-motion` setting.
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

interface BouncingDotsProps {
	/** Color for the dots — defaults to `currentColor` so callers can tint via CSS */
	color?: string;
	/** Optional ARIA label; defaults to `"Loading"` for screen readers */
	label?: string;
}

/**
 * Three dots that bounce in sequence for loading / thinking states.
 *
 * Animation, sizing, and stagger delays live in `index.css` under the
 * `.bounce-dots` selector and respect `prefers-reduced-motion`.
 */
export const BouncingDots = memo(function BouncingDots({
	color,
	label = 'Loading',
}: BouncingDotsProps) {
	const style: React.CSSProperties | undefined = color ? { color } : undefined;
	return (
		<span
			className="bounce-dots"
			style={style}
			role="status"
			aria-label={label}
			data-testid="bouncing-dots"
		>
			<span aria-hidden="true" />
			<span aria-hidden="true" />
			<span aria-hidden="true" />
		</span>
	);
});

/**
 * Single metric card component
 */
interface MetricCardProps {
	icon: React.ReactNode;
	label: string;
	value: string;
	theme: Theme;
	/** Animation delay index for staggered entrance (0-based) */
	animationIndex?: number;
	/** Optional content rendered below the value (e.g. status breakdown) */
	extra?: React.ReactNode;
	/** Visual variant — defaults to `'elevated'` */
	variant?: CardVariant;
	/** Optional accent color override for `outlined` / `filled` variants */
	accentColor?: string;
	/** Optional 7-day trend data rendered as a mini sparkline in the corner */
	sparklineData?: number[];
	/** Sparkline stroke + fill color; defaults to the theme accent */
	sparklineColor?: string;
}

export const MetricCard = memo(function MetricCard({
	icon,
	label,
	value,
	theme,
	animationIndex = 0,
	extra,
	variant = 'elevated',
	accentColor,
	sparklineData,
	sparklineColor,
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
			data-testid="metric-card"
			role="group"
			aria-label={`${label}: ${value}`}
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
					className="text-xs uppercase tracking-wide mb-1"
					style={{ color: theme.colors.textDim }}
				>
					{label}
				</div>
				<div
					className="font-bold"
					style={{
						color: theme.colors.textMain,
						fontSize: 'clamp(18px, 3vw, 28px)',
					}}
					title={value}
				>
					<AnimatedNumber value={value} />
				</div>
				{extra}
			</div>
			{sparklineData && (
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

/**
 * Format hour number (0-23) to human-readable time
 * Examples: 0 → "12 AM", 13 → "1 PM", 9 → "9 AM"
 */
function formatHour(hour: number): string {
	const suffix = hour >= 12 ? 'PM' : 'AM';
	const displayHour = hour % 12 || 12;
	return `${displayHour} ${suffix}`;
}

interface ContextUsageBarProps {
	/** Context usage as a percentage (0-100). Values above 100 are capped. */
	percentage: number;
	theme: Theme;
}

/**
 * Threshold-colored progress bar for an agent's context window usage.
 * Green <70%, yellow 70-89%, red ≥90% (with a subtle red glow).
 */
export const ContextUsageBar = memo(function ContextUsageBar({
	percentage,
	theme,
}: ContextUsageBarProps) {
	const capped = Math.max(0, Math.min(100, percentage));
	const isCritical = capped >= 90;
	const fillColor = isCritical
		? theme.colors.error
		: capped >= 70
			? theme.colors.warning
			: theme.colors.success;

	return (
		<div className="w-full" data-testid="context-usage-bar">
			<div
				className="flex items-center justify-between text-[10px] mb-1"
				style={{ color: theme.colors.textDim }}
			>
				<span className="uppercase tracking-wide">Context</span>
				<span style={{ color: fillColor, fontWeight: 600 }}>{Math.round(capped)}%</span>
			</div>
			<div
				className="w-full h-1.5 rounded-full overflow-hidden"
				style={{ backgroundColor: theme.colors.bgMain }}
				role="progressbar"
				aria-valuenow={Math.round(capped)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label="Context window usage"
			>
				<div
					className="h-full rounded-full transition-all duration-500 ease-out"
					style={{
						width: `${capped}%`,
						backgroundColor: fillColor,
						boxShadow: isCritical ? `0 0 6px ${theme.colors.error}60` : undefined,
					}}
				/>
			</div>
		</div>
	);
});

// Placeholder per-1K-token rates for current-cycle cost estimation.
// `currentCycleTokens` does not split input vs output, so we apply a blended
// rate that approximates Claude pricing ($3/M input, $15/M output).
// TODO: replace with provider-specific rates and split when the parser exposes
// input/output token counts for the in-flight cycle.
const CURRENT_CYCLE_INPUT_RATE_PER_1K = 0.003;
const CURRENT_CYCLE_OUTPUT_RATE_PER_1K = 0.015;
const CURRENT_CYCLE_BLENDED_RATE_PER_1K =
	(CURRENT_CYCLE_INPUT_RATE_PER_1K + CURRENT_CYCLE_OUTPUT_RATE_PER_1K) / 2;

interface TokenCostBadgeProps {
	sessions: Session[];
	theme: Theme;
}

/**
 * Aggregates `currentCycleTokens` across busy sessions and renders the total
 * with a blended-rate cost estimate plus a per-session breakdown.
 */
export const TokenCostBadge = memo(function TokenCostBadge({
	sessions,
	theme,
}: TokenCostBadgeProps) {
	const { totalTokens, estimatedCost, breakdown } = useMemo(() => {
		const busy = sessions.filter((s) => s.state === 'busy');
		let total = 0;
		const items: Array<{ id: string; name: string; tokens: number }> = [];
		for (const s of busy) {
			const tokens = s.currentCycleTokens ?? 0;
			if (tokens > 0) {
				total += tokens;
				items.push({ id: s.id, name: s.name, tokens });
			}
		}
		items.sort((a, b) => b.tokens - a.tokens);
		const cost = (total / 1000) * CURRENT_CYCLE_BLENDED_RATE_PER_1K;
		return { totalTokens: total, estimatedCost: cost, breakdown: items };
	}, [sessions]);

	return (
		<div className="flex flex-col" data-testid="token-cost-badge">
			<div className="text-[10px] uppercase tracking-wide" style={{ color: theme.colors.textDim }}>
				Cycle Tokens
			</div>
			<div className="flex items-baseline gap-2 mt-0.5">
				<span
					className="font-bold"
					style={{ color: theme.colors.textMain, fontSize: '20px' }}
					title={`${totalTokens.toLocaleString()} tokens`}
				>
					{formatNumber(totalTokens)}
				</span>
				<span
					className="text-xs font-medium"
					style={{ color: theme.colors.warning }}
					title="Estimated cost for the current thinking cycle"
					data-testid="token-cost-estimate"
				>
					{formatCost(estimatedCost)}
				</span>
			</div>
			{breakdown.length > 0 && (
				<div
					className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px]"
					style={{ color: theme.colors.textDim }}
					data-testid="token-cost-breakdown"
				>
					{breakdown.slice(0, 4).map((item) => (
						<span key={item.id} title={`${item.tokens.toLocaleString()} tokens`}>
							{item.name}: {formatNumber(item.tokens)}
						</span>
					))}
					{breakdown.length > 4 && <span>+{breakdown.length - 4} more</span>}
				</div>
			)}
		</div>
	);
});

interface RealtimeMetricsCardProps {
	sessions: Session[];
	theme: Theme;
	/** Stagger delay (in ms) for the card-enter animation */
	animationDelay?: number;
}

/**
 * Compact, information-dense card combining live context-usage,
 * current-cycle token/cost, and elapsed thinking time across active agents.
 */
export const RealtimeMetricsCard = memo(function RealtimeMetricsCard({
	sessions,
	theme,
	animationDelay = 0,
}: RealtimeMetricsCardProps) {
	const activeSessions = useMemo(
		() => sessions.filter((s) => s.state === 'busy' || s.state === 'idle'),
		[sessions]
	);

	const peakContextUsage = useMemo(() => {
		let peak = 0;
		for (const s of activeSessions) {
			if (typeof s.contextUsage === 'number' && s.contextUsage > peak) {
				peak = s.contextUsage;
			}
		}
		return peak;
	}, [activeSessions]);

	const earliestThinkingStart = useMemo(() => {
		let earliest: number | null = null;
		for (const s of sessions) {
			if (s.state === 'busy' && typeof s.thinkingStartTime === 'number') {
				if (earliest === null || s.thinkingStartTime < earliest) {
					earliest = s.thinkingStartTime;
				}
			}
		}
		return earliest;
	}, [sessions]);

	// Tick once a second while any session is thinking so elapsed time updates
	// smoothly; the dashboard's stats subscription is too coarse for this.
	const [elapsedMs, setElapsedMs] = useState(() =>
		earliestThinkingStart !== null ? Date.now() - earliestThinkingStart : 0
	);
	useEffect(() => {
		if (earliestThinkingStart === null) {
			setElapsedMs(0);
			return;
		}
		setElapsedMs(Date.now() - earliestThinkingStart);
		const interval = window.setInterval(() => {
			setElapsedMs(Date.now() - earliestThinkingStart);
		}, 1000);
		return () => window.clearInterval(interval);
	}, [earliestThinkingStart]);

	const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const isThinking = earliestThinkingStart !== null;
	const activeCount = activeSessions.length;

	return (
		<div
			className="p-4 card-enter"
			style={{
				...getCardStyles('elevated', theme),
				animationDelay: `${animationDelay}ms`,
			}}
			data-testid="realtime-metrics-card"
			role="group"
			aria-label="Real-time agent metrics"
		>
			<div className="flex items-start gap-3">
				<div
					className="flex-shrink-0 p-2 rounded-md"
					style={{
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.accent,
					}}
				>
					<Activity className="w-4 h-4" />
				</div>
				<div className="min-w-0 flex-1">
					<div
						className="text-xs uppercase tracking-wide mb-2"
						style={{ color: theme.colors.textDim }}
					>
						Real-time
					</div>
					<div className="flex items-center gap-1.5 mb-2">
						<Cpu
							className="w-3 h-3 flex-shrink-0"
							style={{ color: theme.colors.textDim }}
							aria-hidden="true"
						/>
						<div className="flex-1">
							<ContextUsageBar percentage={peakContextUsage} theme={theme} />
						</div>
					</div>
					<div className="flex items-center gap-1.5 mt-3">
						<DollarSign
							className="w-3 h-3 flex-shrink-0"
							style={{ color: theme.colors.textDim }}
							aria-hidden="true"
						/>
						<div className="flex-1">
							<TokenCostBadge sessions={sessions} theme={theme} />
						</div>
					</div>
					{isThinking && (
						<div
							className="mt-3 inline-flex items-center gap-1.5 text-[11px] animate-pulse"
							style={{ color: theme.colors.warning }}
							data-testid="realtime-thinking-elapsed"
							aria-label={`Thinking for ${elapsedSeconds} seconds`}
						>
							<Clock className="w-3 h-3" aria-hidden="true" />
							Thinking: {elapsedSeconds}s
						</div>
					)}
				</div>
			</div>
			<div
				className="mt-3 pt-3 border-t flex items-center gap-1.5 text-[10px]"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				data-testid="realtime-active-count"
			>
				<span
					className="w-1.5 h-1.5 rounded-full"
					style={{ backgroundColor: theme.colors.success }}
					aria-hidden="true"
				/>
				<span>
					{activeCount} active {activeCount === 1 ? 'agent' : 'agents'}
				</span>
			</div>
		</div>
	);
});

export const SummaryCards = memo(function SummaryCards({
	data,
	theme,
	columns = 3,
	sessions,
}: SummaryCardsProps) {
	// Count agent sessions (exclude terminal-only sessions) for accurate total
	const agentCount = useMemo(() => {
		if (sessions) {
			return sessions.filter((s) => s.toolType !== 'terminal').length;
		}
		// Fallback to stats-based count if sessions not provided
		return data.totalSessions;
	}, [sessions, data.totalSessions]);

	// Count open tabs across all sessions (AI + file preview)
	const openTabCount = useMemo(() => {
		if (!sessions) return 0;
		return sessions.reduce((total, s) => {
			const aiCount = s.aiTabs?.length ?? 0;
			const fileCount = s.filePreviewTabs?.length ?? 0;
			return total + aiCount + fileCount;
		}, 0);
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

	const statusBreakdown = statusCounts ? (
		<div
			className="flex items-center gap-2 mt-1.5 text-[10px]"
			style={{ color: theme.colors.textDim }}
			data-testid="agent-status-breakdown"
			aria-label={`${statusCounts.busy} busy, ${statusCounts.idle} idle, ${statusCounts.error} errors`}
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
		</div>
	) : null;

	// Calculate derived metrics
	const { mostActiveAgent, peakHour, queriesPerSession } = useMemo(() => {
		// Find most active agent by query count
		const agents = Object.entries(data.byAgent);
		const topAgent = agents.length > 0 ? agents.sort((a, b) => b[1].count - a[1].count)[0] : null;

		// Find peak usage hour (hour with most queries)
		const hourWithMostQueries = data.byHour.reduce(
			(max, curr) => (curr.count > max.count ? curr : max),
			{ hour: 0, count: 0, duration: 0 }
		);
		const peak = hourWithMostQueries.count > 0 ? formatHour(hourWithMostQueries.hour) : 'N/A';

		// Calculate queries per session using agent count for consistency
		const qps = agentCount > 0 ? (data.totalQueries / agentCount).toFixed(1) : 'N/A';

		return {
			mostActiveAgent: topAgent ? topAgent[0] : 'N/A',
			peakHour: peak,
			queriesPerSession: qps,
		};
	}, [data.byAgent, data.byHour, agentCount, data.totalQueries]);

	const streaks = useMemo(() => computeStreaks(data.byDay), [data.byDay]);
	const bestDay = useMemo(() => findBestDay(data.byDay), [data.byDay]);
	const activeDays = useMemo(() => countActiveDays(data.byDay), [data.byDay]);

	// Worktree adoption — fraction of queries originating from worktree-child
	// agents. The aggregation already exposes `worktreeQueries` / `parentQueries`
	// so we don't need to walk session lists here.
	const worktreeShare = useMemo(() => {
		const total = data.worktreeQueries + data.parentQueries;
		if (total === 0) return null;
		return Math.round((data.worktreeQueries / total) * 100);
	}, [data.worktreeQueries, data.parentQueries]);

	const queriesSparkline = useMemo(() => getLast7Days(data.byDay), [data.byDay]);
	const durationSparkline = useMemo(() => getLast7DaysDuration(data.byDay), [data.byDay]);

	const metrics: Array<{
		icon: React.ReactNode;
		label: string;
		value: string;
		extra?: React.ReactNode;
		sparklineData?: number[];
		sparklineColor?: string;
	}> = [
		{
			icon: <Layers className="w-4 h-4" />,
			label: 'Agents',
			value: formatNumber(agentCount),
			extra: statusBreakdown,
		},
		{
			icon: <PanelTop className="w-4 h-4" />,
			label: 'Open Tabs',
			value: formatNumber(openTabCount),
		},
		{
			icon: <MessageSquare className="w-4 h-4" />,
			label: 'Total Queries',
			value: formatNumber(data.totalQueries),
			sparklineData: queriesSparkline,
		},
		{
			icon: <Zap className="w-4 h-4" />,
			label: 'Queries/Session',
			value: queriesPerSession,
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
			value: formatDuration(data.avgDuration),
		},
		{
			icon: <Sunrise className="w-4 h-4" />,
			label: 'Peak Hour',
			value: peakHour,
		},
		{
			icon: <Bot className="w-4 h-4" />,
			label: 'Top Agent',
			value: mostActiveAgent,
		},
		// Streak / momentum row — replaces the always-stable Local% and
		// Interactive% cards, which were context-free numbers that never
		// changed. Streak tells the user something they actually want to know.
		{
			icon: <Flame className="w-4 h-4" />,
			label: 'Current Streak',
			value: streaks.current === 0 ? '—' : `${streaks.current}d`,
			extra:
				streaks.max > 0 ? (
					<div
						className="text-[10px] mt-1 uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Best: {streaks.max}d
					</div>
				) : undefined,
		},
		{
			icon: <Trophy className="w-4 h-4" />,
			label: 'Best Day',
			value: bestDay ? formatNumber(bestDay.count) : '—',
			extra: bestDay ? (
				<div
					className="text-[10px] mt-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					{formatShortDate(bestDay.date)}
				</div>
			) : undefined,
		},
		{
			icon: <CalendarCheck className="w-4 h-4" />,
			label: 'Active Days',
			value: formatNumber(activeDays),
		},
		{
			icon: <GitBranch className="w-4 h-4" />,
			label: 'Worktree %',
			value: worktreeShare == null ? '—' : `${worktreeShare}%`,
		},
	];

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
					value={metric.value}
					theme={theme}
					animationIndex={index}
					extra={metric.extra}
					sparklineData={metric.sparklineData}
					sparklineColor={metric.sparklineColor}
				/>
			))}
		</div>
	);
});

export default SummaryCards;
