/**
 * Centralized shortcut-usage tracking.
 *
 * Every shortcut firing should bump two stats:
 *   1. The settings-store `keyboardMasteryStats.usedShortcuts` set, which
 *      drives the "Unused Shortcuts" list and mastery ring.
 *   2. The main-process daily counter (`shortcut_usage_daily`), which
 *      drives the Usage Dashboard bar chart.
 *
 * Call sites that handle a shortcut outside the central
 * `useMainKeyboardHandler` (e.g. inline Cmd+F in a tab, modal-local key
 * handlers, ad-hoc Enter-key interception in the input) must use this
 * helper so neither stat falls behind.
 *
 * Fires-and-forgets the IPC call: failing telemetry must never block the
 * shortcut from taking effect.
 */

import { useSettingsStore } from '../stores/settingsStore';
import { getModalActions } from '../stores/modalStore';

export function trackShortcutUsage(shortcutId: string): void {
	const result = useSettingsStore.getState().recordShortcutUsage(shortcutId);
	if (result.newLevel !== null) {
		getModalActions().setPendingKeyboardMasteryLevel(result.newLevel);
	}
	void window.maestro?.stats?.recordShortcutUsage?.(Date.now());
}
