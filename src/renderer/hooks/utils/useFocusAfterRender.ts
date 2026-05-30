/**
 * useFocusAfterRender.ts
 *
 * Hook that focuses a referenced element after the next render when a
 * condition is true. Uses a layout effect so focus happens synchronously
 * after the DOM is updated, with an optional delay via setTimeout.
 */

import { useLayoutEffect, RefObject } from 'react';

/**
 * Focuses `ref.current` after the next render when `condition` is truthy.
 *
 * @param ref       - Ref pointing to the element to focus
 * @param condition - Focus is triggered only when this is true
 * @param delay     - Optional delay in milliseconds before focusing (default: 0)
 *
 * @example
 * useFocusAfterRender(inputRef, shouldFocusOnModeSwitch, 0);
 */
export function useFocusAfterRender(
	ref: RefObject<HTMLElement | null>,
	condition: boolean,
	delay: number = 0
): void {
	useLayoutEffect(() => {
		if (!condition) return;
		if (delay === 0) {
			ref.current?.focus();
			return;
		}
		const id = setTimeout(() => {
			ref.current?.focus();
		}, delay);
		return () => clearTimeout(id);
	});
}
