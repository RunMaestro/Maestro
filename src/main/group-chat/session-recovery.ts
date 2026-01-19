/**
 * Session Recovery for Group Chat
 *
 * This module handles detection and recovery from session-not-found errors
 * in group chat participants. When an agent's session has been deleted
 * (out of band), this module:
 *
 * 1. Detects the error from the agent's output
 * 2. Clears the participant's stored agentSessionId
 * 3. Builds rich context including the agent's prior statements
 * 4. Re-spawns the participant with this context to continue the conversation
 *
 * This enables participants to seamlessly recover from session deletion
 * without losing conversational continuity.
 */

import { getErrorPatterns, matchErrorPattern } from '../parsers/error-patterns';
import { readLog, type GroupChatMessage } from './group-chat-log';
import { loadGroupChat, updateParticipant, getGroupChatDir } from './group-chat-storage';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[SessionRecovery]';

/**
 * Check if output contains a session_not_found error
 *
 * @param output - The raw output from the agent process
 * @param agentId - The agent type for pattern matching
 * @returns true if session_not_found error detected
 */
export function detectSessionNotFoundError(output: string, agentId?: string): boolean {
	if (!output) return false;

	// Get error patterns for this agent (or use claude-code as default)
	const patterns = getErrorPatterns(agentId || 'claude-code');

	// Check each line for session_not_found pattern
	const lines = output.split('\n');
	for (const line of lines) {
		const match = matchErrorPattern(patterns, line);
		if (match && match.type === 'session_not_found') {
			logger.info('Detected session_not_found error', LOG_CONTEXT, {
				agentId,
				errorMessage: match.message,
				line: line.substring(0, 200),
			});
			return true;
		}
	}

	// Also check for raw error message that might not be in JSON format
	const sessionNotFoundPatterns = [
		/no conversation found with session id/i,
		/session.*not found/i,
		/invalid.*session.*id/i,
	];

	for (const pattern of sessionNotFoundPatterns) {
		if (pattern.test(output)) {
			logger.info('Detected session_not_found error (raw pattern)', LOG_CONTEXT, {
				agentId,
				pattern: pattern.source,
			});
			return true;
		}
	}

	return false;
}

/**
 * Build recovery context for a participant whose session was lost
 *
 * This creates a detailed context prompt that includes:
 * - All messages from the chat history
 * - Special emphasis on messages FROM this participant (their prior statements)
 * - Information about the session recovery situation
 *
 * @param groupChatId - The group chat ID
 * @param participantName - The participant who needs recovery
 * @param lastMessages - Number of messages to include (default 30)
 * @returns Context string to prepend to the retry prompt
 */
export async function buildRecoveryContext(
	groupChatId: string,
	participantName: string,
	lastMessages = 30
): Promise<string> {
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		logger.warn('Cannot build recovery context - chat not found', LOG_CONTEXT, { groupChatId });
		return '';
	}

	// Read the chat history
	const chatHistory = await readLog(chat.logPath);
	const recentMessages = chatHistory.slice(-lastMessages);

	if (recentMessages.length === 0) {
		return '';
	}

	// Separate messages into "your statements" and "others' statements"
	const yourStatements: GroupChatMessage[] = [];
	const otherStatements: GroupChatMessage[] = [];

	for (const msg of recentMessages) {
		if (msg.from === participantName) {
			yourStatements.push(msg);
		} else {
			otherStatements.push(msg);
		}
	}

	// Build the recovery context
	const parts: string[] = [];

	parts.push(`## Session Recovery Context`);
	parts.push(`Your previous session was unavailable, so you're starting with a fresh session.`);
	parts.push(`To maintain continuity, here's the context from our group chat "${chat.name}":`);
	parts.push('');

	// Include the participant's own prior statements prominently
	if (yourStatements.length > 0) {
		parts.push(`### Your Previous Statements (as ${participantName})`);
		parts.push(`You previously said the following in this conversation:`);
		parts.push('');
		for (const msg of yourStatements) {
			const timestamp = new Date(msg.timestamp).toLocaleTimeString();
			parts.push(
				`[${timestamp}] You said: ${msg.content.substring(0, 1000)}${msg.content.length > 1000 ? '...' : ''}`
			);
		}
		parts.push('');
	}

	// Include full conversation history for context
	parts.push(`### Recent Conversation History`);
	parts.push(`Here's the recent conversation flow:`);
	parts.push('');
	for (const msg of recentMessages) {
		const timestamp = new Date(msg.timestamp).toLocaleTimeString();
		const isYou = msg.from === participantName;
		const prefix = isYou
			? `[${timestamp}] **YOU (${participantName}):**`
			: `[${timestamp}] [${msg.from}]:`;
		parts.push(
			`${prefix} ${msg.content.substring(0, 500)}${msg.content.length > 500 ? '...' : ''}`
		);
	}
	parts.push('');
	parts.push(`---`);
	parts.push(
		`Please continue from where you left off. Maintain consistency with your previous statements.`
	);
	parts.push('');

	return parts.join('\n');
}

/**
 * Handle session recovery for a participant
 *
 * This should be called when a session_not_found error is detected.
 * It clears the stored agentSessionId so the next spawn uses a fresh session.
 *
 * @param groupChatId - The group chat ID
 * @param participantName - The participant who needs recovery
 * @returns true if recovery was initiated successfully
 */
export async function initiateSessionRecovery(
	groupChatId: string,
	participantName: string
): Promise<boolean> {
	try {
		logger.info('Initiating session recovery', LOG_CONTEXT, {
			groupChatId,
			participantName,
		});

		// Clear the agentSessionId so next spawn uses fresh session
		await updateParticipant(groupChatId, participantName, {
			agentSessionId: undefined,
		});

		logger.info('Session recovery initiated - cleared agentSessionId', LOG_CONTEXT, {
			groupChatId,
			participantName,
		});

		return true;
	} catch (error) {
		logger.error('Failed to initiate session recovery', LOG_CONTEXT, {
			groupChatId,
			participantName,
			error: String(error),
		});
		return false;
	}
}

/**
 * Check if a participant needs session recovery based on process output
 *
 * @param output - The buffered output from the participant process
 * @param agentId - The agent type
 * @returns true if session recovery is needed
 */
export function needsSessionRecovery(output: string, agentId?: string): boolean {
	return detectSessionNotFoundError(output, agentId);
}

/**
 * Get the group chat folder path for a given group chat ID
 *
 * This is re-exported for convenience in the recovery flow.
 */
export { getGroupChatDir };
