/**
 * ChartSkeletons
 *
 * Loading skeleton components for Usage Dashboard charts.
 * Provides visual placeholders that match the approximate size and structure
 * of each chart component while data is loading.
 *
 * Features:
 * - Theme-aware styling with subtle animations
 * - Matches approximate chart dimensions
 * - Shimmer animation effect using CSS
 * - Reduced motion support for accessibility
 */

import React from 'react';
import type { Theme } from '../../types';

interface SkeletonProps {
	theme: Theme;
}

/**
 * Base skeleton element with shimmer animation
 */
function SkeletonBox({
	theme,
	className = '',
	style = {},
}: SkeletonProps & { className?: string; style?: React.CSSProperties }) {
	return (
		<div
			className={`rounded ${className}`}
			style={{
				backgroundColor: theme.colors.border,
				opacity: 0.3,
				animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				...style,
			}}
			data-testid="skeleton-box"
		/>
	);
}

/**
 * Summary Cards skeleton - 5 cards in a row
 */
export function SummaryCardsSkeleton({ theme, columns = 5 }: SkeletonProps & { columns?: number }) {
	return (
		<div
			className="grid gap-4"
			style={{
				gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
			}}
			data-testid="summary-cards-skeleton"
		>
			{Array.from({ length: 5 }).map((_, i) => (
				<div
					key={i}
					className="p-4 rounded-lg flex items-start gap-3"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					{/* Icon placeholder */}
					<SkeletonBox theme={theme} style={{ width: 36, height: 36, flexShrink: 0 }} />
					<div className="flex-1 min-w-0">
						{/* Label placeholder */}
						<SkeletonBox theme={theme} style={{ width: '60%', height: 12, marginBottom: 8 }} />
						{/* Value placeholder */}
						<SkeletonBox theme={theme} style={{ width: '80%', height: 28 }} />
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * Agent Comparison Chart skeleton - horizontal bar chart layout
 */
export function AgentComparisonChartSkeleton({ theme }: SkeletonProps) {
	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="agent-comparison-skeleton"
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<SkeletonBox theme={theme} style={{ width: 140, height: 16 }} />
				<SkeletonBox theme={theme} style={{ width: 100, height: 28 }} />
			</div>

			{/* Bar chart bars */}
			<div className="space-y-2">
				{[85, 60, 45, 30].map((width, i) => (
					<div key={i} className="flex items-center gap-3" style={{ height: 28 }}>
						{/* Agent name */}
						<SkeletonBox theme={theme} style={{ width: 112, height: 14, flexShrink: 0 }} />
						{/* Bar */}
						<div className="flex-1">
							<SkeletonBox theme={theme} style={{ width: `${width}%`, height: 28 }} />
						</div>
						{/* Value */}
						<SkeletonBox theme={theme} style={{ width: 48, height: 14, flexShrink: 0 }} />
					</div>
				))}
			</div>

			{/* Legend */}
			<div className="flex gap-3 mt-4 pt-3 border-t" style={{ borderColor: theme.colors.border }}>
				{[40, 50, 35, 45].map((width, i) => (
					<div key={i} className="flex items-center gap-1.5">
						<SkeletonBox theme={theme} style={{ width: 10, height: 10 }} />
						<SkeletonBox theme={theme} style={{ width, height: 12 }} />
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Source Distribution Chart skeleton - pie/donut chart layout
 */
export function SourceDistributionChartSkeleton({ theme }: SkeletonProps) {
	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="source-distribution-skeleton"
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<SkeletonBox theme={theme} style={{ width: 160, height: 16 }} />
			</div>

			{/* Chart area with circular placeholder */}
			<div className="flex items-center justify-center" style={{ height: 180 }}>
				<div
					className="rounded-full"
					style={{
						width: 140,
						height: 140,
						backgroundColor: theme.colors.border,
						opacity: 0.3,
						animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
					}}
					data-testid="skeleton-circle"
				/>
			</div>

			{/* Legend */}
			<div className="flex justify-center gap-6 mt-4">
				{[60, 50].map((width, i) => (
					<div key={i} className="flex items-center gap-2">
						<SkeletonBox theme={theme} style={{ width: 12, height: 12 }} />
						<SkeletonBox theme={theme} style={{ width, height: 14 }} />
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Activity Heatmap skeleton - grid of cells
 */
export function ActivityHeatmapSkeleton({ theme }: SkeletonProps) {
	const cellSize = 12;
	const cellGap = 3;
	const rows = 7; // Days of week
	const cols = 12; // Approximate weeks to show

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="activity-heatmap-skeleton"
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<SkeletonBox theme={theme} style={{ width: 130, height: 16 }} />
				<SkeletonBox theme={theme} style={{ width: 100, height: 28 }} />
			</div>

			{/* Heatmap grid */}
			<div className="flex">
				{/* Day labels */}
				<div
					className="flex flex-col justify-between pr-2"
					style={{ height: rows * (cellSize + cellGap) - cellGap }}
				>
					{Array.from({ length: rows }).map((_, i) => (
						<SkeletonBox
							key={i}
							theme={theme}
							style={{
								width: 20,
								height: cellSize,
								visibility: i % 2 === 1 ? 'visible' : 'hidden',
							}}
						/>
					))}
				</div>

				{/* Grid cells */}
				<div className="flex" style={{ gap: cellGap }}>
					{Array.from({ length: cols }).map((_, weekIdx) => (
						<div key={weekIdx} className="flex flex-col" style={{ gap: cellGap }}>
							{Array.from({ length: rows }).map((_, dayIdx) => (
								<SkeletonBox
									key={dayIdx}
									theme={theme}
									className="rounded-sm"
									style={{
										width: cellSize,
										height: cellSize,
										// Vary opacity slightly for visual interest
										opacity: 0.2 + Math.random() * 0.15,
									}}
								/>
							))}
						</div>
					))}
				</div>
			</div>

			{/* Legend */}
			<div className="flex items-center justify-end gap-2 mt-3">
				<SkeletonBox theme={theme} style={{ width: 30, height: 12 }} />
				{Array.from({ length: 5 }).map((_, i) => (
					<SkeletonBox
						key={i}
						theme={theme}
						className="rounded-sm"
						style={{
							width: cellSize,
							height: cellSize,
							opacity: 0.15 + i * 0.1,
						}}
					/>
				))}
				<SkeletonBox theme={theme} style={{ width: 30, height: 12 }} />
			</div>
		</div>
	);
}

/**
 * Duration Trends Chart skeleton - line/area chart layout
 */
export function DurationTrendsChartSkeleton({ theme }: SkeletonProps) {
	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="duration-trends-skeleton"
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<SkeletonBox theme={theme} style={{ width: 140, height: 16 }} />
				<SkeletonBox theme={theme} style={{ width: 100, height: 28 }} />
			</div>

			{/* Chart area */}
			<div className="flex">
				{/* Y-axis labels */}
				<div className="flex flex-col justify-between pr-2" style={{ height: 200 }}>
					{Array.from({ length: 5 }).map((_, i) => (
						<SkeletonBox key={i} theme={theme} style={{ width: 36, height: 12 }} />
					))}
				</div>

				{/* Chart area with wave-like skeleton */}
				<div className="flex-1 relative" style={{ height: 200 }}>
					{/* Gridlines placeholder */}
					{Array.from({ length: 4 }).map((_, i) => (
						<div
							key={i}
							className="absolute w-full"
							style={{
								top: `${25 * (i + 1)}%`,
								height: 1,
								backgroundColor: theme.colors.border,
								opacity: 0.2,
							}}
						/>
					))}

					{/* SVG wave placeholder */}
					<svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 100">
						<path
							d="M0 60 Q 10 40, 20 50 T 40 45 T 60 55 T 80 35 T 100 45 L 100 100 L 0 100 Z"
							fill={theme.colors.border}
							fillOpacity={0.2}
							style={{
								animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
							}}
						/>
					</svg>
				</div>
			</div>

			{/* X-axis labels */}
			<div className="flex justify-between mt-2 pl-10">
				{Array.from({ length: 6 }).map((_, i) => (
					<SkeletonBox key={i} theme={theme} style={{ width: 40, height: 12 }} />
				))}
			</div>
		</div>
	);
}

/**
 * Auto Run Stats skeleton - summary cards for Auto Run view
 */
export function AutoRunStatsSkeleton({ theme, columns = 6 }: SkeletonProps & { columns?: number }) {
	return (
		<div
			className="grid gap-4"
			style={{
				gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
			}}
			data-testid="autorun-stats-skeleton"
		>
			{Array.from({ length: 6 }).map((_, i) => (
				<div key={i} className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
					{/* Icon placeholder */}
					<SkeletonBox theme={theme} style={{ width: 32, height: 32, marginBottom: 12 }} />
					{/* Label */}
					<SkeletonBox theme={theme} style={{ width: '70%', height: 12, marginBottom: 8 }} />
					{/* Value */}
					<SkeletonBox theme={theme} style={{ width: '50%', height: 24 }} />
				</div>
			))}
		</div>
	);
}

/**
 * Full dashboard skeleton - combines all chart skeletons for initial load
 * Matches the overview layout of the actual dashboard
 */
export function DashboardSkeleton({
	theme,
	viewMode = 'overview',
	chartGridCols = 2,
	summaryCardsCols = 5,
	autoRunStatsCols = 6,
}: SkeletonProps & {
	viewMode?: 'overview' | 'agents' | 'activity' | 'autorun';
	chartGridCols?: number;
	summaryCardsCols?: number;
	autoRunStatsCols?: number;
}) {
	return (
		<div className="space-y-6" data-testid="dashboard-skeleton">
			{viewMode === 'overview' && (
				<>
					<SummaryCardsSkeleton theme={theme} columns={summaryCardsCols} />
					<div
						className="grid gap-6"
						style={{
							gridTemplateColumns: `repeat(${chartGridCols}, minmax(0, 1fr))`,
						}}
					>
						<AgentComparisonChartSkeleton theme={theme} />
						<SourceDistributionChartSkeleton theme={theme} />
					</div>
					<ActivityHeatmapSkeleton theme={theme} />
					<DurationTrendsChartSkeleton theme={theme} />
				</>
			)}

			{viewMode === 'agents' && <AgentComparisonChartSkeleton theme={theme} />}

			{viewMode === 'activity' && (
				<>
					<ActivityHeatmapSkeleton theme={theme} />
					<DurationTrendsChartSkeleton theme={theme} />
				</>
			)}

			{viewMode === 'autorun' && <AutoRunStatsSkeleton theme={theme} columns={autoRunStatsCols} />}
		</div>
	);
}

export default DashboardSkeleton;
