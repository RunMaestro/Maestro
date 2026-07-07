/**
 * CadenzaHudRoot - "HUD mode" render entry for the cadenza desktop overlay.
 *
 * The main renderer bundle is reused: the main process loads it into a
 * transparent, always-on-top child window with `?cadenzaHud`, and main.tsx
 * mounts this instead of the full app. It renders only the cadenza cards (no
 * app chrome), themed to match the user's active theme, and receives cadenzas
 * over the same `remote:cadenza` bridge the in-app CadenzaLayer uses.
 *
 * Reusing the bundle (rather than a second Vite entry) is deliberate: the HUD
 * gets themes, the widget library, and the Markdown renderer for free. Theme
 * resolution is shared with the main app via useResolvedTheme (not re-derived)
 * so plugin themes resolve here too.
 */

import { useEffect } from 'react';
import { loadAllSettings } from './stores/settingsStore';
import { useResolvedTheme } from './hooks/ui/useResolvedTheme';
import { CadenzaLayer } from './components/Cadenza';
import { applyCadenzaPayload, useCadenzaStore } from './stores/cadenzaStore';

export function CadenzaHudRoot() {
	// The HUD window boots its own renderer context, so hydrate settings here (for
	// the active theme) - the full app isn't mounted to do it for us. We keep this
	// minimal load rather than useSettings, which also applies main-window-only
	// side effects (font scaling, hotkey toasts) that don't belong in the HUD.
	useEffect(() => {
		void loadAllSettings();
	}, []);

	// Same bridge the in-app layer rides; events are routed to this window's
	// webContents by the main process (see cadenza HUD window wiring).
	useEffect(() => {
		const off = window.maestro?.process?.onRemoteCadenza?.((payload) => {
			applyCadenzaPayload(payload);
		});
		// A chat "point" chip flashes a cadenza; main routes it here since cadenzas
		// live in this HUD renderer.
		const offFlash = window.maestro?.process?.onRemoteCadenzaFlash?.((id) => {
			useCadenzaStore.getState().flashItem(id);
		});
		// Tell main the subscription is live so it can flush the cadenza that
		// triggered this (lazily created) window - otherwise the first one is lost.
		window.maestro?.process?.notifyCadenzaHudReady?.();
		return () => {
			off?.();
			offFlash?.();
		};
	}, []);

	// Click-through management lives in the main process (it polls the cursor
	// against card rects the CadenzaLayer reports). Doing hover detection here
	// would need `setIgnoreMouseEvents(forward)`, which is unsupported on Linux.

	const theme = useResolvedTheme();

	return <CadenzaLayer theme={theme} isHud />;
}
