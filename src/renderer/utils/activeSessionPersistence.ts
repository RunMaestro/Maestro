/**
 * Where "which agent am I looking at?" is remembered.
 *
 * On the desktop that is `sessions:setActiveSessionId`, a field in the shared
 * sessions store. A web-desktop client runs the same renderer against the same
 * store, so it used to read there too - and since a browser tab reloads on every
 * refocus, the reload then restored whatever the DESKTOP had focused, dropping
 * the user back onto the desktop's agent and its tabs rather than the one they
 * had been working in (issue #1398). The agent itself was never lost; only the
 * pointer to it was, which is why it was still there in the Left Bar.
 *
 * Which agent a client has in front of it is per-client view state, not shared
 * workspace state, and in a browser "client" means one TAB: two web-desktop tabs
 * share an origin, so a localStorage-only answer would have each tab overwriting
 * the other's choice and reproducing the same bleed one level down. The read is
 * therefore a ladder, most specific first:
 *
 *   1. `sessionStorage` - this tab's own choice. Survives the reload, dies with
 *      the tab.
 *   2. `localStorage`   - the last choice made in this browser. What a brand-new
 *      tab (or one opened after a browser restart) opens on.
 *   3. the shared store - where the desktop is. A first visit should land on
 *      something meaningful rather than on agent zero.
 */

import { isWebDesktop } from './runtimeContext';
import { safeLocalStorage, safeSessionStorage, writeStorageValue } from './safeLocalStorage';

/** Storage key for a web-desktop client's own focused agent. */
export const WEB_ACTIVE_SESSION_STORAGE_KEY = 'maestro:web-desktop:activeSessionId';

/**
 * Remember the focused agent.
 *
 * A web-desktop client records its OWN choice AND still reports it to the shared
 * store: reading is what had to become per-client, not writing. The shared value
 * is what the plugin `session.activated` event and the CLI's notion of the
 * current agent are built on, so a browser user going quiet there would be a
 * second bug traded for the first.
 *
 * Fire-and-forget on every path: if a write fails the only cost is that the next
 * load falls back to the first agent.
 */
export function persistActiveSessionId(id: string): void {
	if (isWebDesktop()) {
		writeStorageValue(safeSessionStorage(), WEB_ACTIVE_SESSION_STORAGE_KEY, id);
		writeStorageValue(safeLocalStorage(), WEB_ACTIVE_SESSION_STORAGE_KEY, id);
	}
	void window.maestro?.sessions?.setActiveSessionId(id);
}

/**
 * The agent this client last focused, or `''` when it has never focused one.
 *
 * Walks the ladder described at the top of this file. The caller validates the
 * id against the restored agents before using it.
 */
export async function readPersistedActiveSessionId(): Promise<string> {
	if (isWebDesktop()) {
		const ownTab = safeSessionStorage()?.getItem(WEB_ACTIVE_SESSION_STORAGE_KEY);
		if (ownTab) return ownTab;
		const thisBrowser = safeLocalStorage()?.getItem(WEB_ACTIVE_SESSION_STORAGE_KEY);
		if (thisBrowser) return thisBrowser;
	}
	return (await window.maestro?.sessions?.getActiveSessionId()) ?? '';
}
