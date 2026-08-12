/**
 * Global Hotkey Manager
 *
 * Owns the single system-wide "show Maestro" hotkey registered via Electron's
 * globalShortcut API. The setting is stored as a key array (same format as the
 * in-app shortcuts) and translated to an Electron Accelerator at registration
 * time so users can record the hotkey using the same capture UI they already
 * know.
 *
 * Registration failures (OS already bound the combo, accelerator invalid, etc.)
 * are surfaced to the renderer via `globalHotkey:registrationFailed` so the
 * Settings UI can show a toast and the user can pick a different combo.
 */

import { app, BrowserWindow, globalShortcut } from 'electron';
import { logger } from './utils/logger';
import { isMacOS } from '../shared/platformDetection';

/**
 * Translate a key array (e.g. ['Meta','Shift','M']) into an Electron
 * Accelerator string (e.g. 'Command+Shift+M').
 *
 * - `Meta` -> `Command` on macOS, `Super` on Windows/Linux (Electron treats
 *   `Command` as Cmd on macOS and ignores it elsewhere, so we branch).
 * - Single letters are upper-cased; named keys (`ArrowLeft`, `F5`, ...) are
 *   passed through.
 *
 * Returns `null` if the array has no non-modifier key - those aren't valid
 * global shortcuts.
 */
export function keysToAccelerator(keys: string[]): string | null {
	if (!keys.length) return null;

	const modifiers: string[] = [];
	let mainKey: string | null = null;

	for (const raw of keys) {
		switch (raw) {
			case 'Meta':
				modifiers.push(isMacOS() ? 'Command' : 'Super');
				break;
			case 'Ctrl':
			case 'Control':
				modifiers.push('Control');
				break;
			case 'Alt':
				modifiers.push('Alt');
				break;
			case 'Shift':
				modifiers.push('Shift');
				break;
			default:
				mainKey = raw.length === 1 ? raw.toUpperCase() : raw;
		}
	}

	if (!mainKey) return null;
	return [...modifiers, mainKey].join('+');
}

/** Bring the Maestro window to the foreground from any app. */
function summonMainWindow(window: BrowserWindow): void {
	if (window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	if (!window.isVisible()) window.show();
	// On macOS the app process can be hidden (Cmd+H) even when the window has
	// state - `app.show()` brings it back to the foreground.
	if (isMacOS()) app.show();
	window.focus();
}

let currentAccelerator: string | null = null;
let getWindowFn: (() => BrowserWindow | null) | null = null;

/**
 * Register (or re-register) the global "show Maestro" hotkey.
 * Pass an empty array to clear the binding.
 *
 * @returns `true` on success, `false` if registration failed.
 */
export function setGlobalShowHotkey(keys: string[]): boolean {
	// Always clear the previous binding first so a typo doesn't leave a stale
	// shortcut registered.
	if (currentAccelerator) {
		try {
			globalShortcut.unregister(currentAccelerator);
		} catch (err) {
			logger.warn(
				`Failed to unregister previous global hotkey '${currentAccelerator}': ${err}`,
				'GlobalHotkey'
			);
		}
		currentAccelerator = null;
	}

	const accelerator = keysToAccelerator(keys);
	if (!accelerator) {
		logger.info('Global show hotkey cleared', 'GlobalHotkey');
		return true;
	}

	try {
		const ok = globalShortcut.register(accelerator, () => {
			const win = getWindowFn?.();
			if (win) summonMainWindow(win);
		});
		if (!ok) {
			logger.warn(
				`Failed to register global hotkey '${accelerator}' - likely already in use by another app`,
				'GlobalHotkey'
			);
			return false;
		}
		currentAccelerator = accelerator;
		logger.info(`Registered global show hotkey: ${accelerator}`, 'GlobalHotkey');
		return true;
	} catch (err) {
		logger.warn(
			`Error registering global hotkey '${accelerator}': ${(err as Error).message}`,
			'GlobalHotkey'
		);
		return false;
	}
}

/** Tear down any registered shortcut. Safe to call multiple times. */
export function disposeGlobalHotkey(): void {
	if (currentAccelerator) {
		try {
			globalShortcut.unregister(currentAccelerator);
		} catch {
			// Ignore - app is shutting down or shortcut wasn't registered.
		}
		currentAccelerator = null;
	}
}

/**
 * Wire the manager to the main window getter. Called once during startup.
 */
export function initGlobalHotkey(getWindow: () => BrowserWindow | null): void {
	getWindowFn = getWindow;
}
