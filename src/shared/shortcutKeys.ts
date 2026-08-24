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

/**
 * A key combination reduced to a canonical, order-independent string.
 *
 * `['Meta', 'Shift', 'k']` and `['Shift', 'Meta', 'k']` are the SAME chord -
 * the user held three keys down, and the order the recorder happened to read
 * them in is an implementation detail. Sorting is what makes them compare
 * equal.
 *
 * Case is preserved deliberately: the maps store `'k'`, and a shortcut is
 * matched against `event.key`, where `'k'` and `'K'` mean different things
 * (the second implies Shift).
 */
export function normalizeShortcutKeys(keys: readonly string[]): string {
	return [...keys].sort().join('+');
}

/**
 * Whether two key combinations are the same chord, regardless of order.
 *
 * This is the ONLY correct comparison for "is this combination already taken".
 * An ordered compare (`a.every((k, i) => k === b[i])`) reports no conflict for
 * a reordered duplicate, so a collision check built on one passes while looking
 * validated - worse than having no check at all, because the user then trusts
 * it.
 */
export function shortcutKeysEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && normalizeShortcutKeys(a) === normalizeShortcutKeys(b);
}
