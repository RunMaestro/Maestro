/**
 * Keyboard zoom for any surface driven by `useScalePreference`.
 *
 * `+` / `-` step the scale and `0` snaps it back, matching what every image
 * viewer and browser already trains the hand to do. `=` and `_` are the same
 * physical keys unshifted, so a user who does not reach for Shift still zooms
 * rather than doing nothing.
 *
 * Deliberately MODIFIER-FREE: Cmd/Ctrl +/- is the application's own zoom and
 * must keep working while a zoomable surface is open, so an event carrying any
 * modifier is left alone. Listening on `window` in the capture phase (rather
 * than on the surface's own node) keeps the keys working when focus has fallen
 * to the body - which is where it lands after a nested overlay closes - and
 * `stopPropagation` keeps a bare `0` or `-` out of the global shortcut handler.
 *
 * Pass `enabled: false` (typically `useIsTopLayer(...)`) while something is
 * open on top, or two surfaces answer the same keypress.
 *
 * The file preview binds the same keys inline instead, because its branch sits
 * inside one guarded key chain whose ordering decides which branch answers a
 * key. Every other surface should ride this hook rather than copy that branch.
 */

import { useEffect, useRef } from 'react';
import { isTextInputTarget } from '../../utils/messageScrollNavigation';
import type { UseScalePreferenceReturn } from './useScalePreference';

export interface UseScaleShortcutsOptions {
	/** Bind while true. Defaults to true. */
	enabled?: boolean;
}

export function useScaleShortcuts(
	control: UseScalePreferenceReturn,
	{ enabled = true }: UseScaleShortcutsOptions = {}
): void {
	// The control is rebuilt on every scale change; the listener is bound once.
	const controlRef = useRef(control);
	controlRef.current = control;

	useEffect(() => {
		if (!enabled) return;

		const handler = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (isTextInputTarget(e.target)) return;

			let handled = true;
			switch (e.key) {
				case '+':
				case '=':
					controlRef.current.adjustScale(1);
					break;
				case '-':
				case '_':
					controlRef.current.adjustScale(-1);
					break;
				case '0':
					controlRef.current.resetScale();
					break;
				default:
					handled = false;
			}

			if (handled) {
				e.preventDefault();
				e.stopPropagation();
			}
		};

		window.addEventListener('keydown', handler, { capture: true });
		return () => window.removeEventListener('keydown', handler, { capture: true });
	}, [enabled]);
}
