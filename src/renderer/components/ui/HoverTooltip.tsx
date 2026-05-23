/**
 * HoverTooltip - Instant, styled, viewport-aware hover tooltip.
 *
 * Wraps a single trigger element (typically a toolbar icon button) and renders
 * a portaled tooltip on hover. Positions below the trigger by default, flipping
 * above when the bottom of the viewport is too close. Horizontally clamped so
 * tooltips on the right-most buttons stay on-screen.
 *
 * Replaces the native `title=` attribute, which is slow to appear, unstyled,
 * and clipped by ancestors with `overflow:hidden`.
 */

import { useState, useRef, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types';

export interface HoverTooltipProps {
	/** Main label rendered in the tooltip. */
	label: ReactNode;
	/** Optional shortcut hint rendered in muted text after the label. */
	shortcut?: string;
	/** Single trigger element (button, link, etc.). */
	children: ReactNode;
	theme: Theme;
	/** Skip rendering the tooltip entirely. */
	disabled?: boolean;
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;

export function HoverTooltip({ label, shortcut, children, theme, disabled }: HoverTooltipProps) {
	const triggerRef = useRef<HTMLSpanElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

	useLayoutEffect(() => {
		if (!open || !triggerRef.current || !tooltipRef.current) {
			setPos(null);
			return;
		}
		const trigger = triggerRef.current.getBoundingClientRect();
		const tip = tooltipRef.current.getBoundingClientRect();
		const viewportW = window.innerWidth;
		const viewportH = window.innerHeight;

		// Prefer below; flip above if there isn't room below.
		let top = trigger.bottom + TRIGGER_GAP;
		if (top + tip.height + VIEWPORT_MARGIN > viewportH) {
			top = Math.max(VIEWPORT_MARGIN, trigger.top - TRIGGER_GAP - tip.height);
		}

		// Center horizontally on the trigger, then clamp to the viewport so
		// right-edge buttons don't push the tooltip off-screen.
		let left = trigger.left + trigger.width / 2 - tip.width / 2;
		if (left + tip.width + VIEWPORT_MARGIN > viewportW) {
			left = viewportW - tip.width - VIEWPORT_MARGIN;
		}
		if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

		setPos({ left, top });
	}, [open, label, shortcut]);

	if (disabled || !label) {
		return <>{children}</>;
	}

	const portalTarget = typeof document !== 'undefined' ? document.body : null;

	return (
		<>
			<span
				ref={triggerRef}
				className="inline-flex"
				onMouseEnter={() => setOpen(true)}
				onMouseLeave={() => setOpen(false)}
			>
				{children}
			</span>
			{open &&
				portalTarget &&
				createPortal(
					<div
						ref={tooltipRef}
						role="tooltip"
						className="fixed px-2 py-1 rounded text-[11px] whitespace-nowrap pointer-events-none shadow-lg flex items-center gap-2"
						style={{
							left: pos?.left ?? -9999,
							top: pos?.top ?? -9999,
							zIndex: 10000,
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
							opacity: pos ? 1 : 0,
							transition: 'opacity 80ms ease-out',
						}}
					>
						<span>{label}</span>
						{shortcut && (
							<span className="opacity-60" style={{ color: theme.colors.textDim }}>
								{shortcut}
							</span>
						)}
					</div>,
					portalTarget
				)}
		</>
	);
}

export default HoverTooltip;
