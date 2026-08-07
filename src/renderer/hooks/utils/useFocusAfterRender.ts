/**
 * useFocusAfterRender.ts
 *
 * Hook that focuses a referenced element after the next render when a
 * condition is true. Uses a layout effect so focus happens synchronously
 * after the DOM is updated, with an optional delay via setTimeout.
 */

import { useEffect, useLayoutEffect, RefObject } from 'react';

/**
 * Default deferral for mount focus.
 *
 * A surface that opens a modal usually restores focus on its way out (a popover
 * hands focus back to its trigger, a palette unmounts its own input). Those run
 * in the same commit as the modal's mount, so a synchronous focus loses the
 * race. Deferring by a frame's worth of time lets the closing surface finish
 * first and leaves the caret where the user expects it.
 */
export const MOUNT_FOCUS_DELAY_MS = 50;

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

/**
 * Focuses `ref.current` once, when the host component mounts.
 *
 * Use this for the search/filter input of a modal that opens from a keyboard
 * shortcut, a popover menu, or the command palette: Maestro is keyboard-first,
 * so a modal must land with its input already focused. Unlike
 * {@link useFocusAfterRender} this does not re-assert focus on later renders,
 * so clicking a control inside the modal keeps its own focus.
 *
 * @param ref   - Ref pointing to the element to focus
 * @param delay - Deferral in ms (default {@link MOUNT_FOCUS_DELAY_MS}). Pass 0
 *                to focus synchronously after the mount commit.
 *
 * @example
 * useFocusOnMount(inputRef);
 */
export function useFocusOnMount(
	ref: RefObject<HTMLElement | null>,
	delay: number = MOUNT_FOCUS_DELAY_MS
): void {
	useEffect(() => {
		if (delay <= 0) {
			ref.current?.focus();
			return;
		}
		const id = setTimeout(() => {
			ref.current?.focus();
		}, delay);
		return () => clearTimeout(id);
		// `ref` is stable and `delay` is a constant at every call site, so this
		// runs exactly once per mount.
	}, [ref, delay]);
}
