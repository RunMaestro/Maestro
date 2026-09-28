/**
 * Command mode ("bang commands") for the AI chat composer.
 *
 * Typing `!` into an empty composer switches it into command mode: the bang
 * itself is consumed (it never appears in the text) and what you type after it
 * runs as a shell command in the agent's working directory instead of being
 * sent to the agent. This is the "check something without leaving the chat"
 * escape hatch - `git pull`, `ls`, `npm test`.
 *
 * ## The bang ladder
 *
 * `!` is a rung, not a toggle. Each press on an EMPTY composer climbs one
 * rung, and Escape on an empty composer climbs back down. Focus never leaves
 * the textarea at any point.
 *
 *   agent chat  --!->  'shell'  --!->  'ai'
 *   agent chat  <-Esc-  'shell'  <-Esc-  'ai'
 *
 *  - `'shell'` is classic command mode: the draft IS the command line.
 *  - `'ai'` is AI command mode: the draft is a plain-English description of
 *    what you want to accomplish. Enter asks the tab's own model (at its
 *    current model and effort) for one command line, which Maestro shows for
 *    confirmation before running it exactly like a `'shell'` command.
 *
 * There is no rung above `'ai'`, so a `!` typed there is ordinary text - the
 * request is prose, and prose contains bangs.
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
 *  - `!` typed *inside* a mode is only a rung when the composer is empty;
 *    anywhere else it is ordinary text.
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
 * Which rung of the bang ladder the AI composer is on.
 *
 *  - `'off'`   - ordinary chat; the draft is a message for the agent.
 *  - `'shell'` - command mode; the draft is a shell command line.
 *  - `'ai'`    - AI command mode; the draft describes what the user wants and
 *                the model turns it into a command line for confirmation.
 */
export type ComposerCommandMode = 'off' | 'shell' | 'ai';

/**
 * Read a persisted `AITab.commandMode` back into a mode.
 *
 * Tabs written before AI command mode existed stored a boolean, so `true` has
 * to keep meaning `'shell'`. Anything unrecognised falls back to `'off'`: a
 * corrupt value must land the user in ordinary chat, never in a shell.
 */
export function normalizeComposerCommandMode(raw: unknown): ComposerCommandMode {
	if (raw === true) return 'shell';
	if (raw === 'shell' || raw === 'ai') return raw;
	return 'off';
}

/** True while the draft is a literal shell command line. */
export function isShellCommandMode(mode: ComposerCommandMode): boolean {
	return mode === 'shell';
}

/** True while the draft is a natural-language request for a command. */
export function isAiCommandMode(mode: ComposerCommandMode): boolean {
	return mode === 'ai';
}

/**
 * The rung a `!` gesture climbs to, or null when there is none above `mode`.
 *
 * Returning null is what keeps a bang typed in AI command mode as plain text:
 * the request is prose, so the character has to survive.
 */
export function nextComposerCommandMode(mode: ComposerCommandMode): ComposerCommandMode | null {
	if (mode === 'off') return 'shell';
	if (mode === 'shell') return 'ai';
	return null;
}

/** The rung Escape climbs back down to. `'off'` is the floor. */
export function previousComposerCommandMode(mode: ComposerCommandMode): ComposerCommandMode {
	if (mode === 'ai') return 'shell';
	return 'off';
}

/**
 * Decides whether a composer edit should climb a rung of the bang ladder, and
 * returns the text to keep if so (the bang is consumed). Returns null to leave
 * the composer alone.
 *
 * Entry requires the composer to have been **empty** before the edit, so the
 * gesture is unambiguously "I am starting a command". That deliberately rules
 * out retrofitting a bang onto a message already in progress: moving the caret
 * to the start of `deploy the site` and typing `!` leaves it a message for the
 * agent rather than silently turning a sentence into a shell command. It is
 * also what makes the second rung safe - `echo !` never climbs, because the
 * composer was not empty.
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
