/**
 * ChartTooltip
 *
 * Shared portal-based tooltip shell for the Usage Dashboard charts. All chart
 * tooltips were previously rendered inline as `position: fixed; z-50` siblings
 * of the chart, which works in isolation but suffers when an ancestor briefly
 * holds a non-`none` transform (e.g. during the section-enter animation): the
 * fixed element's containing block becomes that ancestor instead of the
 * viewport, shifting the tooltip far from the cursor and clipping it under
 * later siblings.
 *
 * Portaling to `document.body` puts the tooltip in the root stacking context
 * and the viewport-relative containing block, so coordinates always mean what
 * the caller expects. Combined with `clampTooltipToViewport`, the tooltip
 * stays close to the cursor and fully visible regardless of where the user
 * hovers in the chart.
 */

import { memo, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types';
import { clampTooltipToViewport } from './chartUtils';

interface ChartTooltipProps {
	/** Anchor point in viewport coords — typically the mouse cursor. `null` hides the tooltip. */
	anchor: { x: number; y: number } | null;
	theme: Theme;
	children: ReactNode;
	/** Approximate tooltip dimensions used for viewport clamping; tooltip can be wider/taller in
	 *  practice — these are just hints so we don't shove it under the right/bottom edge. */
	width?: number;
	height?: number;
	/** Offset (px) of the tooltip's bottom edge above the cursor. */
	offset?: number;
	/** Test id forwarded to the rendered tooltip element. */
	testId?: string;
}

/**
 * Render a tooltip anchored to the cursor, portaled to the document body.
 * Position auto-flips: prefer above-and-to-the-right of the cursor; fall back
 * to below if there's not enough room above.
 */
export const ChartTooltip = memo(function ChartTooltip({
	anchor,
	theme,
	children,
	width = 220,
	height = 70,
	offset = 12,
	testId,
}: ChartTooltipProps) {
	// Some test environments (jsdom) and the SSR path don't have document.body
	// at module-init time. Defer the portal target lookup until mount.
	const [body, setBody] = useState<HTMLElement | null>(null);
	useEffect(() => {
		setBody(typeof document !== 'undefined' ? document.body : null);
	}, []);

	if (!anchor || !body) return null;

	// Try to fit the tooltip above the cursor. If that would clamp to the top
	// margin (i.e. cursor is too close to the top), flip to below the cursor.
	const wantTop = anchor.y - offset - height;
	const useBelow = wantTop < 8;

	const { left, top } = clampTooltipToViewport({
		anchorX: anchor.x,
		anchorY: useBelow ? anchor.y + offset : anchor.y - offset,
		width,
		height,
		transform: useBelow ? 'bottom-center' : 'top-center',
	});

	return createPortal(
		<div
			className="fixed px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
			style={{
				left,
				top,
				zIndex: 10000,
				backgroundColor: theme.colors.bgActivity,
				color: theme.colors.textMain,
				border: `1px solid ${theme.colors.border}`,
			}}
			data-testid={testId}
		>
			{children}
		</div>,
		body
	);
});

export default ChartTooltip;
