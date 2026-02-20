/**
 * ProviderDetailCharts - Charts and visualizations for the provider detail view
 *
 * Renders inside ProviderDetailView below the summary stats.
 * Layout: 2-column grid of chart panels.
 *
 * Charts:
 * 1. Query Volume Trend (SVG line chart)
 * 2. Response Time Trend (SVG line chart with p95 band)
 * 3. Activity Heatmap (24-hour bar chart)
 * 4. Token Breakdown (horizontal stacked bar)
 * 5. Source & Location Split (two donut charts)
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { Theme } from '../types';
import type { ProviderDetail } from '../hooks/useProviderDetail';
import { formatTokenCount } from '../hooks/useAccountUsage';

// ============================================================================
// Types
// ============================================================================

interface ProviderDetailChartsProps {
	theme: Theme;
	detail: ProviderDetail;
}

// ============================================================================
// Shared helpers
// ============================================================================

function formatDurationMs(ms: number): string {
	if (ms === 0) return '0s';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatHour(hour: number): string {
	if (hour === 0) return '12am';
	if (hour === 12) return '12pm';
	if (hour < 12) return `${hour}am`;
	return `${hour - 12}pm`;
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
	const clean = hex.startsWith('#') ? hex.slice(1) : hex;
	return {
		r: parseInt(clean.slice(0, 2), 16) || 100,
		g: parseInt(clean.slice(2, 4), 16) || 149,
		b: parseInt(clean.slice(4, 6), 16) || 237,
	};
}

// ============================================================================
// Chart wrapper
// ============================================================================

function ChartPanel({
	theme,
	title,
	children,
}: {
	theme: Theme;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div
			style={{
				backgroundColor: theme.colors.bgMain,
				borderRadius: 6,
				padding: '10px 14px',
				border: `1px solid ${theme.colors.border}`,
			}}
		>
			<div
				style={{
					color: theme.colors.textMain,
					fontSize: 12,
					fontWeight: 600,
					marginBottom: 10,
				}}
			>
				{title}
			</div>
			{children}
		</div>
	);
}

// ============================================================================
// Chart 1: Query Volume Trend (SVG line chart)
// ============================================================================

function QueryVolumeTrendChart({
	theme,
	dailyTrend,
}: {
	theme: Theme;
	dailyTrend: ProviderDetail['dailyTrend'];
}) {
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	const chartWidth = 500;
	const chartHeight = 140;
	const pad = { top: 14, right: 20, bottom: 28, left: 40 };
	const innerW = chartWidth - pad.left - pad.right;
	const innerH = chartHeight - pad.top - pad.bottom;

	const maxVal = useMemo(
		() => Math.max(...dailyTrend.map((d) => d.queryCount), 1),
		[dailyTrend],
	);

	const xScale = useCallback(
		(i: number) => pad.left + (i / Math.max(dailyTrend.length - 1, 1)) * innerW,
		[dailyTrend.length, innerW, pad.left],
	);

	const yScale = useCallback(
		(v: number) => chartHeight - pad.bottom - (v / (maxVal * 1.1)) * innerH,
		[maxVal, innerH, chartHeight, pad.bottom],
	);

	const linePath = useMemo(() => {
		if (dailyTrend.length === 0) return '';
		return dailyTrend
			.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.queryCount)}`)
			.join(' ');
	}, [dailyTrend, xScale, yScale]);

	const areaPath = useMemo(() => {
		if (dailyTrend.length === 0) return '';
		const line = dailyTrend
			.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.queryCount)}`)
			.join(' ');
		const lastX = xScale(dailyTrend.length - 1);
		const firstX = xScale(0);
		const baseline = chartHeight - pad.bottom;
		return `${line} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
	}, [dailyTrend, xScale, yScale, chartHeight, pad.bottom]);

	const accent = parseHexColor(theme.colors.accent);
	const gradientId = 'qvt-grad';

	// Y-axis ticks
	const yTicks = useMemo(() => {
		const tickCount = 4;
		const yMax = maxVal * 1.1;
		return Array.from({ length: tickCount }, (_, i) => Math.round((yMax / (tickCount - 1)) * i));
	}, [maxVal]);

	// X-axis labels — show max 7
	const xLabelInterval = useMemo(
		() => Math.max(1, Math.ceil(dailyTrend.length / 7)),
		[dailyTrend.length],
	);

	if (dailyTrend.length === 0) {
		return (
			<div
				className="flex items-center justify-center"
				style={{ height: chartHeight, color: theme.colors.textDim }}
			>
				<span style={{ fontSize: 11 }}>No trend data available</span>
			</div>
		);
	}

	return (
		<div className="relative">
			<svg
				width="100%"
				viewBox={`0 0 ${chartWidth} ${chartHeight}`}
				preserveAspectRatio="xMidYMid meet"
			>
				<defs>
					<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor={`rgba(${accent.r},${accent.g},${accent.b},0.25)`} />
						<stop offset="100%" stopColor={`rgba(${accent.r},${accent.g},${accent.b},0)`} />
					</linearGradient>
				</defs>

				{/* Grid lines + Y labels */}
				{yTicks.map((tick, i) => (
					<g key={`yt-${i}`}>
						<line
							x1={pad.left}
							y1={yScale(tick)}
							x2={chartWidth - pad.right}
							y2={yScale(tick)}
							stroke={theme.colors.border}
							strokeOpacity={0.3}
							strokeDasharray="4,4"
						/>
						<text
							x={pad.left - 6}
							y={yScale(tick)}
							textAnchor="end"
							dominantBaseline="middle"
							fontSize={9}
							fill={theme.colors.textDim}
						>
							{tick}
						</text>
					</g>
				))}

				{/* X labels */}
				{dailyTrend.map((d, i) => {
					if (i % xLabelInterval !== 0 && i !== dailyTrend.length - 1) return null;
					const label = d.date.slice(5); // MM-DD
					return (
						<text
							key={`xl-${i}`}
							x={xScale(i)}
							y={chartHeight - pad.bottom + 16}
							textAnchor="middle"
							fontSize={9}
							fill={theme.colors.textDim}
						>
							{label}
						</text>
					);
				})}

				{/* Area fill */}
				<path d={areaPath} fill={`url(#${gradientId})`} />

				{/* Line */}
				<path
					d={linePath}
					fill="none"
					stroke={theme.colors.accent}
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>

				{/* Data points */}
				{dailyTrend.map((d, i) => {
					const isHovered = hoveredIdx === i;
					return (
						<circle
							key={`pt-${i}`}
							cx={xScale(i)}
							cy={yScale(d.queryCount)}
							r={isHovered ? 5 : 3}
							fill={isHovered ? theme.colors.accent : theme.colors.bgMain}
							stroke={theme.colors.accent}
							strokeWidth={1.5}
							style={{ cursor: 'pointer' }}
							onMouseEnter={(e) => {
								setHoveredIdx(i);
								const rect = e.currentTarget.getBoundingClientRect();
								setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
							}}
							onMouseLeave={() => {
								setHoveredIdx(null);
								setTooltipPos(null);
							}}
						/>
					);
				})}
			</svg>

			{/* Tooltip */}
			{hoveredIdx !== null && tooltipPos && (
				<div
					className="fixed z-50 px-2 py-1.5 rounded text-xs whitespace-nowrap pointer-events-none"
					style={{
						left: tooltipPos.x,
						top: tooltipPos.y - 6,
						transform: 'translate(-50%, -100%)',
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
						boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
					}}
				>
					<div style={{ fontWeight: 500 }}>{dailyTrend[hoveredIdx].date}</div>
					<div style={{ color: theme.colors.textDim }}>
						{dailyTrend[hoveredIdx].queryCount} queries
					</div>
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Chart 2: Response Time Trend (SVG line chart with p95 band)
// ============================================================================

function ResponseTimeTrendChart({
	theme,
	dailyTrend,
	p95ResponseTimeMs,
}: {
	theme: Theme;
	dailyTrend: ProviderDetail['dailyTrend'];
	p95ResponseTimeMs: number;
}) {
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	const chartWidth = 500;
	const chartHeight = 140;
	const pad = { top: 14, right: 20, bottom: 28, left: 44 };
	const innerW = chartWidth - pad.left - pad.right;
	const innerH = chartHeight - pad.top - pad.bottom;

	const maxVal = useMemo(() => {
		const maxAvg = Math.max(...dailyTrend.map((d) => d.avgDurationMs), 1);
		return Math.max(maxAvg, p95ResponseTimeMs) * 1.1;
	}, [dailyTrend, p95ResponseTimeMs]);

	const xScale = useCallback(
		(i: number) => pad.left + (i / Math.max(dailyTrend.length - 1, 1)) * innerW,
		[dailyTrend.length, innerW, pad.left],
	);

	const yScale = useCallback(
		(v: number) => chartHeight - pad.bottom - (v / maxVal) * innerH,
		[maxVal, innerH, chartHeight, pad.bottom],
	);

	const linePath = useMemo(() => {
		if (dailyTrend.length === 0) return '';
		return dailyTrend
			.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.avgDurationMs)}`)
			.join(' ');
	}, [dailyTrend, xScale, yScale]);

	// Y-axis ticks
	const yTicks = useMemo(() => {
		const tickCount = 4;
		return Array.from({ length: tickCount }, (_, i) => Math.round((maxVal / (tickCount - 1)) * i));
	}, [maxVal]);

	const xLabelInterval = useMemo(
		() => Math.max(1, Math.ceil(dailyTrend.length / 7)),
		[dailyTrend.length],
	);

	if (dailyTrend.length === 0) {
		return (
			<div
				className="flex items-center justify-center"
				style={{ height: chartHeight, color: theme.colors.textDim }}
			>
				<span style={{ fontSize: 11 }}>No response time data available</span>
			</div>
		);
	}

	return (
		<div className="relative">
			<svg
				width="100%"
				viewBox={`0 0 ${chartWidth} ${chartHeight}`}
				preserveAspectRatio="xMidYMid meet"
			>
				{/* Grid lines + Y labels */}
				{yTicks.map((tick, i) => (
					<g key={`yt-${i}`}>
						<line
							x1={pad.left}
							y1={yScale(tick)}
							x2={chartWidth - pad.right}
							y2={yScale(tick)}
							stroke={theme.colors.border}
							strokeOpacity={0.3}
							strokeDasharray="4,4"
						/>
						<text
							x={pad.left - 6}
							y={yScale(tick)}
							textAnchor="end"
							dominantBaseline="middle"
							fontSize={9}
							fill={theme.colors.textDim}
						>
							{formatDurationMs(tick)}
						</text>
					</g>
				))}

				{/* X labels */}
				{dailyTrend.map((d, i) => {
					if (i % xLabelInterval !== 0 && i !== dailyTrend.length - 1) return null;
					return (
						<text
							key={`xl-${i}`}
							x={xScale(i)}
							y={chartHeight - pad.bottom + 16}
							textAnchor="middle"
							fontSize={9}
							fill={theme.colors.textDim}
						>
							{d.date.slice(5)}
						</text>
					);
				})}

				{/* P95 reference band */}
				{p95ResponseTimeMs > 0 && (
					<>
						<line
							x1={pad.left}
							y1={yScale(p95ResponseTimeMs)}
							x2={chartWidth - pad.right}
							y2={yScale(p95ResponseTimeMs)}
							stroke={theme.colors.warning}
							strokeWidth={1}
							strokeDasharray="6,3"
							strokeOpacity={0.6}
						/>
						<text
							x={chartWidth - pad.right + 2}
							y={yScale(p95ResponseTimeMs)}
							dominantBaseline="middle"
							fontSize={8}
							fill={theme.colors.warning}
						>
							p95
						</text>
					</>
				)}

				{/* Line */}
				<path
					d={linePath}
					fill="none"
					stroke={theme.colors.accent}
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>

				{/* Data points */}
				{dailyTrend.map((d, i) => {
					const isHovered = hoveredIdx === i;
					return (
						<circle
							key={`pt-${i}`}
							cx={xScale(i)}
							cy={yScale(d.avgDurationMs)}
							r={isHovered ? 5 : 3}
							fill={isHovered ? theme.colors.accent : theme.colors.bgMain}
							stroke={theme.colors.accent}
							strokeWidth={1.5}
							style={{ cursor: 'pointer' }}
							onMouseEnter={(e) => {
								setHoveredIdx(i);
								const rect = e.currentTarget.getBoundingClientRect();
								setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
							}}
							onMouseLeave={() => {
								setHoveredIdx(null);
								setTooltipPos(null);
							}}
						/>
					);
				})}
			</svg>

			{/* Tooltip */}
			{hoveredIdx !== null && tooltipPos && (
				<div
					className="fixed z-50 px-2 py-1.5 rounded text-xs whitespace-nowrap pointer-events-none"
					style={{
						left: tooltipPos.x,
						top: tooltipPos.y - 6,
						transform: 'translate(-50%, -100%)',
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
						boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
					}}
				>
					<div style={{ fontWeight: 500 }}>{dailyTrend[hoveredIdx].date}</div>
					<div style={{ color: theme.colors.textDim }}>
						Avg: {formatDurationMs(dailyTrend[hoveredIdx].avgDurationMs)}
					</div>
				</div>
			)}

			{/* Legend */}
			<div className="flex items-center gap-3 mt-1" style={{ fontSize: 10 }}>
				<div className="flex items-center gap-1">
					<div style={{ width: 12, height: 2, backgroundColor: theme.colors.accent, borderRadius: 1 }} />
					<span style={{ color: theme.colors.textDim }}>Avg Duration</span>
				</div>
				{p95ResponseTimeMs > 0 && (
					<div className="flex items-center gap-1">
						<div
							style={{
								width: 12,
								height: 0,
								borderTop: `1px dashed ${theme.colors.warning}`,
							}}
						/>
						<span style={{ color: theme.colors.textDim }}>P95 ({formatDurationMs(p95ResponseTimeMs)})</span>
					</div>
				)}
			</div>
		</div>
	);
}

// ============================================================================
// Chart 3: Activity Heatmap (24-hour bar chart)
// ============================================================================

function ActivityHoursChart({
	theme,
	hourlyPattern,
}: {
	theme: Theme;
	hourlyPattern: ProviderDetail['hourlyPattern'];
}) {
	const [hoveredHour, setHoveredHour] = useState<number | null>(null);

	const maxCount = useMemo(
		() => Math.max(...hourlyPattern.map((h) => h.queryCount), 1),
		[hourlyPattern],
	);

	const peakHour = useMemo(() => {
		let peak = { hour: 0, count: 0 };
		for (const h of hourlyPattern) {
			if (h.queryCount > peak.count) {
				peak = { hour: h.hour, count: h.queryCount };
			}
		}
		return peak.hour;
	}, [hourlyPattern]);

	const hasData = hourlyPattern.some((h) => h.queryCount > 0);
	const chartHeight = 100;

	if (!hasData) {
		return (
			<div
				className="flex items-center justify-center"
				style={{ height: chartHeight, color: theme.colors.textDim }}
			>
				<span style={{ fontSize: 11 }}>No hourly data available</span>
			</div>
		);
	}

	return (
		<div>
			{/* Bars */}
			<div className="flex items-end gap-px" style={{ height: chartHeight }}>
				{hourlyPattern.map((h) => {
					const height = maxCount > 0 ? (h.queryCount / maxCount) * 100 : 0;
					const isPeak = h.hour === peakHour && h.queryCount > 0;
					const isHovered = hoveredHour === h.hour;

					return (
						<div
							key={h.hour}
							className="relative flex-1 flex flex-col justify-end cursor-default"
							style={{ minWidth: 0 }}
							onMouseEnter={() => setHoveredHour(h.hour)}
							onMouseLeave={() => setHoveredHour(null)}
						>
							<div
								className="w-full rounded-t transition-all duration-200"
								style={{
									height: `${Math.max(height, h.queryCount > 0 ? 2 : 0)}%`,
									backgroundColor: isPeak
										? theme.colors.accent
										: isHovered
											? `${theme.colors.accent}90`
											: `${theme.colors.accent}50`,
									transform: isHovered ? 'scaleY(1.05)' : 'scaleY(1)',
									transformOrigin: 'bottom',
								}}
							/>

							{/* Tooltip */}
							{isHovered && h.queryCount > 0 && (
								<div
									className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded text-xs whitespace-nowrap z-10"
									style={{
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors.textMain,
										border: `1px solid ${theme.colors.border}`,
										boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
									}}
								>
									<div style={{ fontWeight: 500 }}>{formatHour(h.hour)}</div>
									<div style={{ color: theme.colors.textDim }}>
										{h.queryCount} queries
									</div>
									{h.avgDurationMs > 0 && (
										<div style={{ color: theme.colors.textDim }}>
											Avg: {formatDurationMs(h.avgDurationMs)}
										</div>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* X-axis labels (every 4 hours) */}
			<div className="flex mt-1">
				{[0, 4, 8, 12, 16, 20].map((hour) => (
					<div
						key={hour}
						style={{
							width: `${(4 / 24) * 100}%`,
							color: theme.colors.textDim,
							fontSize: 9,
						}}
					>
						{formatHour(hour)}
					</div>
				))}
			</div>

			{/* Peak indicator */}
			<div className="mt-1 flex items-center gap-1" style={{ fontSize: 10 }}>
				<span style={{ color: theme.colors.textDim }}>Peak:</span>
				<span style={{ color: theme.colors.accent, fontWeight: 500 }}>
					{formatHour(peakHour)}
				</span>
			</div>
		</div>
	);
}

// ============================================================================
// Chart 4: Token Breakdown (horizontal stacked bar)
// ============================================================================

function TokenBreakdownChart({
	theme,
	tokenBreakdown,
}: {
	theme: Theme;
	tokenBreakdown: ProviderDetail['tokenBreakdown'];
}) {
	const segments = useMemo(() => {
		const items = [
			{
				label: 'Input',
				tokens: tokenBreakdown.inputTokens,
				cost: tokenBreakdown.inputCostUsd,
				color: theme.colors.accent,
			},
			{
				label: 'Output',
				tokens: tokenBreakdown.outputTokens,
				cost: tokenBreakdown.outputCostUsd,
				color: theme.colors.success,
			},
			{
				label: 'Cache Read',
				tokens: tokenBreakdown.cacheReadTokens,
				cost: tokenBreakdown.cacheReadCostUsd,
				color: theme.colors.warning,
			},
			{
				label: 'Cache Write',
				tokens: tokenBreakdown.cacheCreationTokens,
				cost: tokenBreakdown.cacheCreationCostUsd,
				color: '#8b5cf6', // purple
			},
		];

		const totalTokens = items.reduce((sum, s) => sum + s.tokens, 0);
		return items.map((s) => ({
			...s,
			percent: totalTokens > 0 ? (s.tokens / totalTokens) * 100 : 0,
		}));
	}, [tokenBreakdown, theme]);

	const totalTokens = segments.reduce((sum, s) => sum + s.tokens, 0);

	if (totalTokens === 0) {
		return (
			<div
				className="flex items-center justify-center"
				style={{ height: 80, color: theme.colors.textDim }}
			>
				<span style={{ fontSize: 11 }}>No token data available</span>
			</div>
		);
	}

	return (
		<div>
			{/* Stacked bar */}
			<div
				className="flex rounded overflow-hidden"
				style={{ height: 20, backgroundColor: theme.colors.bgActivity }}
			>
				{segments.map((seg) =>
					seg.percent > 0 ? (
						<div
							key={seg.label}
							style={{
								width: `${seg.percent}%`,
								backgroundColor: seg.color,
								opacity: 0.85,
								minWidth: seg.percent > 0 ? 2 : 0,
							}}
							title={`${seg.label}: ${formatTokenCount(seg.tokens)} (${seg.percent.toFixed(1)}%)`}
						/>
					) : null,
				)}
			</div>

			{/* Legend with costs */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(2, 1fr)',
					gap: '6px 12px',
					marginTop: 10,
				}}
			>
				{segments.map((seg) => (
					<div key={seg.label} className="flex items-center gap-1.5">
						<div
							style={{
								width: 8,
								height: 8,
								borderRadius: 2,
								backgroundColor: seg.color,
								opacity: 0.85,
								flexShrink: 0,
							}}
						/>
						<div style={{ fontSize: 10, minWidth: 0 }}>
							<span style={{ color: theme.colors.textMain }}>
								{seg.label}:
							</span>{' '}
							<span style={{ color: theme.colors.textDim }}>
								{formatTokenCount(seg.tokens)}
							</span>
							{seg.cost > 0 && (
								<span style={{ color: theme.colors.textDim }}>
									{' '}(${seg.cost.toFixed(2)})
								</span>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ============================================================================
// Chart 5: Source & Location Split (two donut charts)
// ============================================================================

function DonutChart({
	theme,
	slices,
	size = 64,
}: {
	theme: Theme;
	slices: Array<{ label: string; value: number; color: string }>;
	size?: number;
}) {
	const total = slices.reduce((sum, s) => sum + s.value, 0);
	const radius = size / 2 - 4;
	const innerRadius = radius * 0.55;
	const cx = size / 2;
	const cy = size / 2;

	if (total === 0) {
		return (
			<svg width={size} height={size}>
				<circle
					cx={cx}
					cy={cy}
					r={radius}
					fill="none"
					stroke={theme.colors.border}
					strokeWidth={radius - innerRadius}
					strokeOpacity={0.3}
				/>
			</svg>
		);
	}

	let currentAngle = -Math.PI / 2; // Start at top
	const arcs = slices.map((slice) => {
		const angle = (slice.value / total) * Math.PI * 2;
		const startAngle = currentAngle;
		const endAngle = currentAngle + angle;
		currentAngle = endAngle;

		const largeArcFlag = angle > Math.PI ? 1 : 0;
		const midRadius = (radius + innerRadius) / 2;
		const thickness = radius - innerRadius;

		const x1 = cx + midRadius * Math.cos(startAngle);
		const y1 = cy + midRadius * Math.sin(startAngle);
		const x2 = cx + midRadius * Math.cos(endAngle);
		const y2 = cy + midRadius * Math.sin(endAngle);

		// For a full circle (100%), use two arcs
		if (angle >= Math.PI * 2 - 0.01) {
			return (
				<circle
					key={slice.label}
					cx={cx}
					cy={cy}
					r={midRadius}
					fill="none"
					stroke={slice.color}
					strokeWidth={thickness}
					strokeOpacity={0.85}
				/>
			);
		}

		return (
			<path
				key={slice.label}
				d={`M ${x1} ${y1} A ${midRadius} ${midRadius} 0 ${largeArcFlag} 1 ${x2} ${y2}`}
				fill="none"
				stroke={slice.color}
				strokeWidth={thickness}
				strokeLinecap="round"
				strokeOpacity={0.85}
			/>
		);
	});

	return (
		<svg width={size} height={size}>
			{arcs}
		</svg>
	);
}

function SourceLocationSplitChart({
	theme,
	queriesBySource,
	queriesByLocation,
}: {
	theme: Theme;
	queriesBySource: ProviderDetail['queriesBySource'];
	queriesByLocation: ProviderDetail['queriesByLocation'];
}) {
	const sourceTotal = queriesBySource.user + queriesBySource.auto;
	const locationTotal = queriesByLocation.local + queriesByLocation.remote;

	const noData = sourceTotal === 0 && locationTotal === 0;

	if (noData) {
		return (
			<div
				className="flex items-center justify-center"
				style={{ height: 80, color: theme.colors.textDim }}
			>
				<span style={{ fontSize: 11 }}>No query data available</span>
			</div>
		);
	}

	return (
		<div className="flex items-start justify-around gap-4">
			{/* Source split */}
			<div className="flex flex-col items-center gap-1.5">
				<DonutChart
					theme={theme}
					slices={[
						{ label: 'User', value: queriesBySource.user, color: theme.colors.accent },
						{ label: 'Auto', value: queriesBySource.auto, color: theme.colors.warning },
					]}
				/>
				<div style={{ fontSize: 10, color: theme.colors.textDim, textAlign: 'center' }}>
					<div className="flex items-center gap-1 justify-center">
						<span
							style={{
								width: 6,
								height: 6,
								borderRadius: 1,
								backgroundColor: theme.colors.accent,
								display: 'inline-block',
							}}
						/>
						<span>{queriesBySource.user} user</span>
					</div>
					<div className="flex items-center gap-1 justify-center">
						<span
							style={{
								width: 6,
								height: 6,
								borderRadius: 1,
								backgroundColor: theme.colors.warning,
								display: 'inline-block',
							}}
						/>
						<span>{queriesBySource.auto} auto</span>
					</div>
				</div>
			</div>

			{/* Location split */}
			<div className="flex flex-col items-center gap-1.5">
				<DonutChart
					theme={theme}
					slices={[
						{ label: 'Local', value: queriesByLocation.local, color: theme.colors.success },
						{ label: 'Remote', value: queriesByLocation.remote, color: '#8b5cf6' },
					]}
				/>
				<div style={{ fontSize: 10, color: theme.colors.textDim, textAlign: 'center' }}>
					<div className="flex items-center gap-1 justify-center">
						<span
							style={{
								width: 6,
								height: 6,
								borderRadius: 1,
								backgroundColor: theme.colors.success,
								display: 'inline-block',
							}}
						/>
						<span>{queriesByLocation.local} local</span>
					</div>
					<div className="flex items-center gap-1 justify-center">
						<span
							style={{
								width: 6,
								height: 6,
								borderRadius: 1,
								backgroundColor: '#8b5cf6',
								display: 'inline-block',
							}}
						/>
						<span>{queriesByLocation.remote} remote</span>
					</div>
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// Main component
// ============================================================================

export function ProviderDetailCharts({ theme, detail }: ProviderDetailChartsProps) {
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: 'repeat(2, 1fr)',
				gap: 10,
			}}
		>
			{/* Chart 1: Query Volume Trend */}
			<ChartPanel theme={theme} title="Query Volume Trend">
				<QueryVolumeTrendChart
					theme={theme}
					dailyTrend={detail.dailyTrend}
				/>
			</ChartPanel>

			{/* Chart 2: Response Time Trend */}
			<ChartPanel theme={theme} title="Response Time Trend">
				<ResponseTimeTrendChart
					theme={theme}
					dailyTrend={detail.dailyTrend}
					p95ResponseTimeMs={detail.reliability.p95ResponseTimeMs}
				/>
			</ChartPanel>

			{/* Chart 3: Activity Heatmap */}
			<ChartPanel theme={theme} title="Activity by Hour">
				<ActivityHoursChart
					theme={theme}
					hourlyPattern={detail.hourlyPattern}
				/>
			</ChartPanel>

			{/* Chart 4: Token Breakdown */}
			<ChartPanel theme={theme} title="Token Breakdown">
				<TokenBreakdownChart
					theme={theme}
					tokenBreakdown={detail.tokenBreakdown}
				/>
			</ChartPanel>

			{/* Chart 5: Source & Location Split */}
			<ChartPanel theme={theme} title="Source & Location">
				<SourceLocationSplitChart
					theme={theme}
					queriesBySource={detail.queriesBySource}
					queriesByLocation={detail.queriesByLocation}
				/>
			</ChartPanel>
		</div>
	);
}

export default ProviderDetailCharts;
