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
 * Whether two key SEQUENCES are the same run of keypresses.
 *
 * Two comparisons, not one, because the two levels of a sequence mean
 * different things. Step ORDER is the sequence: `g t` and `t g` are different
 * runs, so the steps compare in order. Within a step the keys are a chord, so
 * they compare through {@link shortcutKeysEqual} and their order is an
 * artifact of how the recorder read them.
 *
 * A missing sequence and an EMPTY one are equal here, because this answers
 * about an EFFECTIVE binding, where both mean "this action has no sequence".
 * The distinction they carry in an override bucket (absent means inherit the
 * default-mode binding, `[]` means cleared in this mode) is
 * `resolveEffectiveShortcuts`'s business, and the one caller that writes
 * overrides translates a cleared effective binding into an explicit `[]`
 * itself.
 *
 * This is NOT a conflict check. A sequence that is a PREFIX of another is a
 * different binding and compares unequal here, while still being unusable
 * beside it - see {@link shortcutSequencesCollide}.
 */
export function shortcutSequencesEqual(
	a: readonly string[][] | undefined,
	b: readonly string[][] | undefined
): boolean {
	if (!a?.length || !b?.length) return !a?.length && !b?.length;
	if (a.length !== b.length) return false;
	return a.every((step, i) => shortcutKeysEqual(step, b[i]));
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
 * Shift-rewritten characters, mapped to the key a BINDING names.
 *
 * Shift+`,` produces `<`, so a user recording that press gets `['Shift', '<']`
 * while the shipped table spells the same press `['Shift', ',']`.
 * `eventMatchesShortcutKeys` fires on either, which makes them one binding at
 * runtime - so every comparison in this file has to read them as one too, or a
 * collision check reports two actions fighting over one keypress as free and
 * leaves whichever the matcher resolves second permanently unreachable.
 *
 * Exported so the matcher reads the SAME table it is modelling here. A second
 * copy is what let the two drift in the first place.
 *
 * This is deliberately only the set the matcher aliases. `_`, `+`, `:`, `"`,
 * `?`, `|` and `~` are Shift-rewritten too, but the matcher does NOT accept
 * them for their unshifted key, so folding them together here would refuse a
 * binding that is genuinely free.
 */
export const SHIFT_REWRITTEN_KEYS: Readonly<Record<string, string>> = {
	'{': '[',
	'}': ']',
	'<': ',',
	'>': '.',
	'!': '1',
	'@': '2',
	'#': '3',
	$: '4',
	'%': '5',
	'^': '6',
	'&': '7',
	'*': '8',
	'(': '9',
	')': '0',
};

/**
 * A chord reduced to a canonical string for comparison: Meta and Ctrl collapse
 * to one modifier, matching how `eventMatchesShortcutKeys` reads a real event.
 * Without the collapse, the Windows recording (`Ctrl+Shift+Down`) would slip
 * past a table written in terms of `Meta`.
 *
 * A Shift-rewritten character collapses onto the key a binding names, for the
 * reason on `SHIFT_REWRITTEN_KEYS`: `['Shift', '<']` and `['Shift', ',']` are
 * one keypress to the matcher, so they are one chord here.
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
			if (lower === 'ctrl' || lower === 'control' || lower === 'command') return 'meta';
			return SHIFT_REWRITTEN_KEYS[lower] ?? lower;
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
 * Whether two key sequences fight over the same run of keypresses.
 *
 * A sequence conflict is a PREFIX relation, not an equality, which is the one
 * thing that makes this different from every other check in this file. The
 * matcher resolves ambiguity SHORT: a step that both completes one sequence and
 * continues a longer one fires the completion immediately, because waiting out
 * the timeout to see whether more keys arrive would make the shorter action feel
 * broken for a full second on every press. So binding `g` beside `g g` does not
 * produce a race, it produces a sequence that can never fire, and the only place
 * that can be reported is the point where it is recorded.
 *
 * Steps compare one by one over the SHARED length, with the same Meta/Ctrl
 * collapse `shortcutKeysCollide` applies, so `g g` collides with `g`, with
 * `g g` and with `g g g`, and not with `g t`.
 *
 * A chord never reaches this function, and the shapes are different so it
 * cannot: a sequence step carries no Meta, Ctrl, or Alt (the matcher clears the
 * run on any event that does), and a chord in `keys` always carries one, because
 * bare keys are bound through `sequence` precisely so they can be gated on
 * normal mode. The one way to break that is to record a bare chord by hand, and
 * the result is not a conflict but a split: in normal mode the sequence layer
 * runs first and the sequence wins, while the chord still fires inside every
 * text field, where the sequence gate is closed.
 *
 * An empty sequence is "registered but unassigned" and collides with nothing,
 * including another empty one, matching `shortcutKeysCollide`. A sequence
 * carrying an EMPTY STEP is dead rather than free - `eventMatchesShortcutKeys`
 * never matches an empty chord, so the run can never advance past it - and
 * reporting it as a conflict would refuse a sequence that is in fact available.
 */
export function shortcutSequencesCollide(
	a: readonly string[][] | undefined,
	b: readonly string[][] | undefined
): boolean {
	if (!a?.length || !b?.length) return false;
	const shared = Math.min(a.length, b.length);
	for (let i = 0; i < shared; i++) {
		if (!a[i]?.length || !b[i]?.length) return false;
		if (canonicalChordKeys(a[i]) !== canonicalChordKeys(b[i])) return false;
	}
	return true;
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
