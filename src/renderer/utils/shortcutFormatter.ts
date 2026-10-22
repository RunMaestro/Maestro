/**
 * Renderer-side keyboard shortcut formatting.
 *
 * Thin platform-binding wrapper: the key maps and the pure formatting live in
 * `src/shared/shortcutKeys.ts` so the CLI and main process can produce the same
 * strings. This file only answers "are we on macOS?" for the renderer.
 */

import { isMacOSKeyboard } from './platformUtils';
import { formatKeyFor, formatShortcutKeysFor } from '../../shared/shortcutKeys';

/** Joins the keys of a chord on macOS so the chord never wraps mid-chord. */
const NO_BREAK_SPACE = '\u00A0';

// Shortcut hints follow the physical client keyboard, not a remote execution host.
function isMac(): boolean {
	return isMacOSKeyboard();
}

/**
 * Format a single key for display based on platform.
 */
export function formatKey(key: string): string {
	return formatKeyFor(key, isMac());
}

/**
 * Format an array of keys for display.
 *
 * @param keys - Array of key names (e.g., ['Meta', 'Shift', 'k'])
 * @param separator - Separator between keys (default: a no-break space on
 *   macOS, '+' elsewhere)
 * @returns Formatted string for display
 *
 * The macOS default is a NO-BREAK space (U+00A0), not a plain one. A chord is
 * one unit; with a plain space every narrow container (a menu row, a wrapped
 * tooltip, a toolbar) was free to break `⌘ ⇧ K` across lines, which stacked
 * the keys vertically. The shared formatter keeps the plain space for the CLI
 * and the app menu, where the string is not laid out in a box.
 *
 * @example
 * // On macOS (shown with plain spaces; the real ones are U+00A0):
 * formatShortcutKeys(['Meta', 'Shift', 'k']) // '⌘ ⇧ K'
 * formatShortcutKeys(['Alt', 'Meta', 'ArrowRight']) // '⌥ ⌘ →'
 *
 * // On Windows/Linux:
 * formatShortcutKeys(['Meta', 'Shift', 'k']) // 'Ctrl+Shift+K'
 * formatShortcutKeys(['Alt', 'Meta', 'ArrowRight']) // 'Alt+Ctrl+→'
 */
export function formatShortcutKeys(keys: string[], separator?: string): string {
	const mac = isMac();
	return formatShortcutKeysFor(keys, mac, separator ?? (mac ? NO_BREAK_SPACE : undefined));
}

/**
 * Format the platform-appropriate meta/command key.
 * Returns '⌘' on macOS, 'Ctrl' on Windows/Linux.
 */
export function formatMetaKey(): string {
	return isMac() ? '⌘' : 'Ctrl';
}

/**
 * Spelled-out name of the platform meta/command key, for prose in settings
 * copy, help text, and tooltips. Returns 'Command' on macOS, 'Ctrl' on
 * Windows/Linux. Use `formatMetaKey()` when the compact symbol reads better.
 */
export function formatMetaKeyName(): string {
	return isMac() ? 'Command' : 'Ctrl';
}

/**
 * Spelled-out name of the platform alt/option key, for prose in hints and
 * tooltips. Returns 'Option' on macOS, 'Alt' on Windows/Linux. Pair it with
 * `formatKey('Alt')` when the copy shows the symbol and the word together.
 */
export function formatAltKeyName(): string {
	return isMac() ? 'Option' : 'Alt';
}

/**
 * Format the enter-to-send display text.
 * Used by input areas that toggle between Enter and Cmd+Enter to send.
 *
 * @param enterToSend - Whether Enter sends (true) or Cmd/Ctrl+Enter sends (false)
 * @returns Display string like 'Enter' or '⌘ + Enter' / 'Ctrl + Enter'
 */
export function formatEnterToSend(enterToSend: boolean): string {
	if (enterToSend) return 'Enter';
	// No-break spaces: the toggle sits in shrinking toolbars, and a chord must not wrap.
	return isMac() ? '⌘\u00A0+\u00A0Enter' : 'Ctrl\u00A0+\u00A0Enter';
}

/**
 * Format the enter-to-send tooltip text for the toggle button.
 *
 * @param enterToSend - Whether Enter sends (true) or Cmd/Ctrl+Enter sends (false)
 * @returns Tooltip like 'Switch to Cmd+Enter to send' or 'Switch to Enter to send'
 */
export function formatEnterToSendTooltip(enterToSend: boolean): string {
	if (enterToSend) {
		return `Switch to ${isMac() ? 'Cmd' : 'Ctrl'}+Enter to send`;
	}
	return 'Switch to Enter to send';
}

/**
 * Check if running on macOS.
 * Useful for conditional rendering.
 */
export function isMacOS(): boolean {
	return isMac();
}
