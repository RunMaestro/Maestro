/**
 * Global Hotkey Manager
 *
 * Owns Maestro's system-wide hotkeys, registered via Electron's globalShortcut
 * API: the "show Maestro" summon key plus any feature that adds its own (Quick
 * Chat). Each owner registers under an id with `setNamedGlobalHotkey`. The setting is stored as a key array (same format as the
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
			case ' ':
			case ' ':
				// The shortcut recorder stores the space bar as its literal key
				// value (a non-breaking space with Option held on macOS); Electron
				// only accepts the name.
				mainKey = 'Space';
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

/** A registered system-wide binding: the accelerator and what it does. */
interface NamedBinding {
	accelerator: string;
	onPress: () => void;
}

/**
 * Every live binding, keyed by owner (`show` for the summon hotkey, one id per
 * feature that adds its own). Each owner holds at most one accelerator, so
 * re-binding never leaks the previous combo.
 */
const bindings = new Map<string, NamedBinding>();
let getWindowFn: (() => BrowserWindow | null) | null = null;

/** The binding id the "show Maestro" hotkey registers under. */
const SHOW_BINDING_ID = 'show';

function unregisterBinding(id: string): void {
	const existing = bindings.get(id);
	if (!existing) return;
	try {
		globalShortcut.unregister(existing.accelerator);
	} catch (err) {
		logger.warn(
			`Failed to unregister previous global hotkey '${existing.accelerator}': ${err}`,
			'GlobalHotkey'
		);
	}
	bindings.delete(id);
}

/**
 * Register (or re-register) one owner's system-wide hotkey. Pass an empty
 * array to clear it.
 *
 * Fails when the combo is invalid, the OS or another app already holds it, or
 * another Maestro binding uses it (two owners on one combo would make the key
 * do whichever registered last).
 *
 * @returns `true` on success, `false` if registration failed.
 */
export function setNamedGlobalHotkey(id: string, keys: string[], onPress: () => void): boolean {
	// Always clear the previous binding first so a typo doesn't leave a stale
	// shortcut registered.
	unregisterBinding(id);

	const accelerator = keysToAccelerator(keys);
	if (!accelerator) {
		logger.info(`Global hotkey '${id}' cleared`, 'GlobalHotkey');
		return true;
	}

	for (const [otherId, other] of bindings) {
		if (other.accelerator === accelerator) {
			logger.warn(
				`Global hotkey '${accelerator}' for '${id}' is already bound to '${otherId}'`,
				'GlobalHotkey'
			);
			return false;
		}
	}

	try {
		const ok = globalShortcut.register(accelerator, onPress);
		if (!ok) {
			logger.warn(
				`Failed to register global hotkey '${accelerator}' - likely already in use by another app`,
				'GlobalHotkey'
			);
			return false;
		}
		bindings.set(id, { accelerator, onPress });
		logger.info(`Registered global hotkey '${id}': ${accelerator}`, 'GlobalHotkey');
		return true;
	} catch (err) {
		logger.warn(
			`Error registering global hotkey '${accelerator}': ${(err as Error).message}`,
			'GlobalHotkey'
		);
		return false;
	}
}

/**
 * Register (or re-register) the global "show Maestro" hotkey.
 * Pass an empty array to clear the binding.
 *
 * @returns `true` on success, `false` if registration failed.
 */
export function setGlobalShowHotkey(keys: string[]): boolean {
	return setNamedGlobalHotkey(SHOW_BINDING_ID, keys, () => {
		const win = getWindowFn?.();
		if (win) summonMainWindow(win);
	});
}

/** Tear down every registered shortcut. Safe to call multiple times. */
export function disposeGlobalHotkey(): void {
	for (const id of [...bindings.keys()]) {
		try {
			globalShortcut.unregister(bindings.get(id)!.accelerator);
		} catch {
			// Ignore - app is shutting down or shortcut wasn't registered.
		}
		bindings.delete(id);
	}
}

/**
 * Wire the manager to the main window getter. Called once during startup.
 */
export function initGlobalHotkey(getWindow: () => BrowserWindow | null): void {
	getWindowFn = getWindow;
}
