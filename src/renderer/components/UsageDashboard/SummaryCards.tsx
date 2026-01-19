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

import React, { useMemo } from 'react';
import { MessageSquare, Clock, Timer, Bot, Users, Layers } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/useStats';

interface SummaryCardsProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Number of columns for responsive layout (default: 3 for 2 rows × 3 cols) */
	columns?: number;
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
 * Single metric card component
 */
interface MetricCardProps {
	icon: React.ReactNode;
	label: string;
	value: string;
	theme: Theme;
	/** Animation delay index for staggered entrance (0-based) */
	animationIndex?: number;
}

function MetricCard({ icon, label, value, theme, animationIndex = 0 }: MetricCardProps) {
	return (
		<div
			className="p-4 rounded-lg flex items-start gap-3 dashboard-card-enter"
			style={{
				backgroundColor: theme.colors.bgMain,
				animationDelay: `${animationIndex * 50}ms`,
			}}
			data-testid="metric-card"
			role="group"
			aria-label={`${label}: ${value}`}
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
				<div className="text-2xl font-bold" style={{ color: theme.colors.textMain }} title={value}>
					{value}
				</div>
			</div>
		</div>
	);
}

export function SummaryCards({ data, theme, columns = 3 }: SummaryCardsProps) {
	// Calculate derived metrics
	const { mostActiveAgent, interactiveRatio } = useMemo(() => {
		// Find most active agent by query count
		const agents = Object.entries(data.byAgent);
		const topAgent = agents.length > 0 ? agents.sort((a, b) => b[1].count - a[1].count)[0] : null;

		// Calculate interactive percentage
		const totalBySource = data.bySource.user + data.bySource.auto;
		const ratio =
			totalBySource > 0 ? `${Math.round((data.bySource.user / totalBySource) * 100)}%` : 'N/A';

		return {
			mostActiveAgent: topAgent ? topAgent[0] : 'N/A',
			interactiveRatio: ratio,
		};
	}, [data.byAgent, data.bySource]);

	const metrics = [
		{
			icon: <Layers className="w-4 h-4" />,
			label: 'Sessions',
			value: formatNumber(data.totalSessions),
		},
		{
			icon: <MessageSquare className="w-4 h-4" />,
			label: 'Total Queries',
			value: formatNumber(data.totalQueries),
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
			icon: <Bot className="w-4 h-4" />,
			label: 'Top Agent',
			value: mostActiveAgent,
		},
		{
			icon: <Users className="w-4 h-4" />,
			label: 'Interactive %',
			value: interactiveRatio,
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
				/>
			))}
		</div>
	);
}

export default SummaryCards;
