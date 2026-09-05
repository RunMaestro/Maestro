/**
 * Where "which agent am I looking at?" is remembered.
 *
 * On the desktop that is `sessions:setActiveSessionId`, a field in the shared
 * sessions store. A web-desktop client runs the same renderer against the same
 * store, so it used to write there too - and since a browser tab reloads on
 * every refocus, the reload then restored whatever the DESKTOP had focused,
 * dropping the user back onto the desktop's agent and its tabs rather than the
 * one they had been working in (issue #1398). The agent itself was never lost;
 * only the pointer to it was, which is why it was still there in the Left Bar.
 *
 * Which agent a client has in front of it is per-client view state, not shared
 * workspace state, so web-desktop keeps it in its own `localStorage` instead.
 * The shared value is still read as the FIRST-VISIT fallback: a browser that has
 * never focused an agent should land where the desktop is, not on agent zero.
 */

import { isWebDesktop } from './runtimeContext';
import { safeLocalStorage } from './safeLocalStorage';

/** Storage key for a web-desktop client's own focused agent. */
export const WEB_ACTIVE_SESSION_STORAGE_KEY = 'maestro:web-desktop:activeSessionId';

/**
 * Remember the focused agent.
 *
 * A web-desktop client records its OWN choice locally AND still reports it to
 * the shared store: reading is what had to become per-client, not writing. The
 * shared value is what the plugin `session.activated` event and the CLI's notion
 * of the current agent are built on, so a browser user going quiet there would
 * be a second bug traded for the first.
 *
 * Fire-and-forget on both paths: if a write fails the only cost is that the next
 * load falls back to the first agent.
 */
export function persistActiveSessionId(id: string): void {
	if (isWebDesktop()) {
		safeLocalStorage()?.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, id);
	}
	void window.maestro?.sessions?.setActiveSessionId(id);
}

/**
 * The agent this client last focused, or `''` when it has never focused one.
 *
 * In web-desktop a missing local value falls through to the desktop's stored
 * agent so a first visit opens on something meaningful. The caller validates the
 * id against the restored agents before using it.
 */
export async function readPersistedActiveSessionId(): Promise<string> {
	if (isWebDesktop()) {
		const local = safeLocalStorage()?.getItem(WEB_ACTIVE_SESSION_STORAGE_KEY);
		if (local) return local;
	}
	return (await window.maestro?.sessions?.getActiveSessionId()) ?? '';
}
