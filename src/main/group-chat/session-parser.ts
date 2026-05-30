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
 * Recovery format:   group-chat-{groupChatId}-participant-{name}-recovery-{timestamp}
 *
 * Recovery sessions are ONLY ever minted with a timestamp suffix (see
 * group-chat-router.ts respawnParticipantWithRecovery), so the recovery
 * suffix is stripped exclusively in the timestamp branch. The UUID branch
 * does not strip "-recovery" — doing so would silently truncate a
 * legitimate participant name that happens to end with "-recovery".
 *
 * groupChatId is ALWAYS a uuidv4() — the regex patterns in constants.ts
 * enforce this so a participant name containing "-participant-" (or any
 * other sentinel) can no longer cause a mis-parse that routes output to
 * the wrong owner.
 *
 * Examples:
 * - group-chat-550e8400-e29b-41d4-a716-446655440000-participant-Claude-1702934567890
 * - group-chat-550e8400-e29b-41d4-a716-446655440000-participant-OpenCode-Ollama-6ba7b810-9dad-11d1-80b4-00c04fd430c8
 * - group-chat-550e8400-e29b-41d4-a716-446655440000-participant-Claude-recovery-1702934567890
 *
 * @returns null if not a participant session ID, otherwise { groupChatId, participantName }
 */
export function parseParticipantSessionId(
	sessionId: string
): { groupChatId: string; participantName: string } | null {
	// Strict prefix guard: the canonical shape must start with "group-chat-" and
	// contain "-participant-". Refuse anything else rather than guessing.
	if (!sessionId.startsWith('group-chat-') || !sessionId.includes('-participant-')) {
		return null;
	}

	// Try matching with UUID suffix first (36 chars: 8-4-4-4-12 format).
	// Production never combines UUID suffix + recovery — recovery sessions
	// always use the timestamp shape — so the participant name is taken
	// verbatim here. See the timestamp branch below for recovery handling.
	const uuidMatch = sessionId.match(REGEX_PARTICIPANT_UUID);
	if (uuidMatch) {
		return { groupChatId: uuidMatch[1], participantName: uuidMatch[2] };
	}

	// Try matching with timestamp suffix (13+ digits)
	const timestampMatch = sessionId.match(REGEX_PARTICIPANT_TIMESTAMP);
	if (timestampMatch) {
		// Recovery sessions use format: {name}-recovery-{timestamp}
		const participantName = timestampMatch[2].replace(/-recovery$/, '');
		return { groupChatId: timestampMatch[1], participantName };
	}

	// Fallback: non-hyphenated names with a non-UUID/non-timestamp tail. Still
	// requires a UUID groupChatId, so non-group-chat sessionIds never slip
	// through.
	const fallbackMatch = sessionId.match(REGEX_PARTICIPANT_FALLBACK);
	if (fallbackMatch) {
		return { groupChatId: fallbackMatch[1], participantName: fallbackMatch[2] };
	}

	return null;
}
