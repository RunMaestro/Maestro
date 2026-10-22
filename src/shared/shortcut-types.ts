/**
 * Shared keyboard shortcut type used by renderer, main (web server), and web client.
 */

export interface Shortcut {
	id: string;
	label: string;
	/**
	 * The key combination, or an EMPTY ARRAY when the action is registered but
	 * unassigned.
	 *
	 * An empty array rather than an optional field, deliberately: this type is
	 * shared with the CLI and the web server, and ~108 call sites already read
	 * `.keys` directly. Making it optional would turn every one of them into a
	 * compile error to describe a state most of them do not care about, whereas
	 * `[]` flows through display, filtering, and formatting as "nothing to
	 * show".
	 *
	 * The one place it MUST be handled is key matching: an empty combination
	 * would otherwise compare as "no modifiers, no main key" and let a bare
	 * keypress fire an action the user never bound. See the guards at the top of
	 * `isShortcut` / `isTabShortcut`.
	 */
	keys: string[];
	/**
	 * A KEY SEQUENCE that also fires this action: one entry per step, each step
	 * in the same shape as {@link keys}. `[['g'], ['g']]` is `g g`;
	 * `[['Shift', 'g']]` is a one-step `G`.
	 *
	 * A sequence is an ADDITIONAL trigger, never a replacement. An action may
	 * have a chord, a sequence, or both, and when it has both, BOTH fire. The
	 * two are matched by different code on different terms: `keys` goes through
	 * `eventMatchesShortcutKeys` on every keydown, while a sequence goes through
	 * the matcher in `src/renderer/utils/shortcutSequence.ts` and only when
	 * focus is not in a text field and no modal layer is open.
	 *
	 * Why a separate optional field rather than widening `keys` to
	 * `string[] | string[][]`: `keys` is read directly by ~190 call sites across
	 * the CLI (`maestro-cli open` prints the hotkey), display formatting
	 * (`formatShortcutKeysFor`), the Settings filtering and search, the
	 * recorder, and conflict detection (`shortcutKeysCollide`,
	 * `findReservedShortcutCombo`). Every one of them would become a compile
	 * error, and the ones that merely pass the array through would have to learn
	 * about a shape they have no use for. A new field leaves all of them
	 * correct and untouched, and the surfaces that DO care opt in.
	 *
	 * Bare keys - no Meta, Ctrl, or Alt - are only ever bound through
	 * `sequence`, even when the binding is a single step. That is not a style
	 * rule, it is the focus gate: a `keys` binding fires regardless of where
	 * focus sits, so a bare `j` in `keys` would type nothing and scroll the
	 * agent list while the user was writing a prompt. A `sequence` binding is
	 * gated on normal mode, so the same `j` stays out of the way of every text
	 * field.
	 *
	 * Undefined (not `[]`) is the normal state: almost no action has a sequence,
	 * so the field is absent rather than carrying an empty array everywhere.
	 */
	sequence?: string[][];
	/**
	 * Multi-window: when true, the shortcut acts only on the current window's
	 * agents (its scope is the window, not the whole app). Agent cycling and the
	 * Command-K / agent switcher are window-scoped - picking an agent that is open
	 * in another window focuses that window instead of moving the agent. Used by
	 * the shortcut-help modal to render a "Window" badge. Optional/informational:
	 * it never affects key matching, only display.
	 */
	windowScoped?: boolean;
}

/**
 * Which keyboard binding set is live.
 *
 * Exactly ONE mode is active at a time. The two sets are never both live, which
 * is what lets Vim mode reuse a chord that default mode gives to a different
 * action: no keypress can ever reach two actions, because only one table is
 * being matched against.
 */
export type KeyboardMode = 'default' | 'vim';

/**
 * Every keyboard mode, in the order the Settings toggle offers them. One list
 * so the toggle, the persisted setting, and the CLI cannot disagree about which
 * modes exist.
 */
export const KEYBOARD_MODES: readonly KeyboardMode[] = ['default', 'vim'];

/**
 * The one spelling of each mode's name in user-facing copy.
 *
 * Every surface that switches modes says the mode's name (the Settings toggle,
 * the Quick Actions entry, the menu item, the toast that confirms the switch),
 * and a `Record` keyed by the union is what makes a new mode a compile error in
 * each of them rather than a mode that renders as its raw id in one place.
 */
export const KEYBOARD_MODE_LABELS: Record<KeyboardMode, string> = {
	default: 'Default',
	vim: 'Vim',
};

/**
 * Narrow an unknown value to a {@link KeyboardMode}, or `undefined` if it is
 * not one.
 *
 * Everything that arrives from outside the renderer's own state has to come
 * through here rather than being cast: the setting is on disk, so it can be
 * hand-edited, written by an older build, or mangled by settings sync, and a
 * cast would put an unknown string into the mode field where every consumer
 * reads it as "not default" and matches an override table that does not exist.
 * Callers that need a value no matter what fall back to `'default'`, which is
 * the mode that ships.
 */
export function asKeyboardMode(value: unknown): KeyboardMode | undefined {
	return KEYBOARD_MODES.includes(value as KeyboardMode) ? (value as KeyboardMode) : undefined;
}

/**
 * One action's binding in a non-default keyboard mode.
 *
 * Override tables are SPARSE: an action appears only when the mode binds it
 * differently from default mode. Every other action inherits its default chord,
 * so switching modes never silently unbinds anything.
 *
 * `keys` is optional here, unlike on `Shortcut`, and the distinction carries
 * meaning in the persisted buckets:
 *
 *  - omitted: inherit the default-mode chord for this action
 *  - a chord: replace the default-mode chord in this mode
 *
 * `keys: []` is NOT a state the shipped tables use. On `Shortcut` an empty array
 * means "registered but unassigned", but an override already has a way to say
 * "no opinion" (omit the field), so an empty array would be a second spelling of
 * the same thing. It can still arrive from persisted settings, where it means
 * the user cleared the binding in this mode, and the hydration path keeps it.
 *
 * `sequence` is the same three states for the key sequence (see
 * {@link Shortcut.sequence}), and it is resolved INDEPENDENTLY of `keys`:
 *
 *  - omitted: inherit the default-mode sequence for this action
 *  - a sequence: replace the default-mode sequence in this mode
 *  - `sequence: []`: the user cleared the sequence in this mode
 *
 * Independently, because the two triggers are separate. Giving a Vim action a
 * `g g` sequence must not take away the chord it already answers to, and
 * re-binding its chord must not take away its sequence. An override that sets
 * only one field leaves the other inherited.
 *
 * `label` is carried so an override reads on its own, but it is informational:
 * the merge takes the label from the default tables, and a structural test
 * asserts the two agree.
 */
export interface ShortcutOverride {
	id: string;
	label: string;
	keys?: string[];
	sequence?: string[][];
}
