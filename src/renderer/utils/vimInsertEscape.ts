/**
 * `jk` - leaving a text field the way a Vim user leaves insert mode.
 *
 * Vim mode's normal-mode keys (`h`, `j`, `g t`) are bound through `sequence`
 * and gated on focus being OUTSIDE a text field, so the one thing a Vim user
 * cannot do with them is get out of the field they are typing in. Vim's own
 * answer is Escape, and that key is not available: the layer stack has first
 * claim on it (`LayerStackProvider` handles Escape in the CAPTURE phase and
 * stops propagation, so the topmost modal closes), and in the composer Escape
 * already means "blur and focus the transcript" through `handleEscapeInMain`.
 * Neither of those may change, so the in-field escape is the keymap every Vim
 * user already carries: `jk`, typed quickly.
 *
 * ## The one thing that makes it awkward
 *
 * `j` is a character. By the time the `k` arrives the `j` is already in the
 * field, because swallowing it on the chance that a `k` follows would mean
 * every `j` in every prompt arrived a beat late (and never at all if the user
 * paused). So the escape is RETRACTIVE: let `j` through, and when `k` completes
 * the sequence, take the `j` back out and blur. A `j` followed by anything else
 * - or by a `k` after the timeout - leaves every typed character exactly where
 * it is, because nothing was ever held back.
 *
 * This is the same bargain the `jk` mapping makes in every editor that offers
 * it, and it is why the retraction has to be checked rather than assumed:
 * `applyInsertEscape` confirms the characters really are sitting just before
 * the caret and does nothing at all if they are not.
 *
 * ## Where it applies, and where it must not
 *
 * Plain `<input>` and `<textarea>` elements only, which is what the composer
 * is. Explicitly NOT the two surfaces that merely look like text fields:
 *
 * - `.cm-editor`: CodeMirror owns its own keymap, and Phase 06 gives it a real
 *   Vim binding where `jk` means what Vim means by it. Blurring the editor from
 *   out here would fight that.
 * - `.xterm`: a terminal types through a hidden `<textarea>`, so without the
 *   exclusion a user running `vim` inside a Maestro terminal would have the
 *   pane blurred under them by their own insert-mode escape - the exact
 *   keystroke they meant for the shell. This is the failure mode that makes the
 *   selector worth sharing with `isTextEntryTarget` rather than re-spelling.
 *
 * Both are the same `TEXT_ENTRY_SURFACE_SELECTOR` the rest of the keyboard code
 * asks about, imported rather than copied.
 *
 * ## Escape is untouched
 *
 * Nothing in this file, and nothing in the keyboard-mode code, looks at
 * Escape. `SequenceMatcher.feed` clears its buffer and returns `'no-match'` on
 * Escape, the main keydown listener is bound in the BUBBLE phase, and the layer
 * stack's listener is bound in the CAPTURE phase with `stopPropagation()`. So
 * the topmost open layer closes first, and only when nothing is open does
 * Escape reach the blur paths that already existed.
 */

import type { SequenceBinding } from './shortcutSequence';
import { isTextEntryTarget, TEXT_ENTRY_SURFACE_SELECTOR } from './messageScrollNavigation';

/** A field this module is willing to act on. */
export type InsertEscapeField = HTMLInputElement | HTMLTextAreaElement;

/** The action id usage is recorded against, and the matcher's binding id. */
export const VIM_INSERT_ESCAPE_ID = 'vimInsertEscape';

/**
 * The shortest sequence that may be bound.
 *
 * A one-character escape would make that character untypeable in every text
 * field in the app, including the Settings field where the user would go to
 * turn it off - the final step is always swallowed, so there would be no
 * keypress left that produces the letter. A value that short is treated as off
 * rather than honored.
 */
export const MIN_INSERT_ESCAPE_LENGTH = 2;

/**
 * What `vimInsertEscapeSequence` ships as.
 *
 * Here rather than in the store slice so the parser, the store default, and the
 * Settings field's placeholder all read the same constant - `jk` is quoted in
 * the settings metadata and the docs too, and a fourth literal in the code is
 * the one that would be left behind if it ever changed.
 */
export const DEFAULT_VIM_INSERT_ESCAPE_SEQUENCE = 'jk';

/** A parsed `vimInsertEscapeSequence`, ready for the keydown handler. */
export interface InsertEscapeBinding {
	/** The characters as typed, lowercased: `jk`. */
	readonly text: string;
	/**
	 * The characters already in the field when the LAST step arrives, so the
	 * ones to retract. `text` minus its final character.
	 */
	readonly inserted: string;
	/**
	 * The one binding `SequenceMatcher.feed` is given. Held here so the handler
	 * allocates nothing per keydown, and so the array identity is stable for as
	 * long as the setting is.
	 */
	readonly bindings: readonly SequenceBinding[];
}

/**
 * Parse the `vimInsertEscapeSequence` setting, or null when it is off.
 *
 * Off means: not a string, empty, shorter than {@link MIN_INSERT_ESCAPE_LENGTH},
 * or containing whitespace. `''` is the documented way to switch the feature
 * off; the other three are the same answer for a value that cannot work, and
 * silently doing nothing is the only safe reading of a malformed escape
 * sequence - the alternative is a key that eats characters.
 *
 * Lowercased, because `eventMatchesShortcutKeys` lowercases `event.key` and a
 * step with no `'Shift'` in it requires Shift to be UP. So a capital in the
 * setting would describe a keypress nobody can make, while the lowercase form
 * matches both a plain `j` and a Caps Lock `J` (which reports `key: 'J'` with
 * `shiftKey` false).
 */
export function parseInsertEscapeSequence(value: unknown): InsertEscapeBinding | null {
	if (typeof value !== 'string') return null;
	const text = value.trim().toLowerCase();
	if (text.length < MIN_INSERT_ESCAPE_LENGTH) return null;
	if (/\s/.test(text)) return null;
	// `Array.from` rather than `split('')`, so an astral character is one step
	// instead of two unmatchable halves.
	const characters = Array.from(text);
	if (characters.length < MIN_INSERT_ESCAPE_LENGTH) return null;
	return {
		text,
		inserted: characters.slice(0, -1).join(''),
		bindings: [{ id: VIM_INSERT_ESCAPE_ID, sequence: characters.map((char) => [char]) }],
	};
}

/**
 * The field a keydown is typing into, or null when `jk` has no business here.
 *
 * Requires the element to be the one that actually holds focus. The retraction
 * splices a value and blurs, and both of those are only meaningful on the field
 * the user is typing in; a window-level listener sees synthetic events whose
 * target is the window (xterm re-dispatches some), so the target alone is not
 * enough to know.
 *
 * `isTextEntryTarget` decides which `<input>` types count (a range slider is
 * not a text field), so the type rules live in one place; the selector test
 * then subtracts the editor and terminal surfaces that helper passes.
 */
export function insertEscapeTarget(
	target: EventTarget | null,
	doc: Document = document
): InsertEscapeField | null {
	const element = target instanceof Element ? target : doc.activeElement;
	if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
		return null;
	}
	if (element !== doc.activeElement) return null;
	// A read-only or disabled field never received the `j` there is to retract,
	// and the read-only composer is mid-AI-command-proposal, where every key is
	// an answer to the proposal rather than text.
	if (element.readOnly || element.disabled) return null;
	if (!isTextEntryTarget(element)) return null;
	if (element.closest(TEXT_ENTRY_SURFACE_SELECTOR) !== null) return null;
	return element;
}

/**
 * Write `next` into a field React may be controlling, so React sees the change.
 *
 * Assigning `.value` on a React-controlled element is invisible to React: it
 * installs its own `value` setter on the instance and tracks the last value it
 * rendered, so a plain assignment updates the DOM and is then overwritten by
 * the next render with the stale state. Going through the PROTOTYPE descriptor
 * bypasses the instrumented setter, which leaves React's tracker holding the
 * old string - so the `input` event below reads as a real change and `onChange`
 * fires with the spliced value.
 */
function writeFieldValue(field: InsertEscapeField, next: string): void {
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
	if (setter) setter.call(field, next);
	else field.value = next;
	field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Retract `inserted` from just before the caret and blur the field.
 *
 * Returns false and changes NOTHING when the characters are not where they are
 * expected to be: the caret moved, a selection is live, an autocomplete
 * rewrote the value, or the field never took the keystroke. The caller then
 * lets the final key through as the character it is, which is the behavior that
 * makes a near miss cost the user nothing.
 *
 * Compared case-insensitively against a lowercase `inserted`, for the Caps Lock
 * case the matcher already accepts: `J` with Shift up matches a `['j']` step,
 * and the field holds the capital.
 */
export function applyInsertEscape(field: InsertEscapeField, inserted: string): boolean {
	const caret = field.selectionStart;
	// A live selection is not a caret: the user has text highlighted and the
	// next character would replace it, so there is nothing sitting before the
	// caret to take back.
	if (caret === null || caret !== field.selectionEnd) return false;
	if (caret < inserted.length) return false;

	const value = field.value;
	const start = caret - inserted.length;
	if (value.slice(start, caret).toLowerCase() !== inserted) return false;

	writeFieldValue(field, value.slice(0, start) + value.slice(caret));
	// Leave the caret where the retracted characters were, so a field the user
	// clicks back into reads as though they were never typed.
	field.setSelectionRange(start, start);
	field.blur();
	return true;
}
