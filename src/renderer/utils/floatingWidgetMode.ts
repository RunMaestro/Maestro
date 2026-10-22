/**
 * Whether this client can show a floating widget in its own desktop-level window.
 *
 * Every widget host (the Throughput Gauge, the media player, the code that
 * opens or mirrors either) branches on this one function, so the in-app and
 * windowed paths cannot drift. Two conditions: this is the Electron desktop
 * app, not the web-desktop browser bundle, which has no second OS window to
 * open; AND the preload exposed `window.maestro.floatingWidgets`.
 */

import { isWebDesktop } from './runtimeContext';

export function floatingWidgetsAvailable(): boolean {
	if (isWebDesktop()) return false;
	if (typeof window === 'undefined') return false;
	return !!window.maestro?.floatingWidgets;
}
