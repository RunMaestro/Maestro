import { deliverCadenzaToHud } from '../app-lifecycle';
import type { CadenzaBridgeDependencies } from './types';

/**
 * Route a cadenza payload to the HUD window (creating it lazily). Returns
 * false when there's no main window to parent it, so the caller can fall back
 * to the in-app renderer.
 */
export function createCadenzaDelivery(deps: CadenzaBridgeDependencies) {
	const deliverCadenza = (payload: Parameters<typeof deliverCadenzaToHud>[2]): boolean => {
		const mainWindow = deps.getMainWindow();
		if (!mainWindow) return false;
		// Concerto is an opt-in Encore feature: don't spawn the HUD window (or
		// route anything) unless the user enabled it in Extensions.
		if (deps.settingsStore.get('encoreFeatures')?.concerto !== true) return false;
		// The HUD window has no session store, so resolve the owning agent's display
		// name here (for the "opened by X" attribution chip) and stamp it on.
		let stamped = payload;
		if (payload.sessionId && !payload.sourceAgent) {
			const sessions = deps.sessionsStore.get('sessions', []) as Array<{
				id?: string;
				name?: string;
			}>;
			const sourceAgent = sessions.find((s) => s.id === payload.sessionId)?.name;
			if (sourceAgent) stamped = { ...payload, sourceAgent };
		}
		return deliverCadenzaToHud(mainWindow, deps.cadenzaHudDeps, stamped);
	};

	return { deliverCadenza };
}
