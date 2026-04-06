/**
 * useFocusAfterRender.ts
 *
 * A hook that focuses an element after render using a delayed setTimeout.
 * Replaces the common pattern: setTimeout(() => ref.current?.focus(), N)
 *
 * Common delays found in the codebase:
 * - 0ms: immediate focus after paint (18 instances)
 * - 50ms: modal/overlay focus after animation (21 instances)
 * - 100ms: complex layout focus (4 instances)
 */

import { useEffect, useRef } from 'react';

/**
 * Focuses a ref'd element after render with an optional delay.
 *
 * @param ref - React ref pointing to a focusable element
 * @param shouldFocus - Whether to focus (default true). Set to false to conditionally skip.
 * @param delay - Delay in ms before focusing (default 0)
 */
export function useFocusAfterRender(
	ref: React.RefObject<HTMLElement | null>,
	shouldFocus: boolean = true,
	delay: number = 0
): void {
	// Track the latest shouldFocus value to avoid stale closures in the timeout
	const shouldFocusRef = useRef(shouldFocus);
	shouldFocusRef.current = shouldFocus;

	useEffect(() => {
		if (!shouldFocus) return;

		const timer = setTimeout(() => {
			if (shouldFocusRef.current) {
				ref.current?.focus();
			}
		}, delay);

		return () => {
			clearTimeout(timer);
		};
	}, [ref, shouldFocus, delay]);
}
