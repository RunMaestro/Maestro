/**
 * The envelope Maestro uses to deliver its system prompt to a provider that has
 * no `--append-system-prompt` flag, and the reader that takes it back apart.
 *
 * Only `claude-code` declares `supportsAppendSystemPrompt`. For every other
 * provider the spawn path has nowhere to put system content except the first
 * user turn, so it sends the whole Maestro system prompt, a `---` rule, and a
 * `# User Request` heading ahead of whatever the human actually typed. That
 * turn is real conversation as far as the provider is concerned: it is written
 * verbatim into the session transcript on disk and read back whenever a tab is
 * hydrated from it.
 *
 * Which is the bug this module exists to close (issue #1533). A tab that ran
 * live shows the clean prompt, because the renderer logged the user's own text
 * before wrapping it. The same conversation hydrated from disk - resuming a
 * session, or scrolling to the top and paging older history in - showed the
 * envelope instead: the entire system prompt, the conductor profile, the cwd,
 * the history file path, and the agent's own id, rendered as if the user had
 * typed them. So the two creation paths disagreed about the same turn, and the
 * hydrated one leaked injected context the user never wrote.
 *
 * Producing and reading the envelope therefore live together. Two spawn sites
 * used to build the string by hand (the desktop IPC spawn and the CLI's
 * `agent-spawner`), and a third copy on the reading side would be free to drift
 * from both. The module is import-free so the CLI bundle can use it too.
 */

/**
 * Separates the embedded system prompt from the user's own request. Changing
 * this string changes what is already on disk in every existing transcript, so
 * treat it as a wire format: old sessions keep the old separator forever.
 */
export const EMBEDDED_SYSTEM_PROMPT_SEPARATOR = '\n\n---\n\n# User Request\n\n';

/** Build the first-turn prompt for a provider with no system-prompt flag. */
export function embedSystemPromptInPrompt(systemPrompt: string, userPrompt: string): string {
	return `${systemPrompt}${EMBEDDED_SYSTEM_PROMPT_SEPARATOR}${userPrompt}`;
}

/**
 * Recover the user's own request from a transcript message that carries the
 * envelope, or return the text untouched when it does not.
 *
 * The separator has to be preceded by something for this to be an envelope at
 * all: a message that OPENS with `# User Request` was never wrapped, and
 * stripping there would delete the user's first line. Only the first occurrence
 * is honoured, because the spawn path emits exactly one and anything further
 * down belongs to the user's own text.
 */
export function stripEmbeddedSystemPrompt(text: string): string {
	if (!text) return text;
	const index = text.indexOf(EMBEDDED_SYSTEM_PROMPT_SEPARATOR);
	if (index <= 0) return text;
	return text.slice(index + EMBEDDED_SYSTEM_PROMPT_SEPARATOR.length);
}

/** True when `text` carries the envelope (and so hides a user request inside). */
export function hasEmbeddedSystemPrompt(text: string): boolean {
	return !!text && text.indexOf(EMBEDDED_SYSTEM_PROMPT_SEPARATOR) > 0;
}
