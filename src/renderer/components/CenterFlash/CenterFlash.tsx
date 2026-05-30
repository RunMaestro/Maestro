/**
 * CenterFlash — single, app-wide center-screen flash overlay.
 *
 * Mounted once near the app root. Subscribes to centerFlashStore and renders
 * the active flash with a theme-tinted frosted-glass card, color-coded icon,
 * optional detail line, and an animated bottom progress bar.
 *
 * Color mapping (resolves through theme tokens so each theme renders distinctly):
 *   green  → theme.colors.success
 *   yellow → theme.colors.warning
 *   orange → fixed orange (#f97316), no theme token exists
 *   red    → theme.colors.error
 *   theme  → theme.colors.accent  (default; matches the active theme)
 *
 * Fire flashes via `notifyCenterFlash()` (or the `flashCopiedToClipboard()`
 * helper). Flashes are exclusive — a new one replaces the previous.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Info, AlertTriangle, AlertCircle, Sparkles, type LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import {
	useCenterFlashStore,
	type CenterFlash as CenterFlashData,
	type CenterFlashColor,
} from '../../stores/centerFlashStore';

interface CenterFlashProps {
	theme: Theme;
}

const ICON_FOR_COLOR: Record<CenterFlashColor, LucideIcon> = {
	green: Check,
	yellow: Info,
	orange: AlertTriangle,
	red: AlertCircle,
	theme: Sparkles,
};

/** Fallback orange — no theme defines this slot, so use a fixed warm orange. */
const ORANGE_HEX = '#f97316';

const ENTRANCE_MS = 180;
const EXIT_MS = 160;

function colorValue(color: CenterFlashColor, theme: Theme): string {
	switch (color) {
		case 'green':
			return theme.colors.success;
		case 'yellow':
			return theme.colors.warning;
		case 'orange':
			return ORANGE_HEX;
		case 'red':
			return theme.colors.error;
		case 'theme':
		default:
			return theme.colors.accent;
	}
}

export const CenterFlash = memo(function CenterFlash({ theme }: CenterFlashProps) {
	const active = useCenterFlashStore((s) => s.active);
	const [rendered, setRendered] = useState<CenterFlashData | null>(active);
	const [phase, setPhase] = useState<'enter' | 'visible' | 'exit'>('enter');
	const renderedRef = useRef<CenterFlashData | null>(active);

	useEffect(() => {
		if (active) {
			renderedRef.current = active;
			setRendered(active);
			setPhase('enter');
			// Next frame: transition to visible so CSS picks up the change
			const raf = requestAnimationFrame(() => setPhase('visible'));
			return () => cancelAnimationFrame(raf);
		}
		// Active cleared — play exit animation, then unmount
		if (!renderedRef.current) return;
		setPhase('exit');
		const t = setTimeout(() => {
			renderedRef.current = null;
			setRendered(null);
		}, EXIT_MS);
		return () => clearTimeout(t);
	}, [active]);

	if (!rendered) return null;

	const accent = colorValue(rendered.color, theme);
	const Icon = ICON_FOR_COLOR[rendered.color];
	const isVisible = phase === 'visible';

	// Themed look: layer the active theme's sidebar bg under an accent-tinted
	// overlay. The overlay is stronger for `theme` (so the theme color reads
	// clearly) and lighter for the four semantic colors (so the icon's color
	// carries the meaning without overwhelming the card).
	const overlayAlpha = rendered.color === 'theme' ? '24' : '14';

	return createPortal(
		<div
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className="fixed inset-0 flex items-center justify-center pointer-events-none"
			style={{ zIndex: 100001 }}
		>
			<div
				className="overflow-hidden rounded-2xl"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					backgroundImage: `linear-gradient(135deg, ${accent}${overlayAlpha} 0%, ${accent}08 100%)`,
					backdropFilter: 'blur(16px) saturate(160%)',
					WebkitBackdropFilter: 'blur(16px) saturate(160%)',
					border: `1px solid ${accent}66`,
					boxShadow: `0 24px 56px -12px ${accent}40, 0 0 0 1px ${theme.colors.border}55, 0 1px 0 0 ${accent}22 inset`,
					opacity: isVisible ? 1 : 0,
					transform: isVisible
						? 'scale(1) translateY(0)'
						: phase === 'enter'
							? 'scale(0.94) translateY(8px)'
							: 'scale(0.96) translateY(-2px)',
					transition: `opacity ${isVisible ? ENTRANCE_MS : EXIT_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), transform ${isVisible ? ENTRANCE_MS : EXIT_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
					minWidth: 260,
					maxWidth: 480,
				}}
			>
				<div className="flex items-center gap-3 px-5 py-4">
					<div
						className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-full"
						style={{
							backgroundColor: `${accent}26`,
							color: accent,
							boxShadow: `0 0 0 1px ${accent}33 inset`,
						}}
					>
						<Icon className="w-5 h-5" strokeWidth={2.5} />
					</div>
					<div className="flex-1 min-w-0">
						<div
							className="text-sm font-semibold"
							style={{ color: theme.colors.textMain, letterSpacing: '0.01em' }}
						>
							{rendered.message}
						</div>
						{rendered.detail && (
							<div
								className="text-xs font-mono mt-1 truncate"
								style={{ color: theme.colors.textDim }}
								title={rendered.detail}
							>
								{rendered.detail}
							</div>
						)}
					</div>
				</div>
				{rendered.duration > 0 && (
					<div
						className="h-[2px] origin-left"
						key={rendered.id}
						style={{
							backgroundColor: accent,
							width: '100%',
							animation: `centerFlashShrink ${rendered.duration}ms linear forwards`,
							opacity: isVisible ? 0.85 : 0,
						}}
					/>
				)}
			</div>
			<style>{`
				@keyframes centerFlashShrink {
					from { transform: scaleX(1); }
					to { transform: scaleX(0); }
				}
			`}</style>
		</div>,
		document.body
	);
});
