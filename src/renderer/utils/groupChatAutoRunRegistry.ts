/**
 * Registry for batch runs triggered by group chat !autorun directives.
 *
 * When the group chat moderator issues `!autorun @AgentName`, the main process
 * emits an event that causes the renderer to start a proper batch run via
 * useBatchProcessor. This registry maps the session ID back to the originating
 * group chat context so that when the batch completes, the result can be reported
 * back to trigger the synthesis round.
 */

interface GroupChatAutoRunEntry {
	groupChatId: string;
	participantName: string;
}

const registry = new Map<string, GroupChatAutoRunEntry>();

/**
 * Register that a batch run (by sessionId) was triggered by group chat !autorun.
 * Called before startBatchRun so the onComplete handler can find the context.
 */
export function registerGroupChatAutoRun(
	sessionId: string,
	groupChatId: string,
	participantName: string
): void {
	registry.set(sessionId, { groupChatId, participantName });
}

/**
 * Consume (retrieve and remove) the group chat context for a completed batch run.
 * Returns undefined if this session was not triggered by group chat !autorun.
 */
export function consumeGroupChatAutoRun(sessionId: string): GroupChatAutoRunEntry | undefined {
	const entry = registry.get(sessionId);
	if (entry) {
		registry.delete(sessionId);
	}
	return entry;
}

/**
 * Get all session IDs with in-flight autorun batch runs for a given group chat.
 * Used by stopAll to cancel orphaned batch runs that aren't tracked as group-chat sessions.
 */
export function getAutoRunSessionsForGroupChat(groupChatId: string): string[] {
	const sessionIds: string[] = [];
	for (const [sessionId, entry] of registry) {
		if (entry.groupChatId === groupChatId) {
			sessionIds.push(sessionId);
		}
	}
	return sessionIds;
}
