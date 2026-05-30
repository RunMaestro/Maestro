/**
 * Main process constants
 *
 * Centralized constants used across the main process for Claude session parsing,
 * API pricing, demo mode detection, and pre-compiled regex patterns.
 */

import path from 'path';
import * as os from 'node:os';

// ============================================================================
// Pre-compiled Regex Patterns (Performance Optimization)
// ============================================================================
// These patterns are used in hot paths (process data handlers) that fire hundreds
// of times per second. Pre-compiling them avoids repeated regex compilation overhead.

// Group chat session ID patterns
//
// groupChatId is ALWAYS a uuidv4() (see group-chat-storage.ts:createGroupChat()),
// so we anchor the group-chat-id capture on the UUID format instead of a greedy
// (.+). This matters because participant display names are user-supplied and may
// contain literal "-participant-" substrings; the old greedy capture would
// backtrack to the LAST occurrence and parse to the wrong (groupChatId,
// participantName) pair, which could cause output chunks buffered in
// group-chat/output-buffer.ts to be flushed against the wrong owner — the
// suspected root cause for group-chat content leaking into Cue pipeline output.
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
// requires a UUID groupChatId so we never silently parse a non-group-chat
// sessionId as one.
export const REGEX_PARTICIPANT_FALLBACK = new RegExp(
	`^group-chat-(${UUID_PATTERN})-participant-([^-]+)-`,
	'i'
);

// Web broadcast session ID patterns
// Tab IDs may contain dashes (e.g., UUIDs), so we match everything after the -ai- delimiter
// The optional -fp-{timestamp} suffix is stripped (forced parallel execution uses unique session IDs)
export const REGEX_AI_SUFFIX = /-ai-.+$/;
export const REGEX_AI_TAB_ID = /-ai-(.+?)(?:-fp-\d+)?$/;

// Auto Run session ID patterns (batch and synopsis operations)
// Format: {sessionId}-batch-{timestamp} or {sessionId}-synopsis-{timestamp}
export const REGEX_BATCH_SESSION = /-batch-\d+$/;
export const REGEX_SYNOPSIS_SESSION = /-synopsis-\d+$/;

// ============================================================================
// Buffer Size Limits
// ============================================================================

/**
 * Maximum buffer size for group chat output (10MB).
 * Prevents memory exhaustion from extremely large outputs.
 * Larger than process-manager's 100KB because group chat conversations can be lengthy.
 */
export const MAX_GROUP_CHAT_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB

// ============================================================================
// Debug Logging (Performance Optimization)
// ============================================================================
// Debug logs in hot paths (data handlers) are disabled in production to avoid
// performance overhead from string interpolation and console I/O on every data chunk.
const DEBUG_GROUP_CHAT =
	process.env.NODE_ENV === 'development' || process.env.DEBUG_GROUP_CHAT === '1';

/** Log debug message only in development mode. Avoids overhead in production. */
export function debugLog(prefix: string, message: string, ...args: unknown[]): void {
	if (DEBUG_GROUP_CHAT) {
		console.log(`[${prefix}] ${message}`, ...args);
	}
}

/**
 * Demo mode flag - enables isolated data directory for fresh demos
 * Activated via --demo CLI flag or MAESTRO_DEMO_DIR environment variable
 */
export const DEMO_MODE = process.argv.includes('--demo') || !!process.env.MAESTRO_DEMO_DIR;

/**
 * Demo data directory path (only meaningful when DEMO_MODE is true)
 */
export const DEMO_DATA_PATH =
	process.env.MAESTRO_DEMO_DIR || path.join(os.tmpdir(), 'maestro-demo');

/**
 * Token divisor for converting to millions (used in cost calculations)
 */
export const TOKENS_PER_MILLION = 1_000_000;

/**
 * Limits for parsing Claude Code session JSONL files
 * These limits optimize scanning by avoiding full file reads for metadata extraction
 */
export const CLAUDE_SESSION_PARSE_LIMITS = {
	/** Max lines to scan from start of file to find first user message */
	FIRST_MESSAGE_SCAN_LINES: 20,
	/** Max lines to scan from end of file to find last timestamp */
	LAST_TIMESTAMP_SCAN_LINES: 10,
	/** Max lines to scan for oldest timestamp in stats calculation */
	OLDEST_TIMESTAMP_SCAN_LINES: 5,
	/** Max characters for first message preview */
	FIRST_MESSAGE_PREVIEW_LENGTH: 200,
} as const;

/**
 * Claude API pricing (per million tokens) - Sonnet 4 pricing
 * Used for cost estimation in session statistics
 */
export const CLAUDE_PRICING = {
	INPUT_PER_MILLION: 3,
	OUTPUT_PER_MILLION: 15,
	CACHE_READ_PER_MILLION: 0.3,
	CACHE_CREATION_PER_MILLION: 3.75,
} as const;
