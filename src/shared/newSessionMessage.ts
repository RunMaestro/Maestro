/**
 * The agent-level "New Session Message" is user-authored text that should ride
 * along with the first turn of any brand-new provider session (see the
 * NEW SESSION MESSAGE field in the Edit Agent modal).
 *
 * Interactive typing prefixes it onto the first message of a fresh tab. Auto Run
 * spawns a fresh provider session for every spec task and every goal iteration,
 * and a Cue run spawns one per trigger, so each of those spawns is effectively a
 * "new session" and must receive the same prefix - otherwise the user's standing
 * instructions silently never reach the agent.
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

/**
 * The same prefix for a turn that may be RESUMING a conversation: applied only
 * when the tab has no provider session yet, because a resumed conversation
 * already carries the message from its first turn.
 *
 * Every path that can spawn a tab's first turn goes through this - the composer,
 * the execution queue drain, and the CLI / web dispatch - so whether a message
 * was typed into an idle agent or reached a fresh tab through the queue cannot
 * decide whether the agent ever sees its standing instructions.
 */
export function prependNewSessionMessageOnFirstTurn(
	prompt: string,
	newSessionMessage: string | undefined,
	agentSessionId: string | null | undefined
): string {
	return agentSessionId ? prompt : prependNewSessionMessage(prompt, newSessionMessage);
}
