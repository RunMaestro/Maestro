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

/**
 * Chords Maestro must never bind, because something outside the renderer
 * already owns them.
 *
 * Two families live here:
 *
 *  - Text-field chords. `Cmd/Ctrl+Shift+Arrow` extends a text selection to the
 *    top or bottom of the field (and to the start or end of the line
 *    horizontally). A Maestro binding on one of these wins over the native
 *    behavior everywhere, including in the composer, so the user loses
 *    select-to-end in every input in the app and gets an agent-navigation jump
 *    instead. There is no way to tell that apart from a broken text box.
 *  - App-menu chords. The macOS application menu built in `src/main/app-menu.ts`
 *    registers these as roles (`hide`, `hideOthers`, `minimize`, the custom Quit
 *    item, and the Edit menu's cut / copy / paste / paste-and-match-style /
 *    select-all). A registered NSMenu accelerator is swallowed before the
 *    renderer ever sees the keydown, so a Maestro binding on one of them simply
 *    never fires and reads to the user as a dead shortcut.
 *
 * One binding table serves every platform, so a chord owned on macOS is
 * reserved everywhere: the alternative is a chord that works on Windows and is
 * silently dead on a Mac, which is worse than not offering it at all.
 *
 * `Meta` here covers `Ctrl` too - `eventMatchesShortcutKeys` treats them as one
 * modifier, so a single entry reserves the chord on every platform. A chord
 * that also holds `Control` alongside `Meta` (the pane-tiling family) is a
 * DIFFERENT chord and is not reserved by the plain-`Meta` entry below.
 */
export const RESERVED_SHORTCUT_COMBOS: readonly { keys: string[]; reason: string }[] = [
	{ keys: ['Meta', 'Shift', 'ArrowUp'], reason: 'extends the text selection to the top' },
	{ keys: ['Meta', 'Shift', 'ArrowDown'], reason: 'extends the text selection to the bottom' },
	{
		keys: ['Meta', 'Shift', 'ArrowLeft'],
		reason: 'extends the text selection to the start of the line',
	},
	{
		keys: ['Meta', 'Shift', 'ArrowRight'],
		reason: 'extends the text selection to the end of the line',
	},
	{ keys: ['Meta', 'h'], reason: 'the app menu hides Maestro' },
	{ keys: ['Alt', 'Meta', 'h'], reason: 'the app menu hides every other app' },
	{ keys: ['Meta', 'q'], reason: 'the app menu quits Maestro' },
	{ keys: ['Meta', 'm'], reason: 'the app menu minimizes the window' },
	{ keys: ['Meta', 'x'], reason: 'the Edit menu cuts the selection' },
	{ keys: ['Meta', 'c'], reason: 'the Edit menu copies the selection' },
	{ keys: ['Meta', 'v'], reason: 'the Edit menu pastes' },
	{ keys: ['Meta', 'a'], reason: 'the Edit menu selects all' },
	{
		keys: ['Alt', 'Meta', 'Shift', 'v'],
		reason: 'the Edit menu pastes and matches style',
	},
];

/**
 * A chord reduced to a canonical string for comparison: Meta and Ctrl collapse
 * to one modifier, matching how `eventMatchesShortcutKeys` reads a real event.
 * Without the collapse, the Windows recording (`Ctrl+Shift+Down`) would slip
 * past a table written in terms of `Meta`.
 *
 * Repeated modifiers are NOT deduplicated. `['Control', 'Meta', 'w']` canonicalizes
 * to `meta+meta+w` and `['Meta', 'w']` to `meta+w`, which is what keeps the
 * pane-tiling family (matched by `isPaneShortcut`, which requires both physical
 * keys held) distinct from the plain Meta chords.
 */
function canonicalChordKeys(keys: readonly string[]): string {
	return [...keys]
		.map((k) => {
			const lower = k.toLowerCase();
			return lower === 'ctrl' || lower === 'control' || lower === 'command' ? 'meta' : lower;
		})
		.sort()
		.join('+');
}

/**
 * Whether two chords fire on the same keypress.
 *
 * This is the comparison a per-mode collision check needs, and it is stricter
 * than `shortcutKeysEqual`: the two chords do not have to be spelled the same
 * way, only to be indistinguishable to `eventMatchesShortcutKeys`. `['Ctrl', 'o']`
 * and `['Meta', 'o']` are one binding at runtime (Cmd on macOS, Ctrl elsewhere),
 * so a check built on key equality reports them as free and lets two actions
 * claim the same keypress.
 *
 * An empty chord is "registered but unassigned" and collides with nothing,
 * including another empty chord - several shipped actions ship unbound on
 * purpose and must not be read as fighting each other.
 */
export function shortcutKeysCollide(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined
): boolean {
	if (!a?.length || !b?.length) return false;
	return canonicalChordKeys(a) === canonicalChordKeys(b);
}

/**
 * The reserved combo `keys` collides with, or null when the chord is free.
 *
 * Checked at BOTH ends: the recorder refuses a fresh binding, and the settings
 * migration strips one that is already persisted. The migration is the half
 * that is easy to skip and the half that matters to anyone who already bound
 * the chord - a recorder-only guard leaves their input boxes broken forever.
 */
export function findReservedShortcutCombo(
	keys: readonly string[] | undefined
): { keys: string[]; reason: string } | null {
	if (!keys?.length) return null;
	return RESERVED_SHORTCUT_COMBOS.find((c) => shortcutKeysCollide(c.keys, keys)) ?? null;
}
