/**
 * usePluginFocusRequestListener.ts
 *
 * Applies main-side focus requests emitted by the plugin `sessions.focus` verb
 * (Agent Flow's node-jump, for one). The main process writes activeSessionId to
 * its own sessions store, but the renderer's Zustand `useSessionStore` is
 * canonical: it reads main's store only at startup and then flushes its own tree
 * back down, so a main-side write is both invisible to the live UI and clobbered
 * on the next persistence flush. This listener re-applies the jump through the
 * same canonical renderer helpers the rest of the app uses, so the visible
 * workspace actually moves.
 */

import { useEffect } from 'react';
import { updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { aiTabFocusFields } from '../../utils/tabHelpers';

export function usePluginFocusRequestListener(): void {
	useEffect(() => {
		const api = window.maestro?.sessions;
		if (!api?.onFocusRequest) return;
		const unsubscribe = api.onFocusRequest(({ sessionId, tabId }) => {
			if (!sessionId) return;
			// Guard against a stale request for a session the live store no longer
			// has: applying it would point activeSessionId at nothing.
			const exists = useSessionStore.getState().sessions.some((s) => s.id === sessionId);
			if (!exists) return;
			// Land on the target's AI tab via the shared helper (the main side mirrors
			// this same field set in pluginAiFocusFields), then activate the session.
			updateSessionWith(sessionId, (s) => ({ ...s, ...aiTabFocusFields(tabId) }));
			useSessionStore.getState().setActiveSessionId(sessionId);
		});
		return unsubscribe;
	}, []);
}
