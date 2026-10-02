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
import type { Session } from '../types';
import {
	safeLocalStorage,
	safeSessionStorage,
	safeStorageGet,
	writeStorageValue,
} from './safeLocalStorage';

/** Storage key for a web-desktop client's own focused agent. */
export const WEB_ACTIVE_SESSION_STORAGE_KEY = 'maestro:web-desktop:activeSessionId';

/** Native Lite preserves a client ID across view recreation; browser tabs do not share drafts. */
export function writeClientViewState(key: string, value: string): void {
	writeStorageValue(safeSessionStorage(), key, value);
	const clientId = new URLSearchParams(window.location.search).get('liteClientId');
	if (clientId) writeStorageValue(safeLocalStorage(), key + ':' + clientId, value);
}

export function readClientViewState(key: string): string | null {
	try {
		const ownTab = safeSessionStorage()?.getItem(key);
		if (ownTab !== null && ownTab !== undefined) return ownTab;
		const clientId = new URLSearchParams(window.location.search).get('liteClientId');
		return clientId ? safeStorageGet(key + ':' + clientId) : null;
	} catch {
		return null;
	}
}

/**
 * Remember the focused agent.
 *
 * Browser navigation never writes the host's active pointer. Plugins/CLI use
 * the full host renderer's focus, while each attached client remembers its own.
 *
 * Fire-and-forget on every path: if a write fails the only cost is that the next
 * load falls back to the first agent.
 */
export function persistActiveSessionId(id: string): void {
	if (isWebDesktop()) {
		writeClientViewState(WEB_ACTIVE_SESSION_STORAGE_KEY, id);
		if (!new URLSearchParams(window.location.search).get('liteClientId'))
			writeStorageValue(safeLocalStorage(), WEB_ACTIVE_SESSION_STORAGE_KEY, id);
		return;
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
		const ownTab = readClientViewState(WEB_ACTIVE_SESSION_STORAGE_KEY);
		if (ownTab) return ownTab;
		const thisBrowser = safeStorageGet(WEB_ACTIVE_SESSION_STORAGE_KEY);
		if (thisBrowser) return thisBrowser;
	}
	return (await window.maestro?.sessions?.getActiveSessionId()) ?? '';
}

const VIEW_FIELDS = [
	'activeTabId',
	'activeFileTabId',
	'activeBrowserTabId',
	'activeTerminalTabId',
	'activeGroupId',
	'inputMode',
	'terminalDraftInput',
] as const;

/** Remember only navigation/composer data, never transcripts or shared work. */
export function persistClientSessionView(session: Session): void {
	if (!isWebDesktop()) return;
	const view: Record<string, unknown> = {};
	for (const field of VIEW_FIELDS) view[field] = session[field];
	view.drafts = (session.aiTabs ?? []).map(({ id, inputValue, commandMode, stagedImages }) => ({
		id,
		inputValue,
		commandMode,
		stagedImages,
	}));
	const key = 'maestro:web-desktop:session-view:' + session.id;
	const value = JSON.stringify(view);
	if (readClientViewState(key) !== value) writeClientViewState(key, value);
}

/** Overlay this client's view before the usual tab-validating restoration. */
export function restoreClientSessionView(session: Session): Session {
	if (!isWebDesktop()) return session;
	let view: Record<string, any> = {};
	try {
		const value = readClientViewState('maestro:web-desktop:session-view:' + session.id);
		if (value) view = JSON.parse(value);
	} catch {
		/* Corrupt/unavailable local storage is not shared host state. */
	}
	const ownDrafts = new Map<string, Partial<Session['aiTabs'][number]>>(
		(Array.isArray(view.drafts) ? view.drafts : []).map((draft: Session['aiTabs'][number]) => [
			draft.id,
			draft,
		])
	);
	const ownView: Partial<Session> = {};
	for (const field of VIEW_FIELDS) {
		if (view[field] !== undefined) (ownView as Record<string, unknown>)[field] = view[field];
	}
	return {
		...session,
		...ownView,
		terminalDraftInput: view.terminalDraftInput ?? '',
		aiTabs: session.aiTabs?.map((tab) => {
			const draft = ownDrafts.get(tab.id);
			return {
				...tab,
				inputValue: draft?.inputValue ?? '',
				commandMode: draft?.commandMode,
				stagedImages: draft?.stagedImages ?? [],
			};
		}),
	};
}
