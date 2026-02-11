/**
 * Session ID listener.
 * Handles agent session ID events for group chat participant/moderator tracking.
 */

import type { ProcessManager } from '../process-manager';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies } from './types';

/**
 * Sets up the session-id listener.
 * Handles:
 * - Group chat participant session ID storage
 * - Group chat moderator session ID storage
 * - Regular session ID forwarding to renderer
 */
export function setupSessionIdListener(
	processManager: ProcessManager,
	deps: Pick<
		ProcessListenerDependencies,
		| 'broadcastToAllWindows'
		| 'outputParser'
		| 'groupChatEmitters'
		| 'groupChatStorage'
		| 'logger'
		| 'patterns'
	>
): void {
	const {
		broadcastToAllWindows,
		outputParser,
		groupChatEmitters,
		groupChatStorage,
		logger,
		patterns,
	} = deps;
	const { REGEX_MODERATOR_SESSION_TIMESTAMP } = patterns;

	processManager.on('session-id', (sessionId: string, agentSessionId: string) => {
		// Fast path: skip regex for non-group-chat sessions (performance optimization)
		const isGroupChatSession = sessionId.startsWith(GROUP_CHAT_PREFIX);

		// Handle group chat participant session ID - store the agent's session ID
		// Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
		const participantSessionInfo = isGroupChatSession
			? outputParser.parseParticipantSessionId(sessionId)
			: null;
		if (participantSessionInfo) {
			const { groupChatId, participantName } = participantSessionInfo;
			// Update the participant with the agent's session ID
			groupChatStorage
				.updateParticipant(groupChatId, participantName, { agentSessionId })
				.then((updatedChat) => {
					// Emit participants changed so UI updates with the new session ID
					// Note: updateParticipant returns the updated chat, avoiding extra DB read
					groupChatEmitters.emitParticipantsChanged?.(groupChatId, updatedChat.participants);
				})
				.catch((err) => {
					logger.error(
						'[GroupChat] Failed to update participant agentSessionId',
						'ProcessListener',
						{ error: String(err), participant: participantName }
					);
				});
			// Don't return - still send to renderer for logging purposes
		}

		// Handle group chat moderator session ID - store the real agent session ID
		// Session ID format: group-chat-{groupChatId}-moderator-{timestamp}
		const moderatorMatch = isGroupChatSession
			? sessionId.match(REGEX_MODERATOR_SESSION_TIMESTAMP)
			: null;
		if (moderatorMatch) {
			const groupChatId = moderatorMatch[1];
			// Update the group chat with the moderator's real agent session ID
			// Store in moderatorAgentSessionId (not moderatorSessionId which is the routing prefix)
			groupChatStorage
				.updateGroupChat(groupChatId, { moderatorAgentSessionId: agentSessionId })
				.then(() => {
					// Emit session ID change event so UI updates with the new session ID
					groupChatEmitters.emitModeratorSessionIdChanged?.(groupChatId, agentSessionId);
				})
				.catch((err: unknown) => {
					logger.error(
						'[GroupChat] Failed to update moderator agent session ID',
						'ProcessListener',
						{ error: String(err), groupChatId }
					);
				});
			// Don't return - still send to renderer for logging purposes
		}

		broadcastToAllWindows('process:session-id', sessionId, agentSessionId);
	});
}
