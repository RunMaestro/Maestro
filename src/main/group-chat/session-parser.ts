/**
 * Session ID parsing utilities for group chat.
 * Extracts groupChatId and participantName from session IDs.
 */

import {
	REGEX_PARTICIPANT_UUID,
	REGEX_PARTICIPANT_TIMESTAMP,
	REGEX_PARTICIPANT_FALLBACK,
} from '../constants';

/**
 * Parses a group chat participant session ID to extract groupChatId and participantName.
 * Handles hyphenated participant names by matching against UUID or timestamp suffixes.
 *
 * Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
 * Examples:
 * - group-chat-abc123-participant-Claude-1702934567890
 * - group-chat-abc123-participant-OpenCode-Ollama-550e8400-e29b-41d4-a716-446655440000
 *
 * @returns null if not a participant session ID, otherwise { groupChatId, participantName }
 */
export function parseParticipantSessionId(
	sessionId: string
): { groupChatId: string; participantName: string } | null {
	// First check if this is a participant session ID at all
	if (!sessionId.includes('-participant-')) {
		return null;
	}

	// Try matching with UUID suffix first (36 chars: 8-4-4-4-12 format)
	// UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
	const uuidMatch = sessionId.match(REGEX_PARTICIPANT_UUID);
	if (uuidMatch) {
		return { groupChatId: uuidMatch[1], participantName: uuidMatch[2] };
	}

	// Try matching with timestamp suffix (13 digits)
	const timestampMatch = sessionId.match(REGEX_PARTICIPANT_TIMESTAMP);
	if (timestampMatch) {
		return { groupChatId: timestampMatch[1], participantName: timestampMatch[2] };
	}

	// Fallback: try the old pattern for backwards compatibility (non-hyphenated names)
	const fallbackMatch = sessionId.match(REGEX_PARTICIPANT_FALLBACK);
	if (fallbackMatch) {
		return { groupChatId: fallbackMatch[1], participantName: fallbackMatch[2] };
	}

	return null;
}
