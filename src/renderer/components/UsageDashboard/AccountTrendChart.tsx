/**
 * AccountTrendChart - SVG line chart for daily token usage.
 * Supports full chart mode (axes, labels, tooltip) and compact sparkline mode.
 */

import React, { useState, useEffect, useMemo } from 'react';
import type { Theme } from '../../types';
import { formatTokenCount } from '../../hooks/useAccountUsage';

interface DailyUsage {
	date: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
	costUsd: number;
	queryCount: number;
}

interface AccountTrendChartProps {
	accountId: string;
	theme: Theme;
	days?: number;
	compact?: boolean;
	limitTokensPerWindow?: number;
}

export function AccountTrendChart({
	accountId,
	theme,
	days = 30,
	compact = false,
	limitTokensPerWindow,
}: AccountTrendChartProps) {
	const [data, setData] = useState<DailyUsage[]>([]);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await window.maestro.accounts.getDailyUsage(accountId, days);
				if (!cancelled) setData((result as DailyUsage[]) || []);
			} catch (err) {
				console.warn('[AccountTrendChart] Failed to fetch daily usage:', err);
			}
		})();
		return () => { cancelled = true; };
	}, [accountId, days]);

	const chart = useMemo(() => {
		const width = compact ? 120 : 560;
		const height = compact ? 24 : 160;
		const paddingLeft = compact ? 0 : 48;
		const paddingRight = compact ? 0 : 12;
		const paddingTop = compact ? 2 : 16;
		const paddingBottom = compact ? 2 : 24;
		const chartWidth = width - paddingLeft - paddingRight;
		const chartHeight = height - paddingTop - paddingBottom;
		const maxTokens = Math.max(...data.map(d => d.totalTokens), 1);
		const avgTokens = data.length > 0
			? data.reduce((s, d) => s + d.totalTokens, 0) / data.length
			: 0;

		const points = data.map((d, i) => {
			const x = paddingLeft + (data.length > 1 ? (i / (data.length - 1)) * chartWidth : chartWidth / 2);
			const y = paddingTop + chartHeight - (d.totalTokens / maxTokens) * chartHeight;
			return { x, y, data: d };
		});

		const linePoints = points.map(p => `${p.x},${p.y}`).join(' ');
		const areaPoints = `${points.map(p => `${p.x},${p.y}`).join(' ')} ${paddingLeft + chartWidth},${paddingTop + chartHeight} ${paddingLeft},${paddingTop + chartHeight}`;

		return { width, height, paddingLeft, paddingTop, paddingBottom, chartWidth, chartHeight, maxTokens, avgTokens, points, linePoints, areaPoints };
	}, [data, compact]);

	if (data.length === 0) {
		if (compact) {
			return <span style={{ color: theme.colors.textDim, fontSize: 10 }}>&mdash;</span>;
		}
		return (
			<div
				className="flex items-center justify-center text-xs"
				style={{ color: theme.colors.textDim, height: 160 }}
			>
				No usage data
			</div>
		);
	}

	// Compact sparkline mode
	if (compact) {
		return (
			<svg width={chart.width} height={chart.height} style={{ display: 'block' }}>
				<polygon points={chart.areaPoints} fill={theme.colors.accent + '20'} stroke="none" />
				<polyline
					points={chart.linePoints}
					fill="none"
					stroke={theme.colors.accent}
					strokeWidth={1.5}
					strokeLinejoin="round"
				/>
			</svg>
		);
	}

	// Full mode
	const avgY = chart.paddingTop + chart.chartHeight - (chart.avgTokens / chart.maxTokens) * chart.chartHeight;
	const hovered = hoveredIndex !== null ? chart.points[hoveredIndex] : null;

	// X-axis date labels (first, middle, last)
	const dateLabels: Array<{ x: number; label: string }> = [];
	if (data.length > 0) {
		const indices = [0, Math.floor(data.length / 2), data.length - 1];
		for (const idx of indices) {
			const d = data[idx];
			const parts = d.date.split('-');
			dateLabels.push({
				x: chart.points[idx].x,
				label: `${parseInt(parts[1])}/${parseInt(parts[2])}`,
			});
		}
	}

	return (
		<svg
			width={chart.width}
			height={chart.height}
			style={{ display: 'block' }}
			onMouseLeave={() => setHoveredIndex(null)}
		>
			{/* Area fill */}
			<polygon points={chart.areaPoints} fill={theme.colors.accent + '15'} stroke="none" />

			{/* Average line */}
			<line
				x1={chart.paddingLeft}
				x2={chart.paddingLeft + chart.chartWidth}
				y1={avgY}
				y2={avgY}
				stroke={theme.colors.textDim + '40'}
				strokeDasharray="4 4"
				strokeWidth={1}
			/>

			{/* Data line */}
			<polyline
				points={chart.linePoints}
				fill="none"
				stroke={theme.colors.accent}
				strokeWidth={2}
				strokeLinejoin="round"
				strokeLinecap="round"
			/>

			{/* Limit threshold line */}
			{limitTokensPerWindow != null && limitTokensPerWindow > 0 && (() => {
				const limitY = chart.paddingTop + chart.chartHeight - (limitTokensPerWindow / chart.maxTokens) * chart.chartHeight;
				if (limitY < chart.paddingTop) return null;
				return (
					<line
						x1={chart.paddingLeft}
						x2={chart.paddingLeft + chart.chartWidth}
						y1={limitY}
						y2={limitY}
						stroke={theme.colors.error + '60'}
						strokeDasharray="6 3"
						strokeWidth={1}
					/>
				);
			})()}

			{/* Y-axis labels */}
			<text x={chart.paddingLeft - 6} y={chart.paddingTop + 3} textAnchor="end" fontSize={9} fill={theme.colors.textDim}>
				{formatTokenCount(chart.maxTokens)}
			</text>
			<text x={chart.paddingLeft - 6} y={chart.paddingTop + chart.chartHeight} textAnchor="end" fontSize={9} fill={theme.colors.textDim}>
				0
			</text>

			{/* X-axis labels */}
			{dateLabels.map((dl, i) => (
				<text key={i} x={dl.x} y={chart.height - 2} textAnchor="middle" fontSize={9} fill={theme.colors.textDim}>
					{dl.label}
				</text>
			))}

			{/* Hover rects */}
			{chart.points.map((p, i) => (
				<rect
					key={i}
					x={p.x - chart.chartWidth / data.length / 2}
					y={chart.paddingTop}
					width={chart.chartWidth / data.length}
					height={chart.chartHeight}
					fill="transparent"
					onMouseEnter={() => setHoveredIndex(i)}
				/>
			))}

			{/* Hover dot + tooltip */}
			{hovered && hoveredIndex !== null && (
				<>
					<circle cx={hovered.x} cy={hovered.y} r={3} fill={theme.colors.accent} />
					<foreignObject
						x={Math.min(hovered.x - 55, chart.width - 120)}
						y={hovered.y > 60 ? hovered.y - 52 : hovered.y + 8}
						width={110}
						height={44}
					>
						<div
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
								borderRadius: 4,
								padding: '3px 6px',
								fontSize: 10,
								color: theme.colors.textMain,
								lineHeight: 1.4,
							}}
						>
							<div style={{ color: theme.colors.textDim }}>{hovered.data.date}</div>
							<div>{formatTokenCount(hovered.data.totalTokens)} tokens</div>
							<div>${hovered.data.costUsd.toFixed(2)}</div>
						</div>
					</foreignObject>
				</>
			)}
		</svg>
	);
}
