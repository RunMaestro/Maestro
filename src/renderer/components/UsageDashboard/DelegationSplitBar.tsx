/**
 * DelegationSplitBar
 *
 * One horizontal bar showing how a window of AI work divides into interactive
 * time, Auto Run time, and Cue time. Presentational only - every number arrives
 * through props.
 *
 * Segments are never dropped for being small: a 40-second Cue slice next to
 * three hours of chat still gets a hairline, because a category that vanishes
 * reads as "Cue recorded nothing" rather than "Cue is a rounding error here".
 */

import { memo } from 'react';
import type { Theme } from '../../types';
import type { DelegationTotals } from '../../../shared/delegation';
import { delegatedMs, interactiveMs, trackedMs } from '../../../shared/delegation';
import { formatDurationHuman } from '../../../shared/formatters';
import { delegationColors } from './delegationColors';

interface DelegationSplitBarProps {
	totals: DelegationTotals;
	theme: Theme;
	colorBlindMode?: boolean;
	/** Bar thickness in px. Defaults to the summary-card size. */
	height?: number;
	/** Render the three durations under the bar. */
	showLegend?: boolean;
	/** Merge Auto Run and Cue into one "Delegated" segment. */
	mergeDelegated?: boolean;
}

/** Minimum visible width for a non-zero segment, as a percentage of the bar. */
const HAIRLINE_PCT = 1.5;

export const DelegationSplitBar = memo(function DelegationSplitBar({
	totals,
	theme,
	colorBlindMode = false,
	height = 6,
	showLegend = false,
	mergeDelegated = false,
}: DelegationSplitBarProps) {
	const colors = delegationColors(theme, colorBlindMode);
	const total = trackedMs(totals);

	const rawSegments = mergeDelegated
		? [
				{
					key: 'interactive',
					label: 'Interactive',
					ms: interactiveMs(totals),
					color: colors.interactive,
				},
				{ key: 'delegated', label: 'Delegated', ms: delegatedMs(totals), color: colors.delegated },
			]
		: [
				{
					key: 'interactive',
					label: 'Interactive',
					ms: interactiveMs(totals),
					color: colors.interactive,
				},
				{ key: 'autoRun', label: 'Auto Run', ms: totals.autoRun.durationMs, color: colors.autoRun },
				{ key: 'cue', label: 'Cue', ms: totals.cue.durationMs, color: colors.cue },
			];

	const segments = rawSegments.map((segment) => ({
		...segment,
		percent: total > 0 ? (segment.ms / total) * 100 : 0,
	}));

	const present = segments.filter((segment) => segment.ms > 0);
	// Widths are re-normalized after any hairline promotion so the row still
	// sums to 100% and the last segment can't be pushed off the end.
	const rawWidthTotal = present.reduce(
		(sum, segment) => sum + Math.max(segment.percent, HAIRLINE_PCT),
		0
	);

	return (
		<div className="flex flex-col gap-1.5 w-full">
			<div
				className="flex w-full rounded-full overflow-hidden"
				style={{ height, backgroundColor: theme.colors.border }}
				role="img"
				aria-label={
					total > 0
						? segments
								.map((segment) => `${segment.label} ${Math.round(segment.percent)}%`)
								.join(', ')
						: 'No tracked AI time yet'
				}
			>
				{present.map((segment) => (
					<div
						key={segment.key}
						style={{
							width: `${(Math.max(segment.percent, HAIRLINE_PCT) / rawWidthTotal) * 100}%`,
							backgroundColor: segment.color,
							transition: 'width 400ms cubic-bezier(0.4, 0, 0.2, 1)',
						}}
						title={`${segment.label}: ${formatDurationHuman(segment.ms)} (${segment.percent.toFixed(1)}%)`}
					/>
				))}
			</div>

			{showLegend && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
					{segments.map((segment) => (
						<span key={segment.key} className="flex items-center gap-1">
							<span
								className="w-2 h-2 rounded-sm shrink-0"
								style={{ backgroundColor: segment.color }}
								aria-hidden="true"
							/>
							<span style={{ color: theme.colors.textDim }}>
								{segment.label} {formatDurationHuman(segment.ms)}
							</span>
						</span>
					))}
				</div>
			)}
		</div>
	);
});

export default DelegationSplitBar;
