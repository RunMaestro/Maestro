/**
 * Cmd+` window cycling on macOS, done by Maestro instead of AppKit.
 *
 * AppKit's own cycle skips panels, and Quick Chat is a non-activating panel.
 * So Cmd+` from a Maestro window never reached Quick Chat, and from Quick Chat
 * it cycled the frontmost app's windows (or nothing) instead of coming back.
 * The page cannot fix that: Chromium treats Cmd+` as a reserved system hotkey
 * and usually never hands it to the web contents.
 *
 * The keystroke arrives at one of two places, depending on the app's state:
 *
 * - the application menu key equivalent (`Window > Cycle Through Windows`),
 *   which is the usual path, including from the panel while another app is
 *   frontmost;
 * - `before-input-event`, when Chromium does pass the key to the page.
 *
 * Both call {@link cycleWindows}. The input handler calls `preventDefault`,
 * which also keeps the menu from firing for the same press.
 */

import { BrowserWindow } from 'electron';
import { focusAppWindow } from './global-hotkey-manager';
import type { WindowRegistry } from './window-registry';

export type WindowCycleDirection = 'next' | 'previous';

/** The windows Cmd+` moves between, in a stable order (the order they opened). */
export function windowCycleTargets(registry: WindowRegistry): BrowserWindow[] {
	return registry
		.getAll()
		.filter((entry) => entry.kind === 'app' || entry.kind === 'quick-chat')
		.map((entry) => entry.browserWindow)
		.filter((win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized());
}

/**
 * Give the keyboard to the next (or previous) window in the cycle. Returns the
 * window focused, or null when there is nowhere else to go. A focused window
 * outside the cycle (a floating widget, a HUD) starts it from the first window.
 */
export function cycleWindows(
	registry: WindowRegistry,
	direction: WindowCycleDirection,
	focused: BrowserWindow | null = BrowserWindow.getFocusedWindow()
): BrowserWindow | null {
	const targets = windowCycleTargets(registry);
	if (targets.length === 0) return null;
	const index = focused ? targets.indexOf(focused) : -1;
	const step = direction === 'next' ? 1 : -1;
	const next =
		index === -1 ? targets[0] : targets[(index + step + targets.length) % targets.length];
	if (next === focused) return null;
	const isQuickChat = registry
		.getAll()
		.some((entry) => entry.browserWindow === next && entry.kind === 'quick-chat');
	// An app window may need the app activated (the panel leaves another app
	// frontmost). The panel itself must not activate Maestro: focus is enough.
	if (isQuickChat) next.focus();
	else focusAppWindow(next);
	return next;
}

/** The cycle direction a keystroke asks for, or null when it is not Cmd+`. */
export function windowCycleDirectionFor(input: Electron.Input): WindowCycleDirection | null {
	if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return null;
	if (input.code !== 'Backquote') return null;
	return input.shift ? 'previous' : 'next';
}

/**
 * Take Cmd+` in a window's web contents, for the times Chromium passes it to
 * the page instead of leaving it to the menu. A held key cycles once.
 */
export function attachWindowCycleShortcut(
	webContents: Electron.WebContents,
	onCycle: (direction: WindowCycleDirection) => void
): void {
	webContents.on('before-input-event', (event, input) => {
		const direction = windowCycleDirectionFor(input);
		if (!direction) return;
		event.preventDefault();
		if (!input.isAutoRepeat) onCycle(direction);
	});
}
