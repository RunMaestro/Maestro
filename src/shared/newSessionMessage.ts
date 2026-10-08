/**
 * The agent-level "New Session Message" is user-authored text that should ride
 * along with the first turn of any brand-new provider session (see the
 * NEW SESSION MESSAGE field in the Edit Agent modal).
 *
 * Interactive typing prefixes it onto the first message of a fresh tab. Auto Run
 * spawns a fresh provider session for every spec task and every goal iteration,
 * so each spawn is effectively a "new session" and must receive the same prefix
 * - otherwise the user's standing instructions silently never reach the agent.
 *
 * This is the single source of truth for that prefix format. Returns the prompt
 * unchanged when there is no message to add.
 */
export function prependNewSessionMessage(prompt: string, newSessionMessage?: string): string {
	if (!newSessionMessage?.trim()) {
		return prompt;
	}
	return `${newSessionMessage}\n\n---\n\n${prompt}`;
}
