/**
 * Command mode ("bang commands") for the AI chat composer.
 *
 * Typing `!` into an empty composer switches it into command mode: the bang
 * itself is consumed (it never appears in the text) and what you type after it
 * runs as a shell command in the agent's working directory instead of being
 * sent to the agent. This is the "check something without leaving the chat"
 * escape hatch - `git pull`, `ls`, `npm test`.
 *
 * ## Command mode is state, not a text prefix
 *
 * The bang is a *gesture* that enters the mode, not a marker the text carries.
 * Once in command mode the composer holds the bare command, and the mode lives
 * in `composerInputStore.aiCommandMode` (mirrored to `AITab.commandMode` so it
 * survives a tab switch and a restart). Consequences worth knowing:
 *
 *  - Do NOT infer the mode by testing the draft for a leading `!` - a command
 *    like `find . -name '*!*'` has bangs in it, and the composer's text no
 *    longer starts with one anyway.
 *  - `!` typed *inside* command mode is ordinary shell text, not a re-entry.
 *  - The mode is exited explicitly (Escape / Backspace on an empty line), not
 *    by deleting a character.
 *
 * Escaping: `\!` at the start of a message is a literal `!` for the agent. It
 * does not enter command mode, and the backslash is removed before sending.
 * This is the only way to start an agent message with a bang.
 */

/** The keystroke that switches the AI composer into command mode. */
export const SHELL_COMMAND_PREFIX = '!';

/** The escape that sends a literal leading `!` to the agent instead. */
export const SHELL_COMMAND_ESCAPE = '\\!';

/**
 * Decides whether a composer edit should switch into command mode, and returns
 * the text to keep if so (the bang is consumed). Returns null to leave the
 * composer alone.
 *
 * Entry requires the composer to have been **empty** before the edit, so the
 * gesture is unambiguously "I am starting a command". That deliberately rules
 * out retrofitting a bang onto a message already in progress: moving the caret
 * to the start of `deploy the site` and typing `!` leaves it a message for the
 * agent rather than silently turning a sentence into a shell command.
 *
 * Pasting `!git status` into an empty composer does enter command mode, with
 * `git status` kept - the paste carries the same intent as typing it.
 *
 * @param previousValue - composer text before this edit
 * @param nextValue     - composer text the edit produced
 */
export function detectCommandModeEntry(previousValue: string, nextValue: string): string | null {
	if (previousValue.trim() !== '') return null;

	const leading = nextValue.slice(0, nextValue.length - nextValue.trimStart().length);
	const rest = nextValue.trimStart();
	if (!rest.startsWith(SHELL_COMMAND_PREFIX)) return null;

	// Keep any leading whitespace the user had, minus the consumed bang, so a
	// pasted command lands exactly as pasted.
	return leading + rest.slice(SHELL_COMMAND_PREFIX.length);
}

/**
 * Removes the command-mode escape from a message bound for the agent, so
 * `\!important` reaches the agent as `!important`. Any other input is
 * returned unchanged.
 */
export function stripShellCommandEscape(raw: string): string {
	const leadingWhitespace = raw.slice(0, raw.length - raw.trimStart().length);
	const rest = raw.trimStart();
	if (!rest.startsWith(SHELL_COMMAND_ESCAPE)) return raw;
	return leadingWhitespace + rest.slice(1);
}
