/**
 * Process session ids, and the agent each one belongs to.
 *
 * A spawned process is keyed by an id built from its agent's id plus a suffix
 * that says what the process is for:
 *
 *   `{agentId}-ai-{tabId}`        a turn in an AI tab
 *   `{agentId}-batch-{timestamp}` an Auto Run task
 *   `{agentId}-synopsis-{ts}`     the History synopsis that follows a turn
 *   `{agentId}-cue-...`           a Cue run
 *
 * Anything that looks an agent's stored record up from a process id has to
 * strip ALL of them. Stripping only `-ai-` reads an Auto Run task or a synopsis
 * as an agent that does not exist, and whatever the lookup was for is silently
 * skipped: that is how an agent's Local Models gateway was applied to its typed
 * turns and not to its Auto Run turns.
 */

/** `{agentId}-ai-{tabId}`, `{agentId}-batch-...`, etc. -> `{agentId}`. */
export function agentIdFromProcessId(processId: string): string {
	const match = /^(.+?)-(?:ai|batch|cue|synopsis)(?:-|$)/.exec(processId);
	return match ? match[1] : processId;
}
