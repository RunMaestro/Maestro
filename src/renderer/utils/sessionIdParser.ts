/**
 * Session ID Parsing Utilities
 *
 * Pre-compiled regex patterns and parsing functions for session ID extraction.
 * Centralizes the session ID parsing logic that was previously duplicated
 * across multiple event handlers in App.tsx.
 *
 * Session ID formats:
 * - AI tab: `{sessionId}-ai-{tabId}`
 * - Legacy AI: `{sessionId}-ai`
 * - Synopsis: `{sessionId}-synopsis-{timestamp}`
 * - Batch: `{sessionId}-batch-{timestamp}`
 * - Group chat moderator: `group-chat-{groupChatId}-moderator-{timestamp}`
 * - Group chat participant: `group-chat-{groupChatId}-{participantName}-{timestamp}`
 *
 * @module sessionIdParser
 */

// ============================================================================
// Pre-compiled Regex Patterns (module-level for performance)
// ============================================================================

/** Match AI tab session IDs: `{sessionId}-ai-{tabId}` (strips optional `-fp-{timestamp}` suffix from forced parallel) */
export const REGEX_AI_TAB = /^(.+)-ai-(.+?)(?:-fp-\d+)?$/;

/** Match synopsis session IDs: `{sessionId}-synopsis-{timestamp}` */
export const REGEX_SYNOPSIS = /^(.+)-synopsis-\d+$/;

/** Match batch session IDs: `{sessionId}-batch-{timestamp}` */
export const REGEX_BATCH = /^(.+)-batch-\d+$/;

/** Match group chat moderator: `group-chat-{id}-moderator-{timestamp}` */
export const REGEX_GROUP_CHAT_MODERATOR =
	/^group-chat-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-moderator-(\d+)$/;

/** Match group chat participant: `group-chat-{id}-{name}-{timestamp}` */
export const REGEX_GROUP_CHAT_PARTICIPANT =
	/^group-chat-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)-(\d+)$/;

/** Legacy AI suffix check */
const AI_SUFFIX = '-ai';

// ============================================================================
// Parsed Result Types
// ============================================================================

/**
 * Result of parsing a session ID for usage/state updates.
 */
export interface ParsedSessionId {
	/** The actual session ID to use for updates */
	actualSessionId: string;
	/** The tab ID if this is an AI tab session */
	tabId: string | null;
	/** The base session ID (for synopsis/batch, this is the parent session) */
	baseSessionId: string;
	/** Session type classification */
	type: 'ai-tab' | 'legacy-ai' | 'synopsis' | 'batch' | 'regular';
}

/**
 * Result of parsing a group chat session ID.
 */
export interface ParsedGroupChatSessionId {
	/** Whether this is a group chat session */
	isGroupChat: boolean;
	/** Group chat ID (if group chat) */
	groupChatId?: string;
	/** Whether this is a moderator session */
	isModerator?: boolean;
	/** Participant name (if participant session) */
	participantName?: string;
	/** Timestamp from the session ID */
	timestamp?: string;
}

// ============================================================================
// Parser Functions
// ============================================================================

/**
 * Parse a session ID to extract the actual session ID, tab ID, and base session ID.
 *
 * This handles all session ID formats:
 * - AI tab: `{sessionId}-ai-{tabId}` → actualSessionId={sessionId}, tabId={tabId}
 * - Legacy AI: `{sessionId}-ai` → actualSessionId={sessionId}, tabId=null
 * - Synopsis: `{sessionId}-synopsis-{timestamp}` → actualSessionId=original, baseSessionId={sessionId}
 * - Batch: `{sessionId}-batch-{timestamp}` → actualSessionId=original, baseSessionId={sessionId}
 * - Regular: `{sessionId}` → actualSessionId={sessionId}
 *
 * @param sessionId - The raw session ID from an IPC event
 * @returns Parsed session ID components
 *
 * @example
 * parseSessionId('session-123-ai-tab1')
 * // → { actualSessionId: 'session-123', tabId: 'tab1', baseSessionId: 'session-123', type: 'ai-tab' }
 *
 * parseSessionId('session-123-synopsis-1234567890')
 * // → { actualSessionId: 'session-123-synopsis-1234567890', tabId: null, baseSessionId: 'session-123', type: 'synopsis' }
 */
export function parseSessionId(sessionId: string): ParsedSessionId {
	// Check AI tab format first (most common)
	const aiTabMatch = sessionId.match(REGEX_AI_TAB);
	if (aiTabMatch) {
		return {
			actualSessionId: aiTabMatch[1],
			tabId: aiTabMatch[2],
			baseSessionId: aiTabMatch[1],
			type: 'ai-tab',
		};
	}

	// Check legacy AI suffix
	if (sessionId.endsWith(AI_SUFFIX)) {
		const baseId = sessionId.slice(0, -AI_SUFFIX.length);
		return {
			actualSessionId: baseId,
			tabId: null,
			baseSessionId: baseId,
			type: 'legacy-ai',
		};
	}

	// Check synopsis format
	const synopsisMatch = sessionId.match(REGEX_SYNOPSIS);
	if (synopsisMatch) {
		return {
			actualSessionId: sessionId,
			tabId: null,
			baseSessionId: synopsisMatch[1],
			type: 'synopsis',
		};
	}

	// Check batch format
	const batchMatch = sessionId.match(REGEX_BATCH);
	if (batchMatch) {
		return {
			actualSessionId: sessionId,
			tabId: null,
			baseSessionId: batchMatch[1],
			type: 'batch',
		};
	}

	// Regular session ID
	return {
		actualSessionId: sessionId,
		tabId: null,
		baseSessionId: sessionId,
		type: 'regular',
	};
}

/**
 * Parse a session ID to check if it's a group chat session.
 *
 * @param sessionId - The raw session ID from an IPC event
 * @returns Group chat information if applicable
 *
 * @example
 * parseGroupChatSessionId('group-chat-abc-123-moderator-1234567890')
 * // → { isGroupChat: true, groupChatId: 'abc-123', isModerator: true, timestamp: '1234567890' }
 */
export function parseGroupChatSessionId(sessionId: string): ParsedGroupChatSessionId {
	// Check moderator pattern
	const moderatorMatch = sessionId.match(REGEX_GROUP_CHAT_MODERATOR);
	if (moderatorMatch) {
		return {
			isGroupChat: true,
			groupChatId: moderatorMatch[1],
			isModerator: true,
			timestamp: moderatorMatch[2],
		};
	}

	// Check participant pattern
	const participantMatch = sessionId.match(REGEX_GROUP_CHAT_PARTICIPANT);
	if (participantMatch) {
		return {
			isGroupChat: true,
			groupChatId: participantMatch[1],
			isModerator: false,
			participantName: participantMatch[2],
			timestamp: participantMatch[3],
		};
	}

	return { isGroupChat: false };
}

/**
 * Check if a session ID is a synopsis session.
 *
 * @param sessionId - The raw session ID
 * @returns True if this is a synopsis session
 */
export function isSynopsisSession(sessionId: string): boolean {
	return REGEX_SYNOPSIS.test(sessionId);
}

/**
 * Check if a session ID is a batch session.
 *
 * @param sessionId - The raw session ID
 * @returns True if this is a batch session
 */
export function isBatchSession(sessionId: string): boolean {
	return REGEX_BATCH.test(sessionId);
}

/**
 * Extract the base session ID from any session ID format.
 * Useful when you only need the parent session ID without full parsing.
 *
 * @param sessionId - The raw session ID
 * @returns The base session ID
 */
export function getBaseSessionId(sessionId: string): string {
	return parseSessionId(sessionId).baseSessionId;
}

/**
 * Extract the tab ID from an AI session ID, if present.
 *
 * @param sessionId - The raw session ID
 * @returns The tab ID or null if not an AI tab session
 */
export function getTabId(sessionId: string): string | null {
	return parseSessionId(sessionId).tabId;
}
