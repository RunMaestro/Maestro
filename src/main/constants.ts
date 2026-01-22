/**
 * Main process constants
 *
 * Centralized constants used across the main process for Claude session parsing,
 * API pricing, demo mode detection, and pre-compiled regex patterns.
 */

import path from 'path';
import os from 'os';

// ============================================================================
// Pre-compiled Regex Patterns (Performance Optimization)
// ============================================================================
// These patterns are used in hot paths (process data handlers) that fire hundreds
// of times per second. Pre-compiling them avoids repeated regex compilation overhead.

// Group chat session ID patterns
export const REGEX_MODERATOR_SESSION = /^group-chat-(.+)-moderator-/;
export const REGEX_MODERATOR_SESSION_TIMESTAMP = /^group-chat-(.+)-moderator-\d+$/;
export const REGEX_PARTICIPANT_UUID =
	/^group-chat-(.+)-participant-(.+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
export const REGEX_PARTICIPANT_TIMESTAMP = /^group-chat-(.+)-participant-(.+)-(\d{13,})$/;
export const REGEX_PARTICIPANT_FALLBACK = /^group-chat-(.+)-participant-([^-]+)-/;

// Web broadcast session ID patterns
export const REGEX_AI_SUFFIX = /-ai-[^-]+$/;
export const REGEX_AI_TAB_ID = /-ai-([^-]+)$/;

// ============================================================================
// Debug Logging (Performance Optimization)
// ============================================================================
// Debug logs in hot paths (data handlers) are disabled in production to avoid
// performance overhead from string interpolation and console I/O on every data chunk.
export const DEBUG_GROUP_CHAT =
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
