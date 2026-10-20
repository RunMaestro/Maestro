import type React from 'react';

import { MODIFIER_ONLY_KEYS } from './shortcutSequence';

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
 * What {@link recordSequenceStep} decided about one keypress.
 *
 * The caller owes each outcome a different thing, and the two that do nothing
 * visible are the ones that matter:
 *
 *  - `'waiting'`: a modifier-only keydown. Keep recording and leave the
 *    captured steps alone - Shift fires its own keydown before the character it
 *    shifts, so treating it as a step would make `g G` impossible to record.
 *  - `'step'`: one more step captured. Render `steps` and keep recording.
 *  - `'confirmed'`: the user finished. Check `sequence` for conflicts, then
 *    save it and stop recording.
 *  - `'cancelled'`: stop recording and save nothing.
 *  - `'cleared'`: the user asked for the binding to go away. Save an empty
 *    sequence (`[]`, the stored form of "no sequence in this mode") and stop.
 *  - `'rejected'`: the keypress carried Meta, Ctrl, or Alt, so it is a chord
 *    and can never be a step. `keys` is the chord, for naming it in the
 *    message.
 */
export type SequenceRecordResult =
	| { outcome: 'waiting' }
	| { outcome: 'step'; steps: string[][] }
	| { outcome: 'confirmed'; sequence: string[][] }
	| { outcome: 'cancelled' }
	| { outcome: 'cleared' }
	| { outcome: 'rejected'; keys: string[] };

/**
 * Record one keypress of a key SEQUENCE (`g g`, `g t`).
 *
 * A chord recording ends on its first non-modifier keydown, so
 * {@link buildKeysFromEvent} can answer from the event alone. A sequence has no
 * such edge: `g` could be the whole binding or the first half of `g t`, and
 * nothing in the event says which. So the run is captured step by step and
 * ended by the USER, and this function is the per-keypress half of that - pure,
 * with the captured steps passed in and handed back, so the caller holds them
 * in its own state (the Shortcuts tab needs them in state anyway, to draw what
 * has been pressed so far).
 *
 * Each step is built by `buildKeysFromEvent`, the same function a chord
 * recording uses, which is what keeps a recorded step readable by
 * `eventMatchesShortcutKeys` - the comparison every step of the matcher goes
 * through. A second spelling of "what key is this" here would drift until a
 * recorded step stopped matching the key that recorded it.
 *
 * The keys this function spends on its own controls, and why each one:
 *
 *  - **Escape cancels**, as it does for a chord recording.
 *  - **Enter confirms**, which is the only thing that can end a run whose next
 *    key is unknowable. It therefore cannot be a sequence step; that is a real
 *    cost and a small one, since Enter is reachable as a chord and a bare Enter
 *    is already the composer's send key.
 *  - **Backspace or Delete undoes the last step**, and clears the binding when
 *    there is nothing left to undo - the same thing a bare Backspace does to a
 *    chord in this screen and in the macOS keyboard settings. A sequence takes
 *    several keypresses, so mistyping one is normal and losing the whole run to
 *    it would not be.
 *
 * Anything carrying Meta, Ctrl, or Alt is REFUSED rather than recorded. The
 * matcher clears the run on such an event (that is what leaves the chord
 * surface untouched), so a step holding one could never fire, and refusing it
 * at the recorder is the only place the user can be told why. Shift is fine:
 * `[['Shift', 'g']]` is `G`.
 *
 * Reserved combos (`RESERVED_SHORTCUT_COMBOS`) need no check here. Every one of
 * them carries Meta, so the refusal above has already covered them.
 */
export function recordSequenceStep(
	e: React.KeyboardEvent,
	steps: readonly string[][]
): SequenceRecordResult {
	// Invisible, not a failure: see `MODIFIER_ONLY_KEYS` in shortcutSequence.ts.
	if (MODIFIER_ONLY_KEYS.has(e.key)) return { outcome: 'waiting' };

	if (e.key === 'Escape') return { outcome: 'cancelled' };

	// Checked before Enter and Backspace so a chord lands on the message that
	// explains it rather than being read as one of the controls below.
	if (e.metaKey || e.ctrlKey || e.altKey) {
		const keys = buildKeysFromEvent(e);
		return keys ? { outcome: 'rejected', keys } : { outcome: 'waiting' };
	}

	if (e.key === 'Enter') {
		// Nothing captured yet, so there is no sequence to save. Treated as a
		// cancel rather than as a clear: the user pressed the confirm key, not
		// the delete key, and saving an empty sequence over an existing one
		// would unbind a binding they never touched.
		return steps.length > 0
			? { outcome: 'confirmed', sequence: steps.map((step) => [...step]) }
			: { outcome: 'cancelled' };
	}

	if (e.key === 'Backspace' || e.key === 'Delete') {
		if (steps.length === 0) return { outcome: 'cleared' };
		return { outcome: 'step', steps: steps.slice(0, -1).map((step) => [...step]) };
	}

	const keys = buildKeysFromEvent(e);
	if (!keys) return { outcome: 'waiting' };
	return { outcome: 'step', steps: [...steps.map((step) => [...step]), keys] };
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
