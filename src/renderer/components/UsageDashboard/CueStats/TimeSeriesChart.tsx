import { memo, useCallback, useMemo } from 'react';
import { format } from 'date-fns';
import type { Theme } from '../../../types';
import type { CueTimeBucket } from '../../../../shared/cue-stats-types';
import { formatNumber, formatTokensCompact } from '../../../../shared/formatters';
import { COLORBLIND_AGENT_PALETTE } from '../../../constants/colorblindPalettes';
import { usePhoneLayout } from '../../../hooks/ui/useViewportBreakpoint';
import { ChartTooltip } from '../../widgets';
import { computeAxisLabelIndices, PHONE_AXIS_LABELS } from '../chartUtils';
import { useBarChartFocus } from '../useBarChartFocus';

const CHART_WIDTH = 600;
const CHART_HEIGHT = 220;
const PADDING = { top: 20, right: 50, bottom: 40, left: 50 };
const INNER_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right;
const INNER_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom;

/**
 * Runs per bucket (bars, split into failed / completed) with tokens overlaid
 * as a line. The series arrives zero-filled from main, so every hour or day of
 * the range has a slot and quiet periods read as gaps.
 */
export const TimeSeriesChart = memo(function TimeSeriesChart({
	buckets,
	bucketSizeMs,
	theme,
	colorBlindMode,
	showTokens,
}: {
	buckets: CueTimeBucket[];
	bucketSizeMs: number;
	theme: Theme;
	colorBlindMode: boolean;
	/** Draw the token line and axis (false when the range has no token data). */
	showTokens: boolean;
}) {
	const phone = usePhoneLayout();
	const xLabelIndices = useMemo(
		() => computeAxisLabelIndices(buckets.length, phone ? PHONE_AXIS_LABELS : undefined),
		[buckets.length, phone]
	);

	const tokenColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[1] : theme.colors.accent;
	const barColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : `${theme.colors.accent}80`;
	const successColor = theme.colors.success;
	const failureColor = theme.colors.error;

	const { maxOccurrences, maxTokens, occurrenceTicks, tokenTicks } = useMemo(() => {
		const maxOcc = Math.max(1, ...buckets.map((b) => b.occurrences));
		const maxTok = Math.max(1, ...buckets.map((b) => b.inputTokens + b.outputTokens));
		const tickCount = 5;
		return {
			maxOccurrences: maxOcc,
			maxTokens: maxTok,
			occurrenceTicks: Array.from({ length: tickCount }, (_, i) =>
				Math.round((maxOcc / (tickCount - 1)) * i)
			),
			tokenTicks: Array.from({ length: tickCount }, (_, i) => (maxTok / (tickCount - 1)) * i),
		};
	}, [buckets]);

	const slot = INNER_WIDTH / Math.max(buckets.length, 1);
	const xScale = useCallback((idx: number) => PADDING.left + (idx + 0.5) * slot, [slot]);
	const yScaleOcc = (value: number) =>
		CHART_HEIGHT - PADDING.bottom - (value / maxOccurrences) * INNER_HEIGHT;
	const yScaleTokens = (value: number) =>
		CHART_HEIGHT - PADDING.bottom - (value / maxTokens) * INNER_HEIGHT;

	const tokenLinePath = buckets
		.map(
			(b, idx) =>
				`${idx === 0 ? 'M' : 'L'} ${xScale(idx)} ${yScaleTokens(b.inputTokens + b.outputTokens)}`
		)
		.join(' ');

	const isHourly = bucketSizeMs <= 3_600_000;
	const labelFormat = isHourly ? 'MMM d HH:mm' : 'MMM d';
	const barWidth = Math.max(1, slot - (slot > 6 ? 4 : 1));

	const { activeIndex, anchor, containerProps, barProps } = useBarChartFocus(buckets.length, {
		// The SVG scales to its box, so map the bucket's viewBox x into it.
		slotCenter: (index, rect) => {
			const scale = rect.width / CHART_WIDTH;
			return { x: rect.left + xScale(index) * scale, y: rect.top + PADDING.top * scale };
		},
	});
	const active = activeIndex !== null ? buckets[activeIndex] : null;
	const describe = (b: CueTimeBucket) =>
		`${format(new Date(b.bucketStartMs), labelFormat)}: ${formatNumber(b.occurrences)} runs, ${formatNumber(b.successCount)} completed, ${formatNumber(b.failureCount)} failed${showTokens ? `, ${formatTokensCompact(b.inputTokens + b.outputTokens)} tokens` : ''}`;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-timeseries"
		>
			<div className="flex items-center justify-between mb-3 flex-wrap gap-2">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					{showTokens ? 'Runs & Tokens Over Time' : 'Runs Over Time'}
				</h3>
				<div className="flex items-center gap-3 text-xs" style={{ color: theme.colors.textDim }}>
					<span className="flex items-center gap-1">
						<span
							className="inline-block w-3 h-3 rounded-sm"
							style={{ backgroundColor: successColor }}
						/>
						Completed
					</span>
					<span className="flex items-center gap-1">
						<span
							className="inline-block w-3 h-3 rounded-sm"
							style={{ backgroundColor: failureColor }}
						/>
						Failed
					</span>
					{showTokens && (
						<span className="flex items-center gap-1">
							<span className="inline-block w-3 h-0.5" style={{ backgroundColor: tokenColor }} />
							Tokens
						</span>
					)}
				</div>
			</div>

			{buckets.length === 0 ? (
				<div
					className="flex items-center justify-center text-sm"
					style={{ height: CHART_HEIGHT, color: theme.colors.textDim }}
				>
					No runs in this range
				</div>
			) : (
				<svg
					{...containerProps}
					width="100%"
					viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
					preserveAspectRatio="xMidYMid meet"
					role="group"
					aria-label={`Cue runs${showTokens ? ' and tokens' : ''} over time, ${buckets.length} ${isHourly ? 'hours' : 'days'}`}
					className="outline-none rounded focus-visible:ring-2"
					data-testid="cue-stats-timeseries-chart"
				>
					{occurrenceTicks.map((tick, idx) => (
						<g key={`grid-${idx}`}>
							<line
								x1={PADDING.left}
								y1={yScaleOcc(tick)}
								x2={CHART_WIDTH - PADDING.right}
								y2={yScaleOcc(tick)}
								stroke={theme.colors.border}
								strokeOpacity={0.3}
								strokeDasharray="4,4"
							/>
							<text
								x={PADDING.left - 8}
								y={yScaleOcc(tick)}
								textAnchor="end"
								dominantBaseline="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{tick}
							</text>
						</g>
					))}

					{showTokens &&
						tokenTicks.map((tick, idx) => (
							<text
								key={`y-tok-${idx}`}
								x={CHART_WIDTH - PADDING.right + 8}
								y={yScaleTokens(tick)}
								textAnchor="start"
								dominantBaseline="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{formatTokensCompact(tick)}
							</text>
						))}

					{buckets.map((b, idx) => {
						const x = xScale(idx) - barWidth / 2;
						const y = yScaleOcc(b.occurrences);
						const height = Math.max(0, CHART_HEIGHT - PADDING.bottom - y);
						const failHeight = b.occurrences > 0 ? (height * b.failureCount) / b.occurrences : 0;
						const okHeight = b.occurrences > 0 ? (height * b.successCount) / b.occurrences : 0;
						const isActive = activeIndex === idx;
						return (
							<g
								key={`bar-${b.bucketStartMs}`}
								{...barProps(idx)}
								data-testid="cue-stats-time-bucket"
							>
								{/* Hit area spans the whole slot so thin bars are easy to hover. */}
								<rect
									x={PADDING.left + idx * slot}
									y={PADDING.top}
									width={slot}
									height={INNER_HEIGHT}
									fill="transparent"
								/>
								<rect
									x={x}
									y={y}
									width={barWidth}
									height={height}
									fill={barColor}
									opacity={isActive ? 1 : 0.85}
								/>
								{failHeight > 0 && (
									<rect
										x={x}
										y={y}
										width={barWidth}
										height={failHeight}
										fill={failureColor}
										opacity={0.55}
									/>
								)}
								{okHeight > 0 && (
									<rect
										x={x}
										y={y + failHeight}
										width={barWidth}
										height={okHeight}
										fill={successColor}
										opacity={0.4}
									/>
								)}
							</g>
						);
					})}

					{buckets.map((b, idx) =>
						xLabelIndices.has(idx) ? (
							<text
								key={`x-${b.bucketStartMs}`}
								x={xScale(idx)}
								y={CHART_HEIGHT - PADDING.bottom + 18}
								textAnchor="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{format(new Date(b.bucketStartMs), labelFormat)}
							</text>
						) : null
					)}

					{showTokens && (
						<path
							d={tokenLinePath}
							fill="none"
							stroke={tokenColor}
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
							pointerEvents="none"
						/>
					)}
				</svg>
			)}

			<span className="sr-only" aria-live="polite">
				{active ? describe(active) : ''}
			</span>
			{active && (
				<ChartTooltip anchor={anchor} theme={theme} testId="cue-stats-timeseries-tooltip">
					<div className="font-medium mb-1">
						{format(new Date(active.bucketStartMs), labelFormat)}
					</div>
					<div style={{ color: theme.colors.textDim }}>
						<div>{formatNumber(active.occurrences)} runs</div>
						<div>
							{formatNumber(active.successCount)} completed / {formatNumber(active.failureCount)}{' '}
							failed
						</div>
						{showTokens && (
							<div>{formatTokensCompact(active.inputTokens + active.outputTokens)} tokens</div>
						)}
					</div>
				</ChartTooltip>
			)}
		</div>
	);
});
