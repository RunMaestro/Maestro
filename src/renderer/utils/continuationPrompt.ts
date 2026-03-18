/**
 * Build a resume prompt for agents that support native session resume.
 * The agent already has full conversation history from its session files,
 * so we don't need to include partial output. We just need to tell it
 * to continue the interrupted task while incorporating the user's message.
 */
export function buildResumePrompt(userInterjection: string): string {
	return [
		'[System context: You were interrupted during your previous response. Your full conversation history has been restored via session resume.]',
		'',
		"[The user's interjection:]",
		userInterjection,
		'',
		"[Continue from where you left off, incorporating the user's guidance. Complete any tasks that were in progress when interrupted.]",
	].join('\n');
}

/**
 * Build a continuation prompt that combines partial agent output with a user's
 * mid-turn interjection. Used when an agent doesn't support native stdin
 * injection and must be interrupted and restarted.
 */
export function buildContinuationPrompt(partialOutput: string, userInterjection: string): string {
	const trimmedOutput = partialOutput.trim();
	const parts: string[] = [];

	parts.push('[System context: The user interjected during your previous response.');
	if (trimmedOutput) {
		parts.push('Here is what you had produced so far:]');
		parts.push('');
		parts.push('<partial_output>');
		parts.push(trimmedOutput);
		parts.push('</partial_output>');
	} else {
		parts.push('You had not yet produced any output.]');
	}

	parts.push('');
	parts.push("[The user's interjection:]");
	parts.push(userInterjection);
	parts.push('');
	parts.push("[Continue from where you left off, incorporating the user's guidance.]");

	return parts.join('\n');
}
