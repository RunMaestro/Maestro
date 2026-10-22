/**
 * GaugeLegend - the line under every Throughput Gauge style naming what it
 * measures: the metric, then (when the card does not show it once for all
 * three) whose output it counts.
 *
 * HTML rather than SVG text, so a long agent name truncates instead of running
 * off the card. Shared by all four styles so the line reads the same in each.
 * A style that already prints the metric name in its own face (the LCD) passes
 * no `label`, and the line carries only the caption.
 */

import { memo } from 'react';
import type { Theme } from '../../../types';

interface GaugeLegendProps {
	theme: Theme;
	label?: string;
	caption?: string;
}

export const GaugeLegend = memo(function GaugeLegend({ theme, label, caption }: GaugeLegendProps) {
	if (!label && !caption) return null;
	const title = [label, caption].filter(Boolean).join(', ');
	return (
		<div
			className="shrink-0 max-w-full truncate text-2xs leading-tight text-center"
			style={{ color: theme.colors.textDim }}
			title={title}
		>
			{label && (
				<span
					className="font-medium"
					style={{ color: theme.colors.textMain }}
					data-testid="throughput-gauge-label"
				>
					{label}
				</span>
			)}
			{label && caption && ', '}
			{caption && <span data-testid="throughput-gauge-caption">{caption}</span>}
		</div>
	);
});
