import type React from 'react';

/**
 * Build a shortcut key array from a keyboard event.
 * Returns null if only modifier keys are pressed (caller should keep recording).
 *
 * When Alt is held, the main key is derived from e.code rather than e.key.
 * This recovers the physical key name across layouts where Alt rewrites the
 * character - most notably macOS (Alt+L = ¬, Alt+P = π) but also AltGr-based
 * layouts on Windows/Linux. Applied unconditionally so recording stays
 * symmetric with isShortcut's matching path in useKeyboardShortcutHelpers.ts.
 */
export function buildKeysFromEvent(e: React.KeyboardEvent): string[] | null {
	if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;

	const keys: string[] = [];
	if (e.metaKey) keys.push('Meta');
	if (e.ctrlKey) keys.push('Ctrl');
	if (e.altKey) keys.push('Alt');
	if (e.shiftKey) keys.push('Shift');

	let mainKey = e.key;
	if (e.altKey && e.code) {
		if (e.code.startsWith('Key')) {
			mainKey = e.code.replace('Key', '').toLowerCase();
		} else if (e.code.startsWith('Digit')) {
			mainKey = e.code.replace('Digit', '');
		}
	}
	keys.push(mainKey);
	return keys;
}

/**
 * Punctuation keys whose `e.code` name isn't derivable from the character.
 * Inverse of the codeToKey table in useKeyboardShortcutHelpers.ts - keep the
 * two in sync so a replayed event matches the same shortcut a real one would.
 */
const KEY_TO_CODE: Record<string, string> = {
	',': 'Comma',
	'.': 'Period',
	'/': 'Slash',
	'\\': 'Backslash',
	'[': 'BracketLeft',
	']': 'BracketRight',
	';': 'Semicolon',
	"'": 'Quote',
	'`': 'Backquote',
	'-': 'Minus',
	'=': 'Equal',
};

/** Derive the `e.code` value a real press of `key` would carry. */
function codeForKey(key: string): string {
	if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
	if (/^[0-9]$/.test(key)) return `Digit${key}`;
	if (KEY_TO_CODE[key]) return KEY_TO_CODE[key];
	// Arrow*, Backspace, Enter, Tab, Escape and F-keys already use their own name.
	return key;
}

/**
 * Build a synthetic keydown event from a shortcut's key array - the inverse of
 * buildKeysFromEvent.
 *
 * Used to replay a shortcut through the normal window keydown handler when it
 * was invoked by something other than the keyboard (today: the native
 * application menu). Both `key` and `code` are populated because isShortcut
 * falls back to `code` for Alt combos, where a real event's `key` would be
 * rewritten by the layout.
 */
export function buildEventFromKeys(keys: string[]): KeyboardEvent | null {
	if (keys.length === 0) return null;

	const modifiers = new Set(keys.slice(0, -1).map((k) => k.toLowerCase()));
	const mainKey = keys[keys.length - 1];

	return new KeyboardEvent('keydown', {
		key: mainKey,
		code: codeForKey(mainKey),
		metaKey: modifiers.has('meta') || modifiers.has('command'),
		ctrlKey: modifiers.has('ctrl') || modifiers.has('control'),
		altKey: modifiers.has('alt'),
		shiftKey: modifiers.has('shift'),
		bubbles: true,
		cancelable: true,
	});
}
