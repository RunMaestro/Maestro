/**
 * usePrefersReducedMotion - the OS "reduce motion" setting, as a live boolean.
 *
 * Reactive rather than a one-shot read: the setting can be changed while the app
 * is running, and the surfaces that care about it (a voice HUD that would
 * otherwise animate for as long as it is on screen) are exactly the ones a user
 * would turn it off in the middle of. An imperative
 * `matchMedia(...).matches` read is still fine for a one-shot decision like
 * "should this confetti burst fire"; this hook is for anything that keeps
 * rendering.
 *
 * Safe where `matchMedia` is missing (jsdom without a stub, older embedders):
 * it reports false, which means "animate", which is the pre-existing behaviour
 * everywhere this replaces.
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function query(): MediaQueryList | null {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
	return window.matchMedia(QUERY);
}

export function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(() => query()?.matches ?? false);

	useEffect(() => {
		const list = query();
		if (!list) return;
		const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
		// Re-read on subscribe: the value can have changed between the initial
		// state and this effect, and the listener only fires on the NEXT change.
		setReduced(list.matches);
		// Not `useEventListener`: that hook is window-scoped, and this listener
		// belongs to the MediaQueryList rather than to `window`.
		list.addEventListener('change', onChange);
		return () => list.removeEventListener('change', onChange);
	}, []);

	return reduced;
}

export default usePrefersReducedMotion;
