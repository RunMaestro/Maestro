import { useEffect, useState } from 'react';
import { isWebDesktop } from '../../utils/runtimeContext';

export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const;

function classify(width: number): Breakpoint {
	if (width >= BREAKPOINTS.xl) return 'xl';
	if (width >= BREAKPOINTS.lg) return 'lg';
	if (width >= BREAKPOINTS.md) return 'md';
	if (width >= BREAKPOINTS.sm) return 'sm';
	return 'xs';
}

/**
 * Tracks the current viewport breakpoint based on window.innerWidth.
 *
 * Returns one of xs / sm / md / lg / xl plus boolean helpers for the
 * common responsive predicates the layout cares about. Side-effect
 * publishes a `data-bp` attribute on `<html>` so plain-CSS rules can
 * react without props-drilling.
 */
export function useViewportBreakpoint() {
	const initial = typeof window === 'undefined' ? 'lg' : classify(window.innerWidth);
	// Publish the breakpoint synchronously during render so CSS rules that
	// branch on `:root[data-bp='xs']` apply before the first paint. Without
	// this, narrow viewports flash the desktop layout for one frame before
	// the useEffect below runs.
	if (typeof document !== 'undefined') {
		document.documentElement.setAttribute('data-bp', initial);
	}
	const [bp, setBp] = useState<Breakpoint>(initial);

	useEffect(() => {
		const update = () => {
			const next = classify(window.innerWidth);
			setBp((prev) => (prev === next ? prev : next));
			document.documentElement.setAttribute('data-bp', next);
		};
		update();
		window.addEventListener('resize', update);
		window.addEventListener('orientationchange', update);
		return () => {
			window.removeEventListener('resize', update);
			window.removeEventListener('orientationchange', update);
		};
	}, []);

	return {
		bp,
		isXs: bp === 'xs',
		isSm: bp === 'sm',
		isMdDown: bp === 'xs' || bp === 'sm' || bp === 'md',
		isMdUp: bp === 'md' || bp === 'lg' || bp === 'xl',
		isLgUp: bp === 'lg' || bp === 'xl',
		isNarrow: bp === 'xs' || bp === 'sm',
	};
}

/**
 * Phone layout: the web-desktop bundle at the xs breakpoint (< 640px), which
 * is a phone held upright. This is THE predicate for simplifying a surface on
 * a handheld - fewer controls, icon-only buttons, full-screen drawers, sheets
 * instead of anchored popovers - so every surface makes the same call and the
 * CSS twin `html[data-runtime='web-desktop'][data-bp='xs']` matches exactly
 * what this returns.
 *
 * It is viewport-driven on purpose, not pointer-driven: space is the
 * constraint, and a desktop browser squeezed to phone width gets the same
 * layout (which is also what makes it testable without touch emulation).
 * Touch-specific GESTURES (long-press for a menu, swipe to dismiss) gate on
 * `isCoarsePointer()` separately, because a tablet has a finger without being
 * short on room. The native Electron app never reports phone layout, however
 * narrow its window: it has a keyboard and a mouse, and its users chose that
 * width.
 */
export function usePhoneLayout(): boolean {
	const { isXs } = useViewportBreakpoint();
	return isXs && isWebDesktop();
}

/**
 * Non-hook twin of {@link usePhoneLayout} for event handlers and module code
 * that cannot call a hook. Reads the live viewport, so it agrees with the hook
 * at the moment it is called.
 */
export function isPhoneLayout(): boolean {
	if (typeof window === 'undefined') return false;
	return isWebDesktop() && classify(window.innerWidth) === 'xs';
}
