/**
 * Global Hotkey Registry
 *
 * Owns every system-wide hotkey Maestro registers through Electron's
 * `globalShortcut` API, keyed by a stable id. Each registration lives and dies
 * on its own: a combo the OS has already claimed fails that id and leaves the
 * others bound. That independence is the whole reason this stopped being a
 * singleton. When there was one hotkey, "did it register" was a boolean; with
 * the A Cappella voice hotkeys there are three, and a shared failure path would
 * mean the user losing "show Maestro" because they picked a bad voice combo.
 *
 * Settings still store a key array (`['Meta','Shift','M']`), the same format the
 * in-app shortcut recorder produces, and it is translated to an Electron
 * Accelerator at registration time. That is deliberate: the recording UI does not
 * know this file exists and must not have to.
 *
 * Two failure kinds are distinguished because the user's next move differs:
 *
 *   - `os-conflict` - another application (or the OS) owns the combo. Pick a
 *     different one.
 *   - `maestro-conflict` - two Maestro hotkeys are bound to the SAME combo. Left
 *     to Electron the second registration simply wins or silently loses
 *     depending on platform, and the user is left with a key that does the wrong
 *     one of two things. Detected here instead, and named, so the settings UI can
 *     say which other hotkey is holding it.
 *
 * Failures are reported through `globalHotkey:registrationFailed`, which now
 * carries the whole status object (id included) rather than a bare key array.
 */

import { app, BrowserWindow, globalShortcut } from 'electron';
import { logger } from './utils/logger';
import { isMacOS } from '../shared/platformDetection';
import {
	SHOW_MAESTRO_HOTKEY_ID,
	type GlobalHotkeyFailureReason,
	type GlobalHotkeyStatus,
} from '../shared/global-hotkeys';

const LOG_CONTEXT = 'GlobalHotkey';

export { SHOW_MAESTRO_HOTKEY_ID };
export type { GlobalHotkeyFailureReason, GlobalHotkeyStatus };

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
export function summonMainWindow(window: BrowserWindow): void {
	if (window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	if (!window.isVisible()) window.show();
	// On macOS the app process can be hidden (Cmd+H) even when the window has
	// state - `app.show()` brings it back to the foreground.
	if (isMacOS()) app.show();
	window.focus();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The slice of `globalShortcut` the registry uses.
 *
 * Injected so the state machine can be tested without an Electron main process.
 * `isRegistered` is deliberately absent: cross-Maestro conflicts are tracked here
 * (Electron reports our OWN registration as taken, which would make every
 * re-registration look like a conflict) and OS conflicts are whatever `register`
 * says.
 */
export interface GlobalShortcutBackend {
	register(accelerator: string, callback: () => void): boolean;
	unregister(accelerator: string): void;
}

const electronBackend: GlobalShortcutBackend = {
	register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
	unregister: (accelerator) => globalShortcut.unregister(accelerator),
};

/** Called whenever a registration fails, including a re-registration after a rebind. */
export type GlobalHotkeyFailureListener = (status: GlobalHotkeyStatus) => void;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class GlobalHotkeyRegistry {
	private readonly backend: GlobalShortcutBackend;
	private readonly handlers = new Map<string, () => void>();
	private readonly statuses = new Map<string, GlobalHotkeyStatus>();
	/** Accelerator -> the id that successfully holds it. The conflict detector. */
	private readonly owners = new Map<string, string>();
	private failureListener: GlobalHotkeyFailureListener | null = null;

	constructor(backend: GlobalShortcutBackend = electronBackend) {
		this.backend = backend;
	}

	/**
	 * Teach the registry what an id does.
	 *
	 * Separate from `setKeys` because the handler comes from app wiring and the
	 * keys come from settings, and those two arrive at different times: the
	 * settings watcher can fire before, after, or without the feature that owns
	 * the handler ever being switched on. Defining a handler for an id that
	 * already has keys re-registers it, so ordering does not matter.
	 */
	define(id: string, handler: () => void): void {
		this.handlers.set(id, handler);
		const existing = this.statuses.get(id);
		if (existing && !existing.registered && existing.keys.length) {
			this.setKeys(id, existing.keys);
		}
	}

	/** Forget an id entirely, releasing its combo. */
	remove(id: string): void {
		this.clear(id);
		this.handlers.delete(id);
		this.statuses.delete(id);
	}

	/**
	 * Bind (or rebind) one id. An empty array clears it.
	 *
	 * Always releases the previous accelerator first, so a typo cannot leave a
	 * stale combo registered, and a rebind back onto a combo this id already held
	 * cannot report itself as its own conflict.
	 */
	setKeys(id: string, keys: string[]): GlobalHotkeyStatus {
		this.clear(id);

		const accelerator = keysToAccelerator(keys);
		if (!accelerator) {
			// An empty array is the user switching the hotkey off, not a failure.
			const status: GlobalHotkeyStatus = keys.length
				? {
						id,
						keys,
						accelerator: null,
						registered: false,
						reason: 'invalid-accelerator',
						message: 'That combination needs a non-modifier key.',
					}
				: { id, keys, accelerator: null, registered: false };
			this.statuses.set(id, status);
			if (status.reason) this.reportFailure(status);
			else logger.info(`Global hotkey '${id}' cleared`, LOG_CONTEXT);
			return status;
		}

		const owner = this.owners.get(accelerator);
		if (owner && owner !== id) {
			const status: GlobalHotkeyStatus = {
				id,
				keys,
				accelerator,
				registered: false,
				reason: 'maestro-conflict',
				conflictsWith: owner,
				message: `${accelerator} is already used by another Maestro hotkey (${owner}).`,
			};
			this.statuses.set(id, status);
			this.reportFailure(status);
			return status;
		}

		const handler = this.handlers.get(id);
		let ok = false;
		let threw: Error | null = null;
		try {
			// A hotkey with no handler yet is still claimed, so the combo is reserved
			// and reported as bound the moment `define` supplies the behaviour.
			ok = this.backend.register(accelerator, () => this.handlers.get(id)?.());
		} catch (err) {
			threw = err as Error;
		}

		if (!ok) {
			const status: GlobalHotkeyStatus = {
				id,
				keys,
				accelerator,
				registered: false,
				reason: threw ? 'register-error' : 'os-conflict',
				message: threw
					? `${accelerator} could not be registered: ${threw.message}`
					: `${accelerator} is already in use by another application.`,
			};
			this.statuses.set(id, status);
			this.reportFailure(status);
			return status;
		}

		const status: GlobalHotkeyStatus = { id, keys, accelerator, registered: true };
		this.statuses.set(id, status);
		this.owners.set(accelerator, id);
		if (!handler) {
			logger.debug(
				`Global hotkey '${id}' bound to ${accelerator} with no handler yet`,
				LOG_CONTEXT
			);
		}
		logger.info(`Registered global hotkey '${id}': ${accelerator}`, LOG_CONTEXT);
		return status;
	}

	/** Release one id's combo, keeping its handler and its recorded keys. */
	clear(id: string): void {
		const current = this.statuses.get(id);
		if (!current?.registered || !current.accelerator) return;
		try {
			this.backend.unregister(current.accelerator);
		} catch (err) {
			logger.warn(
				`Failed to unregister global hotkey '${id}' (${current.accelerator}): ${err}`,
				LOG_CONTEXT
			);
		}
		if (this.owners.get(current.accelerator) === id) this.owners.delete(current.accelerator);
		this.statuses.set(id, { ...current, registered: false });
	}

	status(id: string): GlobalHotkeyStatus | null {
		return this.statuses.get(id) ?? null;
	}

	/** Every known id's status, for the settings UI's per-hotkey inline state. */
	allStatuses(): GlobalHotkeyStatus[] {
		return [...this.statuses.values()];
	}

	/**
	 * Subscribe to registration failures. One listener: the only subscriber is the
	 * IPC bridge, and a fan-out would just be a list with one entry in it.
	 */
	onFailure(listener: GlobalHotkeyFailureListener | null): void {
		this.failureListener = listener;
	}

	/** Release everything. Safe to call more than once. */
	disposeAll(): void {
		for (const id of [...this.statuses.keys()]) this.clear(id);
		this.owners.clear();
	}

	private reportFailure(status: GlobalHotkeyStatus): void {
		logger.warn(`Global hotkey '${status.id}' failed: ${status.message}`, LOG_CONTEXT);
		try {
			this.failureListener?.(status);
		} catch (err) {
			// A window destroyed between the failure and the notify must not turn a
			// bad key combo into an unhandled exception during startup.
			logger.warn(`Global hotkey failure listener threw: ${err}`, LOG_CONTEXT);
		}
	}
}

// ---------------------------------------------------------------------------
// Process-wide instance
// ---------------------------------------------------------------------------

const registry = new GlobalHotkeyRegistry();

/** The one registry the app uses. Voice hotkeys register against this. */
export function getGlobalHotkeyRegistry(): GlobalHotkeyRegistry {
	return registry;
}

let getWindowFn: (() => BrowserWindow | null) | null = null;

/**
 * Wire the registry to the main window getter and register the "show Maestro"
 * behaviour. Called once during startup.
 */
export function initGlobalHotkey(getWindow: () => BrowserWindow | null): void {
	getWindowFn = getWindow;
	registry.define(SHOW_MAESTRO_HOTKEY_ID, () => {
		const win = getWindowFn?.();
		if (win) summonMainWindow(win);
	});
}

/**
 * Register (or re-register) the global "show Maestro" hotkey.
 * Pass an empty array to clear the binding.
 *
 * Kept as a free function so the settings watcher in `main/index.ts` does not
 * have to know about ids.
 *
 * @returns `true` on success (including a deliberate clear), `false` if
 *          registration failed.
 */
export function setGlobalShowHotkey(keys: string[]): boolean {
	return !registry.setKeys(SHOW_MAESTRO_HOTKEY_ID, keys).reason;
}

/** Tear down the "show Maestro" shortcut. Safe to call multiple times. */
export function disposeGlobalHotkey(): void {
	registry.clear(SHOW_MAESTRO_HOTKEY_ID);
}

/** Tear down every registered shortcut. Wired to `will-quit`. */
export function disposeAllGlobalHotkeys(): void {
	registry.disposeAll();
}
