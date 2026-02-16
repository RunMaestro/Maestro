/**
 * AccountTrendChart - SVG line chart for account token usage over time.
 * Supports full chart mode (axes, labels, tooltip, time range toggles)
 * and compact sparkline mode (with small pill toggles).
 *
 * Time ranges:
 *   - 24h: billing window history (~5-hour granularity)
 *   - 7d / 30d: daily aggregation
 *   - Monthly: monthly aggregation
 */

import { useState, useEffect, useMemo } from 'react';
import type { Theme } from '../../types';
import { formatTokenCount } from '../../hooks/useAccountUsage';

type TimeRange = '24h' | '7d' | '30d' | 'monthly';

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
	'24h': '24h',
	'7d': '7d',
	'30d': '30d',
	'monthly': 'Mo',
};

interface DataPoint {
	label: string;
	totalTokens: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}

interface AccountTrendChartProps {
	accountId: string;
	theme: Theme;
	/** Default time range to display */
	defaultRange?: TimeRange;
	compact?: boolean;
	limitTokensPerWindow?: number;
}

/**
 * Fetch data for the selected time range.
 * Returns a normalized array of DataPoint regardless of source.
 */
async function fetchRangeData(accountId: string, range: TimeRange): Promise<DataPoint[]> {
	if (range === '24h') {
		// Use billing window history (5-hour windows)
		const windows = await window.maestro.accounts.getWindowHistory(accountId, 10) as Array<{
			windowStart: number; windowEnd: number;
			inputTokens: number; outputTokens: number;
			cacheReadTokens: number; cacheCreationTokens: number;
			costUsd: number;
		}>;
		return (windows || []).map(w => {
			const d = new Date(w.windowStart);
			const hours = d.getHours();
			const label = `${d.getMonth() + 1}/${d.getDate()} ${hours}:00`;
			return {
				label,
				totalTokens: w.inputTokens + w.outputTokens + w.cacheReadTokens + w.cacheCreationTokens,
				costUsd: w.costUsd,
				inputTokens: w.inputTokens,
				outputTokens: w.outputTokens,
				cacheReadTokens: w.cacheReadTokens,
				cacheCreationTokens: w.cacheCreationTokens,
			};
		});
	}

	if (range === 'monthly') {
		const monthly = await window.maestro.accounts.getMonthlyUsage(accountId, 6) as Array<{
			month: string;
			inputTokens: number; outputTokens: number;
			cacheReadTokens: number; cacheCreationTokens: number;
			totalTokens: number; costUsd: number;
		}>;
		return (monthly || []).map(m => ({
			label: m.month,
			totalTokens: m.totalTokens,
			costUsd: m.costUsd,
			inputTokens: m.inputTokens,
			outputTokens: m.outputTokens,
			cacheReadTokens: m.cacheReadTokens,
			cacheCreationTokens: m.cacheCreationTokens,
		}));
	}

	// 7d or 30d — daily aggregation
	const days = range === '7d' ? 7 : 30;
	const daily = await window.maestro.accounts.getDailyUsage(accountId, days) as Array<{
		date: string;
		inputTokens: number; outputTokens: number;
		cacheReadTokens: number; cacheCreationTokens: number;
		totalTokens: number; costUsd: number;
	}>;
	return (daily || []).map(d => ({
		label: d.date,
		totalTokens: d.totalTokens,
		costUsd: d.costUsd,
		inputTokens: d.inputTokens,
		outputTokens: d.outputTokens,
		cacheReadTokens: d.cacheReadTokens,
		cacheCreationTokens: d.cacheCreationTokens,
	}));
}

/** Format label for x-axis display based on time range */
function formatXLabel(label: string, range: TimeRange): string {
	if (range === '24h') {
		// Already formatted as "M/D HH:00"
		return label;
	}
	if (range === 'monthly') {
		// "YYYY-MM" → "Jan 26"
		const [year, month] = label.split('-');
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${months[parseInt(month, 10) - 1]} ${year.slice(2)}`;
	}
	// Daily: "YYYY-MM-DD" → "M/D"
	const parts = label.split('-');
	return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

export function AccountTrendChart({
	accountId,
	theme,
	defaultRange = '7d',
	compact = false,
	limitTokensPerWindow,
}: AccountTrendChartProps) {
	const [range, setRange] = useState<TimeRange>(defaultRange);
	const [data, setData] = useState<DataPoint[]>([]);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await fetchRangeData(accountId, range);
				if (!cancelled) setData(result);
			} catch (err) {
				console.warn('[AccountTrendChart] Failed to fetch usage data:', err);
			}
		})();
		return () => { cancelled = true; };
	}, [accountId, range]);

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

	const rangeToggle = (small: boolean) => (
		<div className={`flex gap-${small ? '0.5' : '1'} ${small ? 'mb-0.5' : 'mb-2'}`}>
			{(Object.keys(TIME_RANGE_LABELS) as TimeRange[]).map(r => (
				<button
					key={r}
					onClick={() => setRange(r)}
					className={`${small ? 'text-[8px] px-1 py-0' : 'text-[10px] px-1.5 py-0.5'} rounded ${range === r ? 'font-bold' : ''}`}
					style={{
						backgroundColor: range === r ? theme.colors.accent + '20' : 'transparent',
						color: range === r ? theme.colors.accent : theme.colors.textDim,
					}}
				>
					{TIME_RANGE_LABELS[r]}
				</button>
			))}
		</div>
	);

	if (data.length === 0) {
		if (compact) {
			return (
				<div>
					{rangeToggle(true)}
					<span style={{ color: theme.colors.textDim, fontSize: 10 }}>&mdash;</span>
				</div>
			);
		}
		return (
			<div>
				{rangeToggle(false)}
				<div
					className="flex items-center justify-center text-xs"
					style={{ color: theme.colors.textDim, height: 160 }}
				>
					No usage data
				</div>
			</div>
		);
	}

	// Compact sparkline mode
	if (compact) {
		return (
			<div>
				{rangeToggle(true)}
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
			</div>
		);
	}

	// Full mode
	const avgY = chart.paddingTop + chart.chartHeight - (chart.avgTokens / chart.maxTokens) * chart.chartHeight;
	const hovered = hoveredIndex !== null ? chart.points[hoveredIndex] : null;

	// X-axis date labels (first, middle, last)
	const dateLabels: Array<{ x: number; label: string }> = [];
	if (data.length > 0) {
		const indices = data.length <= 2
			? data.map((_, i) => i)
			: [0, Math.floor(data.length / 2), data.length - 1];
		for (const idx of indices) {
			dateLabels.push({
				x: chart.points[idx].x,
				label: formatXLabel(data[idx].label, range),
			});
		}
	}

	return (
		<div>
			{rangeToggle(false)}
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
								<div style={{ color: theme.colors.textDim }}>{formatXLabel(hovered.data.label, range)}</div>
								<div>{formatTokenCount(hovered.data.totalTokens)} tokens</div>
								<div>${hovered.data.costUsd.toFixed(2)}</div>
							</div>
						</foreignObject>
					</>
				)}
			</svg>
		</div>
	);
}
