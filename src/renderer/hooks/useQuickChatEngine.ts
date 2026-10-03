/**
 * useQuickChatEngine.ts
 *
 * Runs the Quick Chat engine (src/renderer/services/quickChatEngine.ts) in this
 * app window while the Quick Chat Encore Feature is on: answers the floating
 * window's commands and streams the conversation back to it. The main window
 * also reports a hotkey the OS refused, since only it is guaranteed to exist.
 *
 * Mounted once, near the top of the app.
 */

import { useEffect } from 'react';
import { startQuickChatEngine } from '../services/quickChatEngine';
import { notifyToast } from '../stores/notificationStore';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

export function useQuickChatEngine(enabled: boolean, isMainWindow: boolean): void {
	useEffect(() => {
		if (!enabled) return;
		return startQuickChatEngine();
	}, [enabled]);

	useEffect(() => {
		if (!enabled || !isMainWindow) return;
		return window.maestro.quickChat.onHotkeyFailed((keys) => {
			notifyToast({
				color: 'orange',
				title: 'Quick Chat hotkey unavailable',
				message: `${formatShortcutKeys(keys)} is already in use by another app or Maestro hotkey. Pick a different one in Settings → Encore Features → Quick Chat.`,
				dismissible: true,
			});
		});
	}, [enabled, isMainWindow]);
}
