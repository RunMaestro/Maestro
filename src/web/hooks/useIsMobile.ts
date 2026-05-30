/**
 * useIsMobile hook for Maestro web interface
 *
 * Detects whether the viewport is at or below a mobile breakpoint (768px).
 * Uses a debounced resize listener to avoid excessive re-renders during
 * window resize drags.
 */

import { useState, useEffect, useRef } from 'react';

/** Default breakpoint in pixels — at or below this width is considered mobile */
const MOBILE_BREAKPOINT = 768;

/** Debounce delay in milliseconds for resize events */
const DEBOUNCE_MS = 150;

/**
 * Returns `true` when the viewport width is <= MOBILE_BREAKPOINT.
 *
 * The value is updated on window resize with a short debounce so that
 * rapid resize events (e.g. dragging a window edge) don't cause a
 * cascade of re-renders.
 */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT): boolean {
	const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		setIsMobile(window.innerWidth <= breakpoint);

		const handleResize = () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
			timerRef.current = setTimeout(() => {
				setIsMobile(window.innerWidth <= breakpoint);
			}, DEBOUNCE_MS);
		};

		window.addEventListener('resize', handleResize);

		return () => {
			window.removeEventListener('resize', handleResize);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, [breakpoint]);

	return isMobile;
}
