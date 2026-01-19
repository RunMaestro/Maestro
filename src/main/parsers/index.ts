/**
 * Agent Output Parsers
 *
 * This module initializes and exports all output parser implementations.
 * Call initializeOutputParsers() at application startup to register
 * all available parsers.
 *
 * Usage:
 * ```typescript
 * import { initializeOutputParsers, getOutputParser } from './parsers';
 *
 * // At app startup
 * initializeOutputParsers();
 *
 * // Later, when processing agent output
 * const parser = getOutputParser('claude-code');
 * if (parser) {
 *   const event = parser.parseJsonLine(line);
 * }
 * ```
 */

// Re-export interface and types
export type {
	AgentOutputParser,
	ParsedEvent,
	AgentError,
	AgentErrorType,
} from './agent-output-parser';

// Re-export registry functions
export {
	registerOutputParser,
	getOutputParser,
	hasOutputParser,
	getAllOutputParsers,
	clearParserRegistry,
} from './agent-output-parser';

// Re-export error pattern utilities
export type { ErrorPattern, AgentErrorPatterns } from './error-patterns';
export {
	getErrorPatterns,
	matchErrorPattern,
	registerErrorPatterns,
	clearPatternRegistry,
	CLAUDE_ERROR_PATTERNS,
	OPENCODE_ERROR_PATTERNS,
	CODEX_ERROR_PATTERNS,
} from './error-patterns';

// Import parser implementations
import { ClaudeOutputParser } from './claude-output-parser';
import { OpenCodeOutputParser } from './opencode-output-parser';
import { CodexOutputParser } from './codex-output-parser';
import {
	registerOutputParser,
	clearParserRegistry,
	getAllOutputParsers,
} from './agent-output-parser';
import { logger } from '../utils/logger';

// Export parser classes for direct use if needed
export { ClaudeOutputParser } from './claude-output-parser';
export { OpenCodeOutputParser } from './opencode-output-parser';
export { CodexOutputParser } from './codex-output-parser';

const LOG_CONTEXT = '[OutputParsers]';

/**
 * Initialize all output parser implementations.
 * Call this at application startup to register all available parsers.
 */
export function initializeOutputParsers(): void {
	// Clear any existing registrations (for testing/reloading)
	clearParserRegistry();

	// Register all parser implementations
	registerOutputParser(new ClaudeOutputParser());
	registerOutputParser(new OpenCodeOutputParser());
	registerOutputParser(new CodexOutputParser());

	// Log registered parsers for debugging
	const registeredParsers = getAllOutputParsers().map((p) => p.agentId);
	logger.info(`Initialized output parsers: ${registeredParsers.join(', ')}`, LOG_CONTEXT);
}

/**
 * Check if parsers have been initialized
 * @returns true if at least one parser is registered
 */
let _initialized = false;

export function ensureParsersInitialized(): void {
	if (!_initialized) {
		initializeOutputParsers();
		_initialized = true;
	}
}
