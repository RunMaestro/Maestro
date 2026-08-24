import { useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { FIXED_SHORTCUTS } from '../../constants/shortcuts';
import { buildEventFromKeys } from '../../utils/shortcutRecorder';
import type { Shortcut } from '../../types';

/**
 * Two-way bridge between the native macOS application menu and the renderer.
 *
 * Outbound: the renderer owns the shortcut map (bundled defaults merged with
 * the user's remaps), so it publishes the merged bindings to the main process.
 * The menu rebuilds from them, which is what makes it a reliable way to *learn*
 * a shortcut - the accelerator shown is the one actually bound, even after a
 * remap.
 *
 * Inbound: a menu click arrives as a shortcut id and is replayed as a synthetic
 * keydown on window, where the normal handler picks it up. Menu and keyboard
 * therefore share one dispatch path, so a menu item can never drift from what
 * its keystroke does. Guards in that handler (an open modal swallowing app
 * shortcuts, a command that needs an active tab) apply equally to both, so
 * items that don't apply right now simply no-op.
 *
 * Same synthetic-event technique the codebase already uses to route keystrokes
 * out of a focused webview (onBrowserTabShortcutKey) and out of xterm (Cmd+F).
 *
 * No-ops when the app menu bridge isn't present (web-desktop build).
 */
export function useAppMenuBridge(): void {
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);

	useEffect(() => {
		const app = window.maestro?.app;
		if (!app?.setMenuShortcutKeys) return;

		const keys: Record<string, string[]> = {};
		const collect = (map: Record<string, Shortcut>) => {
			for (const [id, shortcut] of Object.entries(map)) {
				if (shortcut?.keys?.length) keys[id] = shortcut.keys;
			}
		};
		// FIXED_SHORTCUTS first: it holds non-configurable bindings, so the two
		// user-editable maps take precedence on the (currently empty) overlap.
		collect(FIXED_SHORTCUTS);
		collect(tabShortcuts);
		collect(shortcuts);

		app.setMenuShortcutKeys(keys);
	}, [shortcuts, tabShortcuts]);

	useEffect(() => {
		const app = window.maestro?.app;
		if (!app?.onMenuCommand) return;

		return app.onMenuCommand((shortcutId) => {
			const shortcut =
				shortcuts[shortcutId] ?? tabShortcuts[shortcutId] ?? FIXED_SHORTCUTS[shortcutId];
			if (!shortcut) return;

			const event = buildEventFromKeys(shortcut.keys);
			if (event) window.dispatchEvent(event);
		});
	}, [shortcuts, tabShortcuts]);
}
