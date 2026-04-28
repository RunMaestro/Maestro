/**
 * useBreakpoint hook for Maestro web interface
 *
 * Reports the current viewport tier (`phone` / `tablet` / `desktop`) along
 * with width, height, and convenience booleans. Tier boundaries come from
 * `BREAKPOINTS` in `src/web/mobile/constants.ts`, keeping this hook, the
 * `--bp-*` CSS custom properties in `src/web/index.css`, and any Tailwind
 * media-query usage in lockstep.
 *
 * Uses a debounced resize listener (same pattern as `useIsMobile`) so rapid
 * resize events don't cause a cascade of re-renders.
 */

import { useState, useEffect, useRef } from 'react';

import { BREAKPOINTS, type BreakpointTier } from '../mobile/constants';

/** Debounce delay in milliseconds for resize events */
const DEBOUNCE_MS = 150;

/** Viewport height below which the UI should treat the screen as vertically cramped */
const SHORT_VIEWPORT_MAX_HEIGHT = 500;

export interface BreakpointState {
	/** Current tier based on viewport width */
	tier: BreakpointTier;
	/** Current viewport width in pixels */
	width: number;
	/** Current viewport height in pixels */
	height: number;
	/** True when `tier === 'phone'` (width < BREAKPOINTS.tablet) */
	isPhone: boolean;
	/** True when `tier === 'tablet'` (BREAKPOINTS.tablet <= width < BREAKPOINTS.desktop) */
	isTablet: boolean;
	/** True when `tier === 'desktop'` (width >= BREAKPOINTS.desktop) */
	isDesktop: boolean;
	/** True when viewport height is below `SHORT_VIEWPORT_MAX_HEIGHT` (500px) */
	isShortViewport: boolean;
}

function computeState(width: number, height: number): BreakpointState {
	const tier: BreakpointTier =
		width >= BREAKPOINTS.desktop ? 'desktop' : width >= BREAKPOINTS.tablet ? 'tablet' : 'phone';

	return {
		tier,
		width,
		height,
		isPhone: tier === 'phone',
		isTablet: tier === 'tablet',
		isDesktop: tier === 'desktop',
		isShortViewport: height < SHORT_VIEWPORT_MAX_HEIGHT,
	};
}

function readViewport(): { width: number; height: number } {
	if (typeof window === 'undefined') {
		return { width: BREAKPOINTS.desktop, height: 1024 };
	}
	return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Returns the current viewport tier and dimensions.
 *
 * Prefer this hook for any responsive decision in the web UI — it is the
 * single source of truth for tier boundaries. `useIsMobile` is a thin
 * wrapper retained for backward compatibility.
 */
export function useBreakpoint(): BreakpointState {
	const [state, setState] = useState<BreakpointState>(() => {
		const { width, height } = readViewport();
		return computeState(width, height);
	});
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const { width, height } = readViewport();
		setState(computeState(width, height));

		const handleResize = () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
			timerRef.current = setTimeout(() => {
				const next = readViewport();
				setState(computeState(next.width, next.height));
			}, DEBOUNCE_MS);
		};

		window.addEventListener('resize', handleResize);

		return () => {
			window.removeEventListener('resize', handleResize);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	return state;
}

export default useBreakpoint;
