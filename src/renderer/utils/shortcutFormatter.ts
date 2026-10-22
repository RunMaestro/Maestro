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
 * One step of a key SEQUENCE, in the spelling a Vim user types it.
 *
 * Two departures from `formatKeyFor`, both because a sequence step is a
 * keystroke the user reproduces rather than a modifier cluster they hold:
 *
 *  - A bare single character is left exactly as it was bound. `formatKeyFor`
 *    uppercases one, which is right for a chord (`⌘ G` is Cmd and the G key)
 *    and wrong here: `g` and `G` are DIFFERENT steps, and printing `g g` as
 *    `G G` tells the user to hold Shift twice.
 *  - `Shift` + a letter folds into the capital letter. `⇧ G` is the chord
 *    spelling; `G` is how every Vim document in the world writes that
 *    keystroke, and it is what the user has to press.
 *
 * Anything else - a modifier cluster, a named key, Shift over something that
 * has no capital form - falls through to the chord formatter, so a step always
 * reads as something pressable.
 */
function formatSequenceStep(step: string[]): string {
	if (step.length === 1 && step[0].length === 1) return step[0];
	if (step.length === 2) {
		const shiftIndex = step.indexOf('Shift');
		const other = shiftIndex === -1 ? undefined : step[1 - shiftIndex];
		// A capital form only exists for letters: `Shift+4` is `$` on a US
		// layout and `"` on a German one, and we do not know the layout.
		if (other?.length === 1 && other.toUpperCase() !== other.toLowerCase()) {
			return other.toUpperCase();
		}
	}
	return formatShortcutKeys(step);
}

/**
 * Format a key SEQUENCE for display: `[['g'], ['g']]` is `g g`, and
 * `[['Shift', 'g']]` is `G`.
 *
 * The sibling of {@link formatShortcutKeys} for the other trigger an action can
 * carry. A sequence is a run of keypresses, not a chord, so the steps are
 * ALWAYS separated by a space - on every platform, unlike a chord, which joins
 * with `+` off macOS. `g+g` would read as two keys held together, which is a
 * different (and unbindable) thing.
 *
 * The separator is a NO-BREAK space (U+00A0) for the reason given on
 * `formatShortcutKeys`: a binding is one unit, and a plain space lets every
 * narrow container break `g g` across two lines. Pass a plain one where the
 * string is not laid out in a box.
 *
 * Returns an empty string for a missing or empty sequence, so a caller can
 * concatenate blindly. Empty steps are dropped rather than printed as a gap.
 */
export function formatShortcutSequence(sequence?: string[][], separator?: string): string {
	if (!sequence?.length) return '';
	return sequence
		.filter((step) => step.length > 0)
		.map(formatSequenceStep)
		.join(separator ?? NO_BREAK_SPACE);
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
