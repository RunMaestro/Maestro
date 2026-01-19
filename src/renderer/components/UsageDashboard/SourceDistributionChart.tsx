/**
 * SourceDistributionChart
 *
 * Donut/pie chart showing Interactive vs Auto breakdown.
 * Displays the distribution of usage sources with toggle between count and duration views.
 *
 * Features:
 * - Donut/pie chart visualization
 * - Toggle between count-based and duration-based views
 * - Center label showing total
 * - Legend with percentages
 * - Theme-aware colors (accent for user/interactive, secondary for auto)
 * - Tooltip on hover with exact values
 */

import React, { useState, useMemo } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/useStats';
import { COLORBLIND_BINARY_PALETTE } from '../../constants/colorblindPalettes';

// Metric display mode
type MetricMode = 'count' | 'duration';

interface SourceData {
	source: 'interactive' | 'auto';
	label: string;
	value: number;
	percentage: number;
	color: string;
}

interface SourceDistributionChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
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
 * Format large numbers with K/M suffixes
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
 * Get a secondary color for auto source that contrasts with accent
 * Uses a desaturated/muted version of a complementary color
 */
function getAutoColor(theme: Theme): string {
	// Parse accent color to get a complementary color
	const accent = theme.colors.accent;
	let accentRgb: { r: number; g: number; b: number } | null = null;

	if (accent.startsWith('#')) {
		const hex = accent.slice(1);
		accentRgb = {
			r: parseInt(hex.slice(0, 2), 16),
			g: parseInt(hex.slice(2, 4), 16),
			b: parseInt(hex.slice(4, 6), 16),
		};
	} else if (accent.startsWith('rgb')) {
		const match = accent.match(/\d+/g);
		if (match && match.length >= 3) {
			accentRgb = {
				r: parseInt(match[0]),
				g: parseInt(match[1]),
				b: parseInt(match[2]),
			};
		}
	}

	if (!accentRgb) {
		// Fallback to a muted gray-blue
		return '#6b7280';
	}

	// Create a muted complementary/contrasting color
	// Shift hue and reduce saturation for better visual distinction
	const avg = (accentRgb.r + accentRgb.g + accentRgb.b) / 3;
	const isBright = avg > 128;

	// For the auto color, use a muted version that contrasts with the accent
	// If accent is bright, use a darker muted color; if dark, use a lighter muted color
	if (isBright) {
		return '#64748b'; // slate-500
	} else {
		return '#94a3b8'; // slate-400
	}
}

/**
 * SVG arc path generator for donut chart segments
 */
function describeArc(
	x: number,
	y: number,
	outerRadius: number,
	innerRadius: number,
	startAngle: number,
	endAngle: number
): string {
	// Handle full circle case (nearly 360 degrees)
	if (endAngle - startAngle >= 359.99) {
		// Draw two half arcs to create a full circle
		const midAngle = startAngle + 180;
		return `
      ${describeArc(x, y, outerRadius, innerRadius, startAngle, midAngle)}
      ${describeArc(x, y, outerRadius, innerRadius, midAngle, endAngle)}
    `;
	}

	const startRad = (startAngle - 90) * (Math.PI / 180);
	const endRad = (endAngle - 90) * (Math.PI / 180);

	const startOuterX = x + outerRadius * Math.cos(startRad);
	const startOuterY = y + outerRadius * Math.sin(startRad);
	const endOuterX = x + outerRadius * Math.cos(endRad);
	const endOuterY = y + outerRadius * Math.sin(endRad);

	const startInnerX = x + innerRadius * Math.cos(startRad);
	const startInnerY = y + innerRadius * Math.sin(startRad);
	const endInnerX = x + innerRadius * Math.cos(endRad);
	const endInnerY = y + innerRadius * Math.sin(endRad);

	const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;

	return `
    M ${startOuterX} ${startOuterY}
    A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuterX} ${endOuterY}
    L ${endInnerX} ${endInnerY}
    A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${startInnerX} ${startInnerY}
    Z
  `;
}

export function SourceDistributionChart({
	data,
	theme,
	colorBlindMode = false,
}: SourceDistributionChartProps) {
	const [metricMode, setMetricMode] = useState<MetricMode>('count');
	const [hoveredSource, setHoveredSource] = useState<'interactive' | 'auto' | null>(null);

	// Calculate source data based on mode
	const sourceData = useMemo((): SourceData[] => {
		const interactiveValue =
			metricMode === 'count'
				? data.bySource.user
				: (data.bySource.user / (data.bySource.user + data.bySource.auto || 1)) *
					data.totalDuration;
		const autoValue =
			metricMode === 'count'
				? data.bySource.auto
				: (data.bySource.auto / (data.bySource.user + data.bySource.auto || 1)) *
					data.totalDuration;

		const total = interactiveValue + autoValue;

		const sources: SourceData[] = [];

		// Use colorblind-safe colors when colorblind mode is enabled
		const interactiveColor = colorBlindMode
			? COLORBLIND_BINARY_PALETTE.primary
			: theme.colors.accent;
		const autoColor = colorBlindMode ? COLORBLIND_BINARY_PALETTE.secondary : getAutoColor(theme);

		if (interactiveValue > 0 || autoValue === 0) {
			sources.push({
				source: 'interactive',
				label: 'Interactive',
				value: interactiveValue,
				percentage: total > 0 ? (interactiveValue / total) * 100 : total === 0 ? 50 : 0,
				color: interactiveColor,
			});
		}

		if (autoValue > 0 || interactiveValue === 0) {
			sources.push({
				source: 'auto',
				label: 'Auto Run',
				value: autoValue,
				percentage: total > 0 ? (autoValue / total) * 100 : total === 0 ? 50 : 0,
				color: autoColor,
			});
		}

		return sources;
	}, [data, metricMode, theme, colorBlindMode]);

	// Calculate total for center label
	const total = useMemo(() => {
		return sourceData.reduce((sum, s) => sum + s.value, 0);
	}, [sourceData]);

	// Donut chart configuration
	const size = 160;
	const outerRadius = 70;
	const innerRadius = 45;
	const centerX = size / 2;
	const centerY = size / 2;

	// Calculate arc angles for each segment
	const arcs = useMemo(() => {
		let currentAngle = 0;
		return sourceData.map((source) => {
			const sweepAngle = (source.percentage / 100) * 360;
			const startAngle = currentAngle;
			const endAngle = currentAngle + sweepAngle;
			currentAngle = endAngle;
			return {
				...source,
				startAngle,
				endAngle,
			};
		});
	}, [sourceData]);

	// Check if there's any data
	const hasData = data.bySource.user > 0 || data.bySource.auto > 0;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Session type chart showing ${metricMode === 'count' ? 'query counts' : 'duration'} breakdown between Interactive and Auto Run sessions.`}
		>
			{/* Header with title and metric toggle */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Session Type
				</h3>
				<div className="flex items-center gap-2">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Show:
					</span>
					<div
						className="flex rounded overflow-hidden border"
						style={{ borderColor: theme.colors.border }}
					>
						<button
							onClick={() => setMetricMode('count')}
							className="px-2 py-1 text-xs transition-colors"
							style={{
								backgroundColor:
									metricMode === 'count' ? `${theme.colors.accent}20` : 'transparent',
								color: metricMode === 'count' ? theme.colors.accent : theme.colors.textDim,
							}}
							aria-pressed={metricMode === 'count'}
							aria-label="Show query count"
						>
							Count
						</button>
						<button
							onClick={() => setMetricMode('duration')}
							className="px-2 py-1 text-xs transition-colors"
							style={{
								backgroundColor:
									metricMode === 'duration' ? `${theme.colors.accent}20` : 'transparent',
								color: metricMode === 'duration' ? theme.colors.accent : theme.colors.textDim,
								borderLeft: `1px solid ${theme.colors.border}`,
							}}
							aria-pressed={metricMode === 'duration'}
							aria-label="Show total duration"
						>
							Duration
						</button>
					</div>
				</div>
			</div>

			{/* Chart container */}
			<div className="flex items-center justify-center gap-8">
				{!hasData ? (
					<div
						className="flex items-center justify-center h-40"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-sm">No source data available</span>
					</div>
				) : (
					<>
						{/* Donut chart */}
						<div className="relative">
							<svg
								width={size}
								height={size}
								viewBox={`0 0 ${size} ${size}`}
								role="img"
								aria-label={`Donut chart: ${sourceData.map((s) => `${s.label} ${s.percentage.toFixed(1)}%`).join(', ')}`}
							>
								{arcs.map((arc) => (
									<path
										key={arc.source}
										d={describeArc(
											centerX,
											centerY,
											hoveredSource === arc.source ? outerRadius + 4 : outerRadius,
											innerRadius,
											arc.startAngle,
											arc.endAngle
										)}
										fill={arc.color}
										opacity={hoveredSource === null || hoveredSource === arc.source ? 1 : 0.5}
										className="cursor-default"
										style={{
											transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
										}}
										onMouseEnter={() => setHoveredSource(arc.source)}
										onMouseLeave={() => setHoveredSource(null)}
									/>
								))}
							</svg>

							{/* Center label */}
							<div
								className="absolute inset-0 flex flex-col items-center justify-center"
								style={{ pointerEvents: 'none' }}
							>
								<span className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
									{metricMode === 'count' ? formatNumber(total) : formatDuration(total)}
								</span>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									{metricMode === 'count' ? 'total' : 'time'}
								</span>
							</div>
						</div>

						{/* Legend */}
						<div className="flex flex-col gap-3" role="list" aria-label="Chart legend">
							{sourceData.map((source) => (
								<div
									key={source.source}
									className="flex items-center gap-3 cursor-default"
									onMouseEnter={() => setHoveredSource(source.source)}
									onMouseLeave={() => setHoveredSource(null)}
									role="listitem"
									aria-label={`${source.label}: ${source.percentage.toFixed(1)}%`}
								>
									<div
										className="w-3 h-3 rounded-sm flex-shrink-0"
										style={{ backgroundColor: source.color }}
									/>
									<div className="flex flex-col">
										<span
											className="text-sm font-medium"
											style={{
												color:
													hoveredSource === source.source
														? theme.colors.textMain
														: theme.colors.textDim,
											}}
										>
											{source.label}
										</span>
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											{source.percentage.toFixed(1)}% •{' '}
											{metricMode === 'count'
												? formatNumber(source.value)
												: formatDuration(source.value)}
										</span>
									</div>
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

export default SourceDistributionChart;
