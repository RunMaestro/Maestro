/**
 * tileNewTabAction - the store-aware wrapper around {@link tileNewTab}.
 *
 * `tileNewTab` itself is a pure session -> session transform (it takes its
 * defaults as an argument so its tests need no live store). This module is the
 * thin layer that reads the settings store, commits the new session, and moves
 * focus to the pane that was just created. Both surfaces that offer the action -
 * the command palette's "Tile New ... Below" family and the Cmd+Shift+J
 * terminal hotkey - go through here, so they cannot drift on which settings the
 * new tab inherits or on whether focus follows the tile.
 */

import { notifyCenterFlash } from '../stores/centerFlashStore';
import { updateSessionWith } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { findLeafByTabRef, type DropZone } from '../utils/panelLayout';
import { tileNewTab, type TileableTabKind } from '../hooks/tabs/tileNewTab';

/**
 * Create a `kind` tab, tile it into `zone` of the view currently on screen, and
 * focus the resulting pane.
 *
 * Returns true when a tile landed. When there is nothing on screen to split
 * against it flashes "Nothing here to tile with" and returns false, so a caller
 * that owns a key event can still decide whether to swallow it.
 */
export function tileNewTabInSession(
	sessionId: string,
	kind: TileableTabKind,
	zone: DropZone = 'bottom'
): boolean {
	// Captured inside the updater so focus is only requested when the tile
	// actually landed.
	let paneId: string | null = null;
	updateSessionWith(sessionId, (s) => {
		const result = tileNewTab(
			s,
			kind,
			{
				saveToHistory: useSettingsStore.getState().defaultSaveToHistory,
				showThinking: useSettingsStore.getState().defaultShowThinking,
				browserHomeUrl: useSettingsStore.getState().browserHomeUrl,
			},
			zone
		);
		if (!result) return s;
		const group = result.session.tabGroups?.find((g) => g.id === result.session.activeGroupId);
		paneId = group ? (findLeafByTabRef(group.layout, result.ref)?.id ?? null) : null;
		return result.session;
	});

	if (!paneId) {
		notifyCenterFlash({ color: 'yellow', message: 'Nothing here to tile with' });
		return false;
	}
	useUIStore.getState().requestPaneFocus(paneId);
	return true;
}
