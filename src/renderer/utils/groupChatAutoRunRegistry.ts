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
const pendingCompletions = new Map<string, string>();

function completionKey(groupChatId: string, participantName: string): string {
	return JSON.stringify([groupChatId, participantName]);
}

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
 * Consume the group chat context and retain a scoped session lookup until the
 * groupChat:autoRunBatchComplete renderer event clears the visible batch state.
 */
export function consumeGroupChatAutoRunForCompletion(
	sessionId: string
): GroupChatAutoRunEntry | undefined {
	const entry = consumeGroupChatAutoRun(sessionId);
	if (entry) {
		pendingCompletions.set(completionKey(entry.groupChatId, entry.participantName), sessionId);
	}
	return entry;
}

/**
 * Resolve an in-flight autorun batch by group chat and participant.
 * Used for timeout events that fire before the batch onComplete consumes the registry.
 */
export function getAutoRunSessionForGroupChatParticipant(
	groupChatId: string,
	participantName: string
): string | undefined {
	for (const [sessionId, entry] of registry) {
		if (entry.groupChatId === groupChatId && entry.participantName === participantName) {
			return sessionId;
		}
	}
	return undefined;
}

/**
 * Consume a completed autorun batch lookup after the renderer completion event
 * has used it to clear the participant's visible batch progress.
 */
export function consumeCompletedGroupChatAutoRun(
	groupChatId: string,
	participantName: string
): string | undefined {
	const key = completionKey(groupChatId, participantName);
	const sessionId = pendingCompletions.get(key);
	if (sessionId) {
		pendingCompletions.delete(key);
	}
	return sessionId;
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
