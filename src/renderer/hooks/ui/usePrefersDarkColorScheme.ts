/**
 * usePrefersDarkColorScheme - whether this client's OS is in dark appearance.
 *
 * Reads `prefers-color-scheme` live, so a phone that flips to dark at sunset
 * re-renders without a reload. Each client answers for its own device: the
 * desktop window follows the computer, a browser on a phone follows the phone.
 */

import { useSyncExternalStore } from 'react';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function getMediaQuery(): MediaQueryList | null {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
	return window.matchMedia(DARK_QUERY);
}

function subscribe(onChange: () => void): () => void {
	const query = getMediaQuery();
	if (!query) return () => {};
	query.addEventListener('change', onChange);
	return () => query.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
	// No media query support reads as dark, the app's shipped default.
	return getMediaQuery()?.matches ?? true;
}

export function usePrefersDarkColorScheme(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
