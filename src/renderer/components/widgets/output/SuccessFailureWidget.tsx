/**
 * SuccessFailureWidget
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. Renders a
 * success-vs-failure split: a headline success-rate percentage, a single split
 * bar (green success / red failure) following the status color language, and a
 * legend with each count. All data arrives through props.
 */

import { memo } from 'react';
import { formatNumber } from '../../../../shared/formatters';
import type { WidgetProps } from '../types';

interface SuccessFailureWidgetProps extends WidgetProps {
	/** Count of entries that succeeded. */
	successCount: number;
	/** Count of entries that failed. */
	failureCount: number;
	/** Segment colors. Defaults to the theme success/error (green/red) language. */
	colors?: { success: string; failure: string };
	/** Empty-state label shown when there are no recorded outcomes. */
	emptyLabel?: string;
}

export const SuccessFailureWidget = memo(function SuccessFailureWidget({
	theme,
	successCount,
	failureCount,
	colors,
	emptyLabel = 'No success/failure outcomes in this window',
}: SuccessFailureWidgetProps) {
	const successColor = colors?.success ?? theme.colors.success;
	const failureColor = colors?.failure ?? theme.colors.error;

	const total = successCount + failureCount;

	if (total <= 0) {
		return (
			<div className="text-xs py-2" style={{ color: theme.colors.textDim }}>
				{emptyLabel}
			</div>
		);
	}

	const successPct = Math.round((successCount / total) * 100);
	const failurePct = 100 - successPct;

	return (
		<div className="flex flex-col gap-3">
			{/* Headline success rate */}
			<div className="flex items-baseline gap-2">
				<span className="text-2xl font-bold leading-none" style={{ color: successColor }}>
					{successPct}%
				</span>
				<span
					className="text-[11px] uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					success rate
				</span>
			</div>

			{/* Split bar */}
			<div
				className="flex h-2.5 w-full rounded-full overflow-hidden"
				style={{ backgroundColor: theme.colors.border }}
				role="img"
				aria-label={`${successCount} succeeded, ${failureCount} failed`}
			>
				{successCount > 0 && (
					<div style={{ flexGrow: successCount, backgroundColor: successColor }} />
				)}
				{failureCount > 0 && (
					<div style={{ flexGrow: failureCount, backgroundColor: failureColor }} />
				)}
			</div>

			{/* Legend */}
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-2 text-xs">
					<span
						className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
						style={{ backgroundColor: successColor }}
					/>
					<span className="flex-1" style={{ color: theme.colors.textDim }}>
						Success
					</span>
					<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
						{formatNumber(successCount)}
					</span>
					<span className="tabular-nums w-9 text-right" style={{ color: theme.colors.textDim }}>
						{successPct}%
					</span>
				</div>
				<div className="flex items-center gap-2 text-xs">
					<span
						className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
						style={{ backgroundColor: failureColor }}
					/>
					<span className="flex-1" style={{ color: theme.colors.textDim }}>
						Failure
					</span>
					<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
						{formatNumber(failureCount)}
					</span>
					<span className="tabular-nums w-9 text-right" style={{ color: theme.colors.textDim }}>
						{failurePct}%
					</span>
				</div>
			</div>
		</div>
	);
});

export default SuccessFailureWidget;
