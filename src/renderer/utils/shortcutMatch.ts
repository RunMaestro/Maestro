/**
 * shortcutMatch - does this keyboard event match this key combination?
 *
 * One matcher, three callers. `useKeyboardShortcutHelpers` (`isShortcut` /
 * `isTabShortcut`) used to carry two near-identical copies of this logic, and
 * the AI composer's forced-parallel branch hand-rolled a third, weaker one that
 * knew nothing about Shift-rewritten punctuation or Alt-rewritten characters.
 * A user who rebound an action then got a chord that worked from one surface
 * and silently died on another - the worst kind of keyboard bug, because
 * nothing on screen explains it.
 *
 * The rules that are easy to get wrong, and why each exists:
 *
 * - Modifiers must match EXACTLY, not merely be present. Meta and Ctrl are one
 *   modifier here (Cmd on macOS, Ctrl elsewhere), which is what lets a single
 *   binding table serve both platforms.
 * - Shift rewrites punctuation: Shift+`[` is `{`, Shift+`,` is `<`. The event
 *   reports the produced character, so a binding on `[` has to accept `{`.
 * - Shift rewrites digits too (Shift+1 is `!` on a US layout), so a binding on
 *   a number key has to accept its symbol.
 * - Alt rewrites the character wholesale (macOS Alt+p is `π`, Alt+, is `≤`;
 *   AltGr layouts do their own version), so when Alt is held we fall back to
 *   `e.code`, the PHYSICAL key. This must stay symmetric with
 *   `buildKeysFromEvent` in `shortcutRecorder.ts` - the recorder writes what
 *   this reads.
 *
 * Pure and event-shaped rather than hook-bound so a React synthetic event and a
 * native one both work.
 */

/** The parts of a keyboard event a chord match depends on. */
export interface ShortcutKeyEvent {
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	key: string;
	code?: string;
}

/** Shift+number produces a symbol on a US layout. */
const SHIFT_NUMBER_MAP: Record<string, string> = {
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

/** `e.code` values for punctuation keys, mapped back to their characters. */
const CODE_TO_KEY: Record<string, string> = {
	comma: ',',
	period: '.',
	slash: '/',
	backslash: '\\',
	bracketleft: '[',
	bracketright: ']',
	semicolon: ';',
	quote: "'",
	backquote: '`',
	minus: '-',
	equal: '=',
};

/**
 * True when `e` is the key combination described by `keys`.
 *
 * @param e    - The keyboard event (native or React synthetic)
 * @param keys - A `Shortcut.keys` array, e.g. `['Meta', 'Shift', '.']`. The
 *               last entry is the main key; the rest are modifiers.
 *
 * An EMPTY or missing `keys` never matches. An unassigned action reads as "no
 * modifiers and no main key", so without this a bare keypress would fire an
 * action the user deliberately left unbound.
 */
export function eventMatchesShortcutKeys(e: ShortcutKeyEvent, keys: string[] | undefined): boolean {
	if (!keys?.length) return false;
	const wanted = keys.map((k) => k.toLowerCase());

	const metaPressed = e.metaKey || e.ctrlKey;
	const key = e.key.toLowerCase();

	const configMeta =
		wanted.includes('meta') || wanted.includes('ctrl') || wanted.includes('command');
	if (metaPressed !== configMeta) return false;
	if (e.shiftKey !== wanted.includes('shift')) return false;
	if (e.altKey !== wanted.includes('alt')) return false;

	const mainKey = wanted[wanted.length - 1];

	// Shift-rewritten punctuation: the binding names the unshifted character.
	if (mainKey === '[' && (key === '[' || key === '{')) return true;
	if (mainKey === ']' && (key === ']' || key === '}')) return true;
	if (mainKey === ',' && (key === ',' || key === '<')) return true;
	if (mainKey === '.' && (key === '.' || key === '>')) return true;
	if (SHIFT_NUMBER_MAP[key] === mainKey) return true;

	// Alt-rewritten characters: trust the physical key instead.
	if (e.altKey && e.code) {
		const codeKey = e.code.replace('Key', '').toLowerCase();
		return (CODE_TO_KEY[codeKey] || codeKey) === mainKey;
	}

	return key === mainKey;
}
