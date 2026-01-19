/**
 * LocationDistributionChart
 *
 * Donut/pie chart showing Local vs SSH Remote session breakdown.
 * Displays the distribution of query locations with count view.
 *
 * Features:
 * - Donut/pie chart visualization
 * - Center label showing total
 * - Legend with percentages
 * - Theme-aware colors
 * - Tooltip on hover with exact values
 */

import React, { useState, useMemo } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/useStats';
import { COLORBLIND_BINARY_PALETTE } from '../../constants/colorblindPalettes';

interface LocationData {
	location: 'local' | 'remote';
	label: string;
	value: number;
	percentage: number;
	color: string;
}

interface LocationDistributionChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
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
 * Get a color for remote sessions that contrasts with accent (local)
 */
function getRemoteColor(theme: Theme): string {
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
		return '#22c55e'; // green-500 fallback
	}

	// Use a green/teal color for remote (SSH) to contrast with accent
	const avg = (accentRgb.r + accentRgb.g + accentRgb.b) / 3;
	const isBright = avg > 128;

	if (isBright) {
		return '#059669'; // emerald-600
	} else {
		return '#34d399'; // emerald-400
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

export function LocationDistributionChart({
	data,
	theme,
	colorBlindMode = false,
}: LocationDistributionChartProps) {
	const [hoveredLocation, setHoveredLocation] = useState<'local' | 'remote' | null>(null);

	// Calculate location data
	const locationData = useMemo((): LocationData[] => {
		const localValue = data.byLocation?.local ?? 0;
		const remoteValue = data.byLocation?.remote ?? 0;
		const total = localValue + remoteValue;

		const locations: LocationData[] = [];

		// Use colorblind-safe colors when colorblind mode is enabled
		const localColor = colorBlindMode ? COLORBLIND_BINARY_PALETTE.primary : theme.colors.accent;
		const remoteColor = colorBlindMode
			? COLORBLIND_BINARY_PALETTE.secondary
			: getRemoteColor(theme);

		if (localValue > 0 || remoteValue === 0) {
			locations.push({
				location: 'local',
				label: 'Local',
				value: localValue,
				percentage: total > 0 ? (localValue / total) * 100 : total === 0 ? 50 : 0,
				color: localColor,
			});
		}

		if (remoteValue > 0 || localValue === 0) {
			locations.push({
				location: 'remote',
				label: 'SSH Remote',
				value: remoteValue,
				percentage: total > 0 ? (remoteValue / total) * 100 : total === 0 ? 50 : 0,
				color: remoteColor,
			});
		}

		return locations;
	}, [data, theme, colorBlindMode]);

	// Calculate total for center label
	const total = useMemo(() => {
		return locationData.reduce((sum, l) => sum + l.value, 0);
	}, [locationData]);

	// Donut chart configuration
	const size = 160;
	const outerRadius = 70;
	const innerRadius = 45;
	const centerX = size / 2;
	const centerY = size / 2;

	// Calculate arc angles for each segment
	const arcs = useMemo(() => {
		let currentAngle = 0;
		return locationData.map((loc) => {
			const sweepAngle = (loc.percentage / 100) * 360;
			const startAngle = currentAngle;
			const endAngle = currentAngle + sweepAngle;
			currentAngle = endAngle;
			return {
				...loc,
				startAngle,
				endAngle,
			};
		});
	}, [locationData]);

	// Check if there's any data
	const hasData = (data.byLocation?.local ?? 0) > 0 || (data.byLocation?.remote ?? 0) > 0;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label="Location distribution chart showing breakdown between Local and SSH Remote sessions."
		>
			{/* Header with title */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Session Location
				</h3>
			</div>

			{/* Chart container */}
			<div className="flex items-center justify-center gap-8">
				{!hasData ? (
					<div
						className="flex items-center justify-center h-40"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-sm">No location data available</span>
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
								aria-label={`Donut chart: ${locationData.map((l) => `${l.label} ${l.percentage.toFixed(1)}%`).join(', ')}`}
							>
								{arcs.map((arc) => (
									<path
										key={arc.location}
										d={describeArc(
											centerX,
											centerY,
											hoveredLocation === arc.location ? outerRadius + 4 : outerRadius,
											innerRadius,
											arc.startAngle,
											arc.endAngle
										)}
										fill={arc.color}
										opacity={hoveredLocation === null || hoveredLocation === arc.location ? 1 : 0.5}
										className="cursor-default"
										style={{
											transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
										}}
										onMouseEnter={() => setHoveredLocation(arc.location)}
										onMouseLeave={() => setHoveredLocation(null)}
									/>
								))}
							</svg>

							{/* Center label */}
							<div
								className="absolute inset-0 flex flex-col items-center justify-center"
								style={{ pointerEvents: 'none' }}
							>
								<span className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
									{formatNumber(total)}
								</span>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									total
								</span>
							</div>
						</div>

						{/* Legend */}
						<div className="flex flex-col gap-3" role="list" aria-label="Chart legend">
							{locationData.map((loc) => (
								<div
									key={loc.location}
									className="flex items-center gap-3 cursor-default"
									onMouseEnter={() => setHoveredLocation(loc.location)}
									onMouseLeave={() => setHoveredLocation(null)}
									role="listitem"
									aria-label={`${loc.label}: ${loc.percentage.toFixed(1)}%`}
								>
									<div
										className="w-3 h-3 rounded-sm flex-shrink-0"
										style={{ backgroundColor: loc.color }}
									/>
									<div className="flex flex-col">
										<span
											className="text-sm font-medium"
											style={{
												color:
													hoveredLocation === loc.location
														? theme.colors.textMain
														: theme.colors.textDim,
											}}
										>
											{loc.label}
										</span>
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											{loc.percentage.toFixed(1)}% • {formatNumber(loc.value)}
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

export default LocationDistributionChart;
