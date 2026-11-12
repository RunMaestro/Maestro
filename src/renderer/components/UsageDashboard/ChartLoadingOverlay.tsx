/**
 * ChartLoadingOverlay
 *
 * Covers a chart's plot area while a metric's data is still being derived.
 *
 * The token series is parsed from every agent's on-disk transcripts, which can
 * take several seconds the first time. Without this, switching a chart to
 * "Tokens" renders a fully-drawn but all-zero chart - which reads as "you have
 * no token usage" rather than "still loading". The overlay makes the wait
 * explicit instead of showing a confidently wrong empty chart.
 *
 * Render inside the chart's existing `relative` container, after the SVG.
 */

import { memo } from 'react';
import type { Theme } from '../../types';
import { Spinner } from '../ui/Spinner';

interface ChartLoadingOverlayProps {
	/** When false the overlay renders nothing. */
	visible: boolean;
	theme: Theme;
	/** Short status line under the spinner. */
	message?: string;
}

export const ChartLoadingOverlay = memo(function ChartLoadingOverlay({
	visible,
	theme,
	message = 'Reading token usage from agent transcripts…',
}: ChartLoadingOverlayProps) {
	if (!visible) return null;

	return (
		<div
			className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded"
			// Semi-opaque rather than solid: the axes stay faintly visible, so the
			// chart reads as "filling in" instead of having been replaced.
			style={{ backgroundColor: `${theme.colors.bgMain}d9` }}
			role="status"
			aria-live="polite"
			data-testid="chart-loading-overlay"
		>
			<Spinner size={20} color={theme.colors.accent} ariaLabel="Loading chart data" />
			<span className="text-xs" style={{ color: theme.colors.textDim }}>
				{message}
			</span>
		</div>
	);
});
