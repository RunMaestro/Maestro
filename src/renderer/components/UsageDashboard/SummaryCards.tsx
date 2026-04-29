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

import React, { memo, useMemo, useState } from 'react';
import {
	MessageSquare,
	Clock,
	Timer,
	Bot,
	Users,
	Layers,
	Sunrise,
	Globe,
	Zap,
	PanelTop,
} from 'lucide-react';
import type { Theme, Session } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';

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
 * Format duration in milliseconds to human-readable string
 * Examples: "12h 34m", "5m 30s", "45s"
 */
function formatDuration(ms: number): string {
	if (ms === 0) return '0s';

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Format large numbers with K/M suffixes for readability
 * Examples: "1.2K", "3.5M", "42"
 */
function formatNumber(num: number): string {
	if (num >= 1000000) {
		return `${(num / 1000000).toFixed(1)}M`;
	}
	if (num >= 1000) {
		return `${(num / 1000).toFixed(1)}K`;
	}
	return num.toString();
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
}

const MetricCard = memo(function MetricCard({
	icon,
	label,
	value,
	theme,
	animationIndex = 0,
	extra,
	variant = 'elevated',
	accentColor,
}: MetricCardProps) {
	const [hovered, setHovered] = useState(false);

	return (
		<div
			className="p-4 flex items-start gap-3 card-enter"
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
					{value}
				</div>
				{extra}
			</div>
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
	const { mostActiveAgent, interactiveRatio, peakHour, localVsRemote, queriesPerSession } =
		useMemo(() => {
			// Find most active agent by query count
			const agents = Object.entries(data.byAgent);
			const topAgent = agents.length > 0 ? agents.sort((a, b) => b[1].count - a[1].count)[0] : null;

			// Calculate interactive percentage
			const totalBySource = data.bySource.user + data.bySource.auto;
			const ratio =
				totalBySource > 0 ? `${Math.round((data.bySource.user / totalBySource) * 100)}%` : 'N/A';

			// Find peak usage hour (hour with most queries)
			const hourWithMostQueries = data.byHour.reduce(
				(max, curr) => (curr.count > max.count ? curr : max),
				{ hour: 0, count: 0, duration: 0 }
			);
			const peak = hourWithMostQueries.count > 0 ? formatHour(hourWithMostQueries.hour) : 'N/A';

			// Calculate local vs remote percentage
			const totalByLocation = data.byLocation.local + data.byLocation.remote;
			const localPercent =
				totalByLocation > 0
					? `${Math.round((data.byLocation.local / totalByLocation) * 100)}%`
					: 'N/A';

			// Calculate queries per session using agent count for consistency
			const qps = agentCount > 0 ? (data.totalQueries / agentCount).toFixed(1) : 'N/A';

			return {
				mostActiveAgent: topAgent ? topAgent[0] : 'N/A',
				interactiveRatio: ratio,
				peakHour: peak,
				localVsRemote: localPercent,
				queriesPerSession: qps,
			};
		}, [data.byAgent, data.bySource, data.byHour, data.byLocation, agentCount, data.totalQueries]);

	const metrics: Array<{
		icon: React.ReactNode;
		label: string;
		value: string;
		extra?: React.ReactNode;
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
		{
			icon: <Users className="w-4 h-4" />,
			label: 'Interactive %',
			value: interactiveRatio,
		},
		{
			icon: <Globe className="w-4 h-4" />,
			label: 'Local %',
			value: localVsRemote,
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
				/>
			))}
		</div>
	);
});

export default SummaryCards;
