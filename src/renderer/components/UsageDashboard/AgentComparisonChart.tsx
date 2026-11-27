/**
 * AgentComparisonChart ("Provider Comparison")
 *
 * Horizontal bars comparing providers over the selected range by query count,
 * total time, or average time per query. Each row prints the active measure;
 * the hover tooltip carries all three. Providers with worktree queries get a
 * striped second row from the per-query worktree flag.
 */

import { memo, useMemo, useCallback, useState, type MouseEvent } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';
import { readableTextOn } from '../../../shared/colorContrast';
import { BAR_CHART_GRID_CLASS, BAR_CHART_GRID_STYLE, BAR_CHART_ROW_STYLE } from './chartUtils';
import { ChartTooltip } from '../widgets';
import { buildProviderComparisonRows, type ComparisonMode } from './agentComparisonUtils';
import { MetricModeToggle, OVERVIEW_METRIC_LABELS, metricModeNoun } from './MetricModeToggle';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';

const MODES: readonly ComparisonMode[] = ['count', 'duration', 'average'];
const MODE_STORAGE_KEY = 'usageDashboard.providerComparison.metric';
const WORKTREE_STRIPES =
	'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 4px, transparent 4px 8px)';

interface AgentComparisonChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

function formatModeValue(mode: ComparisonMode, value: number): string {
	if (mode === 'count') return `${formatNumber(value)} ${value === 1 ? 'query' : 'queries'}`;
	if (mode === 'average') return `${formatDuration(value)} avg`;
	return formatDuration(value);
}

export const AgentComparisonChart = memo(function AgentComparisonChart({
	data,
	theme,
	colorBlindMode = false,
}: AgentComparisonChartProps) {
	const { value: mode, setValue: setMode } = usePersistedChoice(MODE_STORAGE_KEY, MODES, 'count');
	const [hoveredKey, setHoveredKey] = useState<string | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	const rows = useMemo(
		() => buildProviderComparisonRows({ data, mode, theme, colorBlindMode }),
		[data, mode, theme, colorBlindMode]
	);
	const maxValue = useMemo(() => Math.max(0, ...rows.map((row) => row.value)), [rows]);
	const hasWorktreeRows = rows.some((row) => row.isWorktree);
	const hovered = rows.find((row) => row.key === hoveredKey) ?? null;

	const handleMouseEnter = useCallback((key: string, event: MouseEvent<HTMLDivElement>) => {
		setHoveredKey(key);
		setTooltipPos({ x: event.clientX, y: event.clientY });
	}, []);
	const handleMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
		setTooltipPos({ x: event.clientX, y: event.clientY });
	}, []);
	const handleMouseLeave = useCallback(() => {
		setHoveredKey(null);
		setTooltipPos(null);
	}, []);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Provider comparison chart showing ${metricModeNoun(mode)} by provider. ${rows.length} rows displayed.`}
		>
			<div className="flex flex-wrap items-center justify-between gap-2 mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Provider Comparison
				</h3>
				<MetricModeToggle
					mode={mode}
					onChange={setMode}
					theme={theme}
					modes={[...MODES]}
					labels={OVERVIEW_METRIC_LABELS}
				/>
			</div>

			<div className="relative">
				{rows.length === 0 ? (
					<div
						className="flex items-center justify-center h-32 text-sm"
						style={{ color: theme.colors.textDim }}
					>
						No queries in this range
					</div>
				) : (
					<div
						className={BAR_CHART_GRID_CLASS}
						style={BAR_CHART_GRID_STYLE}
						role="list"
						aria-label="Provider usage data"
					>
						{rows.map((row) => {
							const barWidth = maxValue > 0 ? (row.value / maxValue) * 100 : 0;
							const isHovered = hoveredKey === row.key;
							const shareLabel = row.share === null ? null : `${row.share.toFixed(1)}%`;
							const inBar = shareLabel !== null && barWidth > 15;
							return (
								<div
									key={row.key}
									style={{ ...BAR_CHART_ROW_STYLE, height: 28 }}
									onMouseEnter={(event) => handleMouseEnter(row.key, event)}
									onMouseMove={handleMouseMove}
									onMouseLeave={handleMouseLeave}
									role="listitem"
									aria-label={`${row.label}: ${formatNumber(row.count)} ${
										row.count === 1 ? 'query' : 'queries'
									}, ${formatDuration(row.duration)} total, ${formatDuration(row.average)} average`}
								>
									<div
										className="text-sm truncate min-w-0"
										style={{ color: isHovered ? theme.colors.textMain : theme.colors.textDim }}
										title={row.label}
										data-testid="bar-chart-label"
									>
										{row.label}
									</div>

									<div
										className="h-full rounded overflow-hidden relative"
										style={{ backgroundColor: `${theme.colors.border}30` }}
										aria-hidden="true"
									>
										<div
											className="h-full rounded flex items-center"
											style={{
												width: `${Math.max(barWidth, 2)}%`,
												backgroundColor: row.color,
												opacity: row.isWorktree ? (isHovered ? 0.75 : 0.55) : isHovered ? 1 : 0.85,
												backgroundImage: row.isWorktree ? WORKTREE_STRIPES : undefined,
												transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
											}}
											data-testid="comparison-bar"
										>
											{inBar && (
												<span
													className="text-xs font-medium px-2"
													style={{ color: readableTextOn('#ffffff', [row.color]) }}
												>
													{shareLabel}
												</span>
											)}
										</div>
										{shareLabel !== null && !inBar && (
											<span
												className="absolute text-xs font-medium"
												style={{
													left: `calc(${barWidth}% + 4px)`,
													top: '50%',
													transform: 'translateY(-50%)',
													color: theme.colors.textDim,
												}}
											>
												{shareLabel}
											</span>
										)}
									</div>

									<div
										className="text-xs text-right font-medium whitespace-nowrap"
										style={{ color: theme.colors.textMain, minWidth: 80 }}
										data-testid="comparison-value"
									>
										{formatModeValue(mode, row.value)}
									</div>
								</div>
							);
						})}
					</div>
				)}

				{hovered && (
					<ChartTooltip
						anchor={tooltipPos}
						theme={theme}
						width={220}
						height={80}
						testId="provider-comparison-tooltip"
					>
						<div className="font-medium mb-1 flex items-center gap-2">
							<div className="w-2 h-2 rounded-full" style={{ backgroundColor: hovered.color }} />
							{hovered.label}
						</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>
								{formatNumber(hovered.count)} {hovered.count === 1 ? 'query' : 'queries'}
							</div>
							<div>{formatDuration(hovered.duration)} total</div>
							<div>{formatDuration(hovered.average)} per query</div>
						</div>
					</ChartTooltip>
				)}
			</div>

			{hasWorktreeRows && (
				<div
					className="flex items-center gap-1.5 mt-4 pt-3 border-t text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					data-testid="worktree-legend"
				>
					<div
						className="w-2.5 h-2.5 rounded-sm"
						style={{
							backgroundColor: theme.colors.textDim,
							opacity: 0.55,
							backgroundImage: WORKTREE_STRIPES,
						}}
					/>
					Striped rows are queries from worktree agents
				</div>
			)}
		</div>
	);
});

export default AgentComparisonChart;
