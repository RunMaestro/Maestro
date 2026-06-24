import { useEffect, useState } from 'react';

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
