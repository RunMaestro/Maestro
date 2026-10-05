/**
 * @file groupchat/session-ids.ts
 * @description The process id shapes a group chat spawns under, and their parsers.
 *
 * Every group chat process carries its owner in its id (`Plans/maestro-tui-group-chat.md`
 * B15), so a listener that sees a bare id can find the room and the participant
 * without a lookup table:
 *
 * - moderator: `group-chat-<chatId>-moderator-<timestamp>`
 * - participant: `group-chat-<chatId>-participant-<name>-<uuid|timestamp>`
 * - recovery: `group-chat-<chatId>-participant-<name>-recovery-<timestamp>`
 *
 * The patterns used to live in `src/main/constants.ts`; that module re-exports
 * them so every existing import keeps resolving.
 */

/** Prefix for group chat session ids; a cheap guard before any regex runs. */
export const GROUP_CHAT_PREFIX = 'group-chat-';

// groupChatId is ALWAYS a UUID (see the store's createGroupChat), so the
// group-chat-id capture is anchored on the UUID format instead of a greedy
// (.+). Participant display names are user-supplied and may contain a literal
// "-participant-"; a greedy capture would backtrack to the LAST occurrence and
// parse to the wrong (groupChatId, participantName) pair, which routes output
// to the wrong owner.
const UUID_PATTERN = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

export const REGEX_MODERATOR_SESSION = new RegExp(`^group-chat-(${UUID_PATTERN})-moderator-`, 'i');
export const REGEX_MODERATOR_SESSION_TIMESTAMP = new RegExp(
	`^group-chat-(${UUID_PATTERN})-moderator-\\d+$`,
	'i'
);
// Participant name capture is lazy ((.+?)) so the UUID/timestamp tail anchor
// determines the split rather than greedy backtracking.
export const REGEX_PARTICIPANT_UUID = new RegExp(
	`^group-chat-(${UUID_PATTERN})-participant-(.+?)-(${UUID_PATTERN})$`,
	'i'
);
export const REGEX_PARTICIPANT_TIMESTAMP = new RegExp(
	`^group-chat-(${UUID_PATTERN})-participant-(.+?)-(\\d{13,})$`,
	'i'
);
// Fallback only kicks in when neither UUID nor timestamp tail matches. It still
// requires a UUID groupChatId so a non-group-chat id is never parsed as one.
export const REGEX_PARTICIPANT_FALLBACK = new RegExp(
	`^group-chat-(${UUID_PATTERN})-participant-([^-]+)-`,
	'i'
);

/** The room and participant a process id belongs to. */
export interface GroupChatTurnOwner {
	groupChatId: string;
	participantName: string;
}

/**
 * Parses a group chat participant session ID to extract groupChatId and participantName.
 * Handles hyphenated participant names by matching against UUID or timestamp suffixes.
 *
 * Recovery sessions are ONLY ever minted with a timestamp suffix (see the engine's
 * `respawnParticipantWithRecovery`), so the recovery suffix is stripped exclusively in
 * the timestamp branch. The UUID branch does not strip "-recovery" - doing so would
 * silently truncate a legitimate participant name that happens to end with "-recovery".
 *
 * Examples:
 * - group-chat-550e8400-e29b-41d4-a716-446655440000-participant-Claude-1702934567890
 * - group-chat-550e8400-e29b-41d4-a716-446655440000-participant-OpenCode-Ollama-6ba7b810-9dad-11d1-80b4-00c04fd430c8
 * - group-chat-550e8400-e29b-41d4-a716-446655440000-participant-Claude-recovery-1702934567890
 *
 * @returns null if not a participant session ID, otherwise { groupChatId, participantName }
 */
export function parseParticipantSessionId(sessionId: string): GroupChatTurnOwner | null {
	// Strict prefix guard: the canonical shape must start with "group-chat-" and
	// contain "-participant-". Refuse anything else rather than guessing.
	if (!sessionId.startsWith(GROUP_CHAT_PREFIX) || !sessionId.includes('-participant-')) {
		return null;
	}

	// Try matching with UUID suffix first (36 chars: 8-4-4-4-12 format).
	// Production never combines UUID suffix + recovery - recovery sessions
	// always use the timestamp shape - so the participant name is taken
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

	// Fallback: non-hyphenated names with a non-UUID/non-timestamp tail.
	const fallbackMatch = sessionId.match(REGEX_PARTICIPANT_FALLBACK);
	if (fallbackMatch) {
		return { groupChatId: fallbackMatch[1], participantName: fallbackMatch[2] };
	}

	return null;
}

/**
 * Parses a group chat moderator process id (`group-chat-<chatId>-moderator-...`).
 * Covers the initial turn and the synthesis turn, which share the format.
 *
 * @returns the chat id, or null when the id is not a moderator's
 */
export function parseModeratorSessionId(sessionId: string): string | null {
	if (!sessionId.startsWith(GROUP_CHAT_PREFIX)) return null;
	const match = sessionId.match(REGEX_MODERATOR_SESSION);
	return match ? match[1] : null;
}
