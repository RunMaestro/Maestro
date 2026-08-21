/**
 * Platform-agnostic keyboard shortcut display formatting.
 *
 * This module owns the key maps. Everything that has to render a keystroke for
 * a human reads them from here and supplies its own answer to "am I on macOS?":
 *
 * - `src/renderer/utils/shortcutFormatter.ts` is the renderer binding. It calls
 *   these functions with `isMacOSPlatform()` and is what UI code should import.
 * - `src/main/app-menu.ts` builds the native macOS menu labels, where the main
 *   process knows the platform directly.
 *
 * The split exists because the renderer cannot read `process.platform` (the
 * process shim reports the sentinel `'browser'`), while the main process cannot
 * import a renderer module. Keeping the maps in one place is what stops the two
 * from drifting into showing different symbols for the same binding.
 */

/** macOS key symbol mappings. */
const MAC_KEY_MAP: Record<string, string> = {
	Meta: '⌘',
	Alt: '⌥',
	Shift: '⇧',
	Control: '⌃',
	Ctrl: '⌃',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	Backspace: '⌫',
	Delete: '⌦',
	Enter: '↩',
	Return: '↩',
	Escape: '⎋',
	Tab: '⇥',
	Space: '␣',
};

/** Windows/Linux key mappings (more readable text). */
const OTHER_KEY_MAP: Record<string, string> = {
	Meta: 'Ctrl',
	Alt: 'Alt',
	Shift: 'Shift',
	Control: 'Ctrl',
	Ctrl: 'Ctrl',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	Backspace: 'Backspace',
	Delete: 'Delete',
	Enter: 'Enter',
	Return: 'Enter',
	Escape: 'Esc',
	Tab: 'Tab',
	Space: 'Space',
};

/**
 * Format a single key for display on the given platform.
 *
 * @param key - Internal key name, e.g. `Meta`, `ArrowRight`, `k`
 * @param isMac - Whether to use macOS symbols
 */
export function formatKeyFor(key: string, isMac: boolean): string {
	const keyMap = isMac ? MAC_KEY_MAP : OTHER_KEY_MAP;

	if (keyMap[key]) return keyMap[key];

	// Single characters read better uppercased ('k' -> 'K').
	if (key.length === 1) return key.toUpperCase();

	// Anything else (F1, F12, ...) is already display-ready.
	return key;
}

/**
 * Format an array of keys for display on the given platform.
 *
 * @param keys - Key names, e.g. `['Meta', 'Shift', 'k']`
 * @param isMac - Whether to use macOS symbols
 * @param separator - Defaults to `' '` on macOS and `'+'` elsewhere
 *
 * @example
 * formatShortcutKeysFor(['Meta', 'Shift', 'k'], true) // '⌘ ⇧ K'
 * formatShortcutKeysFor(['Meta', 'Shift', 'k'], false) // 'Ctrl+Shift+K'
 */
export function formatShortcutKeysFor(keys: string[], isMac: boolean, separator?: string): string {
	const sep = separator ?? (isMac ? ' ' : '+');
	return keys.map((key) => formatKeyFor(key, isMac)).join(sep);
}
