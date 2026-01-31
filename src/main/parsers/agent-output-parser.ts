/**
 * Agent Output Parser Interface
 *
 * This module defines the abstract interface for parsing AI agent output.
 * Different agents (Claude Code, OpenCode, etc.) have different JSON schemas
 * and output formats. This interface provides a common abstraction layer.
 *
 * Usage:
 * ```typescript
 * const parser = getOutputParser('claude-code');
 * for (const line of jsonLines) {
 *   const event = parser.parseJsonLine(line);
 *   if (event) {
 *     // Handle normalized event
 *   }
 * }
 * ```
 *
 * Error Detection:
 * ```typescript
 * const parser = getOutputParser('claude-code');
 * const error = parser.detectError(line);
 * if (error) {
 *   // Handle agent error (auth, rate limit, etc.)
 * }
 * ```
 */

import type { ToolType, AgentError } from '../../shared/types';

// Re-export error types for convenience
export type { AgentError, AgentErrorType } from '../../shared/types';

/**
 * Valid ToolType values for output parser registration
 * This array is the single source of truth for agent types that can have parsers
 */
const VALID_TOOL_TYPES: ToolType[] = [
	'claude-code',
	'opencode',
	'codex',
	'terminal',
	'factory-droid',
];

/**
 * Type guard to validate if a string is a valid ToolType
 * @param id - The string to check
 * @returns True if the string is a valid ToolType
 */
export function isValidToolType(id: string): id is ToolType {
	return VALID_TOOL_TYPES.includes(id as ToolType);
}

/**
 * Normalized parsed event from agent output.
 * All agent-specific formats are transformed into this common structure.
 */
export interface ParsedEvent {
	/**
	 * Event type indicating the nature of the event
	 * - 'init': Agent initialization (may contain session ID, available commands)
	 * - 'text': Text content to display to user
	 * - 'tool_use': Agent is using a tool (file read, bash, etc.)
	 * - 'result': Final result/response from agent
	 * - 'error': Error occurred
	 * - 'usage': Token usage statistics
	 * - 'system': System-level messages (not user-facing content)
	 */
	type: 'init' | 'text' | 'tool_use' | 'result' | 'error' | 'usage' | 'system';

	/**
	 * Session ID for conversation continuity (if available)
	 */
	sessionId?: string;

	/**
	 * Text content (for 'text', 'result', 'error' types)
	 */
	text?: string;

	/**
	 * Tool name being used (for 'tool_use' type)
	 */
	toolName?: string;

	/**
	 * Tool execution state (for 'tool_use' type)
	 * Format varies by agent, preserved for UI rendering
	 */
	toolState?: unknown;

	/**
	 * Token usage statistics (for 'usage' type)
	 */
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		contextWindow?: number;
		costUsd?: number;
		/**
		 * Reasoning/thinking tokens (separate from outputTokens)
		 * Some models like OpenAI o3/o4-mini report reasoning tokens separately.
		 * These are already included in outputTokens but tracked separately for UI display.
		 */
		reasoningTokens?: number;
	};

	/**
	 * Available slash commands (for 'init' type)
	 * Array of command strings (e.g., ['/help', '/compact', '/clear'])
	 */
	slashCommands?: string[];

	/**
	 * Is this a streaming/partial event?
	 * If true, more content may follow for this message
	 */
	isPartial?: boolean;

	/**
	 * Tool use blocks extracted from the message (for agents with mixed content)
	 * When a message contains both text and tool_use, text goes in 'text' field
	 * and tool_use blocks are here. Process-manager emits tool-execution for each.
	 */
	toolUseBlocks?: Array<{
		name: string;
		id?: string;
		input?: unknown;
	}>;

	/**
	 * Original event data for debugging
	 * Preserved unchanged from agent output
	 * Optional - primarily used for debugging and not read in production
	 */
	raw?: unknown;
}

/**
 * Agent Output Parser Interface
 *
 * Provides an abstraction for parsing agent output.
 * Each agent (Claude Code, OpenCode, etc.) implements this interface
 * to transform their output format into normalized ParsedEvent objects.
 */
export interface AgentOutputParser {
	/**
	 * The agent ID this parser handles
	 */
	readonly agentId: ToolType;

	/**
	 * Parse a single JSON line from agent output
	 *
	 * @param line - A single line of JSON output from the agent
	 * @returns ParsedEvent if the line is valid and should be processed, null otherwise
	 */
	parseJsonLine(line: string): ParsedEvent | null;

	/**
	 * Check if an event is a final result message
	 * Result messages indicate the agent has completed its response
	 *
	 * @param event - The parsed event to check
	 * @returns true if this is a final result event
	 */
	isResultMessage(event: ParsedEvent): boolean;

	/**
	 * Extract session ID from an event (if present)
	 * Session IDs are used for conversation continuity
	 *
	 * @param event - The parsed event
	 * @returns The session ID string or null if not present
	 */
	extractSessionId(event: ParsedEvent): string | null;

	/**
	 * Extract usage statistics from an event (if present)
	 * Usage stats include token counts, cost, etc.
	 *
	 * @param event - The parsed event
	 * @returns Usage stats or null if not present
	 */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null;

	/**
	 * Extract slash commands from an event (if present)
	 * Slash commands are typically sent in init messages
	 *
	 * @param event - The parsed event
	 * @returns Array of slash command strings or null if not present
	 */
	extractSlashCommands(event: ParsedEvent): string[] | null;

	/**
	 * Detect an error from a line of agent output
	 * Checks for error patterns in the output and returns structured error info
	 *
	 * @param line - A single line of output from the agent (may be JSON or plain text)
	 * @returns AgentError if an error was detected, null otherwise
	 */
	detectErrorFromLine(line: string): AgentError | null;

	/**
	 * Detect an error from process exit information
	 * Called when the agent process exits to determine if there was an error
	 *
	 * @param exitCode - The process exit code
	 * @param stderr - The stderr output (may be empty)
	 * @param stdout - The stdout output (may be empty)
	 * @returns AgentError if an error was detected, null otherwise
	 */
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null;
}

/**
 * Registry of output parser implementations
 * Maps agent IDs to their parser implementations
 */
const parserRegistry = new Map<ToolType, AgentOutputParser>();

/**
 * Register an output parser implementation
 * @param parser - The parser implementation to register
 */
export function registerOutputParser(parser: AgentOutputParser): void {
	parserRegistry.set(parser.agentId, parser);
}

/**
 * Get the output parser implementation for an agent
 * @param agentId - The agent ID (must be a valid ToolType)
 * @returns The parser implementation or null if not available or invalid agent ID
 */
export function getOutputParser(agentId: ToolType | string): AgentOutputParser | null {
	if (!isValidToolType(agentId)) {
		return null;
	}
	return parserRegistry.get(agentId) || null;
}

/**
 * Check if an agent has output parser support
 * @internal Primarily used for testing - consider using getOutputParser() !== null instead
 * @param agentId - The agent ID (must be a valid ToolType)
 * @returns True if the agent has a registered parser, false for invalid agent IDs
 */
export function hasOutputParser(agentId: ToolType | string): boolean {
	if (!isValidToolType(agentId)) {
		return false;
	}
	return parserRegistry.has(agentId);
}

/**
 * Get all registered parser implementations
 * @internal Primarily used for logging and testing - not intended for production use
 * @returns Array of all registered parser implementations
 */
export function getAllOutputParsers(): AgentOutputParser[] {
	return Array.from(parserRegistry.values());
}

/**
 * Clear the parser registry
 * @internal Exposed for testing only - do not use in production code
 */
export function clearParserRegistry(): void {
	parserRegistry.clear();
}
