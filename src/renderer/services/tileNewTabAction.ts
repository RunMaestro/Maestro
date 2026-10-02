/**
 * tileNewTabAction - the store-aware wrapper around {@link tileNewTab}.
 *
 * `tileNewTab` itself is a pure session -> session transform (it takes its
 * defaults as an argument so its tests need no live store). This module is the
 * thin layer that reads the settings store, commits the new session, and moves
 * focus to the pane that was just created. Both surfaces that offer the action -
 * the command palette's "Tile New ... Below" family and the Ctrl+Cmd+T/J/B/F
 * hotkeys - go through here, so they cannot drift on which settings the
 * new tab inherits or on whether focus follows the tile.
 */

import { notifyCenterFlash } from '../stores/centerFlashStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { findLeafByTabRef, type DropZone } from '../utils/panelLayout';
import { tileNewTab, canTileNewTab, type TileableTabKind } from '../hooks/tabs/tileNewTab';
import type { BrowserTab } from '../../shared/browserPage';
import { isWebDesktop } from '../utils/runtimeContext';
import { DEFAULT_BROWSER_TAB_URL } from '../utils/browserTabPersistence';

/**
 * Create a `kind` tab, tile it into `zone` of the view currently on screen, and
 * focus the resulting pane.
 *
 * Returns true when a tile lands or a host browser creation request is submitted.
 * When there is nothing on screen to split against it flashes a notice and returns
 * false, so a caller that owns a key event can decide whether to swallow it.
 */
export function tileNewTabInSession(
	sessionId: string,
	kind: TileableTabKind,
	zone: DropZone = 'bottom'
): boolean {
	const land = (registeredBrowserTab?: BrowserTab): boolean => {
		// Capture focus only after the tile lands, including after host acknowledgement.
		let paneId: string | null = null;
		updateSessionWith(sessionId, (session) => {
			const result = tileNewTab(
				session,
				kind,
				{
					saveToHistory: useSettingsStore.getState().defaultSaveToHistory,
					showThinking: useSettingsStore.getState().defaultShowThinking,
					browserHomeUrl: useSettingsStore.getState().browserHomeUrl,
				},
				zone,
				registeredBrowserTab
			);
			if (!result) return session;
			const group = result.session.tabGroups?.find(
				(candidate) => candidate.id === result.session.activeGroupId
			);
			paneId = group ? (findLeafByTabRef(group.layout, result.ref)?.id ?? null) : null;
			return result.session;
		});
		if (!paneId) {
			notifyCenterFlash({ color: 'yellow', message: 'Nothing here to tile with' });
			return false;
		}
		if (!registeredBrowserTab || useSessionStore.getState().activeSessionId === sessionId)
			useUIStore.getState().requestPaneFocus(paneId);
		return true;
	};
	if (kind === 'browser' && isWebDesktop()) {
		const session = useSessionStore
			.getState()
			.sessions.find((candidate) => candidate.id === sessionId);
		if (!canTileNewTab(session)) {
			notifyCenterFlash({ color: 'yellow', message: 'Nothing here to tile with' });
			return false;
		}
		void window.maestro.browserSession
			.createTab(sessionId, {
				url: useSettingsStore.getState().browserHomeUrl || DEFAULT_BROWSER_TAB_URL,
			})
			.then((tab) => land(tab))
			.catch((error) =>
				notifyCenterFlash({
					color: 'red',
					message: 'Could not create host browser tile',
					detail: error instanceof Error ? error.message : String(error),
				})
			);
		return true;
	}
	return land();
}
