/**
 * useIsMobile hook for Maestro web interface
 *
 * Returns `true` when the viewport width is at or below the supplied breakpoint
 * (defaults to 768px, matching the legacy contract). Uses a debounced
 * `window.resize` listener so rapid resizes don't cascade into re-renders.
 *
 * @deprecated Prefer `useBreakpoint()` for new code — it exposes the full
 * tier (phone / tablet / desktop), viewport dimensions, and a short-viewport
 * flag rather than collapsing everything to a single boolean. Keeping the
 * original `<= 768px` default here preserves the historical layout decisions
 * of every existing call site that didn't pass an explicit threshold.
 */

import { useEffect, useRef, useState } from 'react';

/** Default breakpoint preserved from the pre-`useBreakpoint` implementation. */
const DEFAULT_BREAKPOINT = 768;

/** Debounce delay in milliseconds for resize events */
const DEBOUNCE_MS = 150;

function readWidth(): number {
	if (typeof window === 'undefined') return DEFAULT_BREAKPOINT + 1;
	return window.innerWidth;
}

/**
 * Returns `true` when `window.innerWidth <= breakpoint`.
 *
 * @param breakpoint - Maximum width (inclusive) considered "mobile".
 *   Defaults to 768 to match the legacy behavior of this hook.
 */
export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT): boolean {
	const [isMobile, setIsMobile] = useState<boolean>(() => readWidth() <= breakpoint);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		// Recompute synchronously on mount in case the SSR fallback differed.
		setIsMobile(readWidth() <= breakpoint);

		const handleResize = () => {
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				setIsMobile(readWidth() <= breakpoint);
			}, DEBOUNCE_MS);
		};

		window.addEventListener('resize', handleResize);
		return () => {
			window.removeEventListener('resize', handleResize);
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [breakpoint]);

	return isMobile;
}

export default useIsMobile;
