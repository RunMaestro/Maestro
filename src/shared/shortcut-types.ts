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
}
