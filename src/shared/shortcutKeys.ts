/**
 * Process-agnostic keyboard-shortcut display formatting.
 *
 * The renderer's `shortcutFormatter.ts` used to own both the key maps and the
 * platform lookup, which made it unusable outside the renderer (it reads
 * `window.maestro`). The CLI needs the same strings when it tells a user how
 * to reach a surface by hand ("Alt+Q", "⌥ Q"), so the maps and the pure
 * formatting live here and every caller supplies its own `isMac` answer:
 *
 *   - renderer: `isMacOSPlatform()` (preload bridge)
 *   - CLI / main: `isMacOS()` from `shared/platformDetection`
 *
 * Do NOT hard-code `⌘` / `Cmd+` / `Ctrl+` in UI copy - call through here (or
 * the renderer wrapper) so the other platform reads correctly.
 */

/** macOS key symbols. */
export const MAC_KEY_MAP: Record<string, string> = {
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

/** Windows / Linux key names (more readable as text). */
export const OTHER_KEY_MAP: Record<string, string> = {
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

/** Format a single key name for display on the given platform. */
export function formatKeyFor(key: string, isMac: boolean): string {
	const keyMap = isMac ? MAC_KEY_MAP : OTHER_KEY_MAP;
	if (keyMap[key]) return keyMap[key];
	// Single characters read better uppercased; F-keys and the like pass through.
	if (key.length === 1) return key.toUpperCase();
	return key;
}

/**
 * Format a key array for display. macOS joins with a space (`⌘ ⇧ K`);
 * every other platform joins with `+` (`Ctrl+Shift+K`).
 */
export function formatShortcutKeysFor(keys: string[], isMac: boolean, separator?: string): string {
	const sep = separator ?? (isMac ? ' ' : '+');
	return keys.map((key) => formatKeyFor(key, isMac)).join(sep);
}
