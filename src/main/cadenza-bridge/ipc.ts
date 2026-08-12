import { ipcMain } from 'electron';
import { getCadenzaHudWindow } from '../app-lifecycle';
import type { CadenzaIpcDependencies } from './types';

/**
 * Registers the two cadenza IPC listeners at module-eval time (not inside
 * setupIpcHandlers()) - matching the exact registration timing this code had
 * inline in main/index.ts. Do not fold these into the IPC bootstrap module,
 * that would change when they start listening.
 */
export function registerCadenzaIpcHandlers(deps: CadenzaIpcDependencies): void {
	// A `decision` cadenza's chosen option replies to the owning agent: inject the
	// value as a live prompt into that agent's session via the main renderer's
	// existing remote-command path (the same one `maestro-cli dispatch` uses). The
	// agent process is already spawned (with SSH if configured), so feeding its live
	// session inherits that transport - no new spawn, no separate SSH handling.
	ipcMain.on('cadenza-hud:decision', (_event, sessionId: string, message: string) => {
		// Same Concerto gate as the other cadenza entry points: with the flag off no
		// decision card can exist, so a decision arriving anyway must not inject a
		// prompt into a live agent session.
		if (deps.settingsStore.get('encoreFeatures')?.concerto !== true) return;
		const mainWindow = deps.getMainWindow();
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (!sessionId || !message) return;
		// force=true (5th arg): a decision card is answered mid-turn, so the owning
		// agent is busy by definition; without the force flag the renderer's busy
		// guard would silently drop the choice while the UI reports it was sent.
		mainWindow.webContents.send('remote:executeCommand', sessionId, message, 'ai', undefined, true);
	});

	// A chat "point" chip that targets a cadenza asks main to pulse it. Cadenzas live
	// in the HUD renderer (a separate window with its own store), so the flash must be
	// routed to whichever renderer actually holds the card: the HUD window when it's
	// up, otherwise the main window (the in-app fallback layer). Gated by Concerto so
	// it's inert when off (no cadenzas exist then anyway).
	ipcMain.on('cadenza:flash', (_event, id: string) => {
		if (!id) return;
		if (deps.settingsStore.get('encoreFeatures')?.concerto !== true) return;
		const hud = getCadenzaHudWindow();
		const mainWindow = deps.getMainWindow();
		const target = hud && !hud.isDestroyed() ? hud : mainWindow;
		if (target && !target.isDestroyed()) target.webContents.send('remote:cadenzaFlash', id);
	});
}
