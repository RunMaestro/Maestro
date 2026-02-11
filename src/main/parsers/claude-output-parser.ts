/**
 * Claude Code Output Parser
 *
 * Parses stream-json output from Claude Code CLI.
 * Claude Code outputs JSONL (JSON Lines) with different message types:
 * - system/init: Session initialization with slash commands
 * - assistant: Streaming text content (partial responses)
 * - result: Final complete response
 * - Messages may include session_id, modelUsage, usage, total_cost_usd
 *
 * @see https://github.com/anthropics/claude-code
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { aggregateModelUsage, type ModelStats } from './usage-aggregator';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/**
 * Content block in Claude assistant messages
 * Can be text, tool_use, thinking, or redacted_thinking blocks
 *
 * Extended thinking (Claude 3.7 Sonnet, Claude 4+) produces:
 * - thinking: Internal reasoning content (may be encrypted in signature)
 * - redacted_thinking: Encrypted thinking content (for safety-flagged reasoning)
 * - text: The final user-facing response
 */
interface ClaudeContentBlock {
	type: string;
	text?: string;
	// Extended thinking fields (Claude 3.7+, Claude 4+)
	thinking?: string;
	signature?: string;
	// Tool use fields
	name?: string;
	id?: string;
	input?: unknown;
}

/**
 * Raw message structure from Claude Code stream-json output
 */
interface ClaudeRawMessage {
	type: string;
	subtype?: string;
	session_id?: string;
	result?: string;
	message?: {
		role?: string;
		content?: string | ClaudeContentBlock[];
	};
	slash_commands?: string[];
	modelUsage?: Record<string, ModelStats>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	total_cost_usd?: number;
}

interface ExtractedStructuredError {
	errorText: string | null;
	parsedJson: unknown | null;
}

/**
 * Claude Code Output Parser Implementation
 *
 * Transforms Claude Code's stream-json format into normalized ParsedEvents.
 */
export class ClaudeOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'claude-code';
	private readonly errorPatterns = getErrorPatterns(this.agentId);

	/**
	 * Parse a single JSON line from Claude Code output
	 *
	 * Claude Code message types:
	 * - { type: 'system', subtype: 'init', session_id, slash_commands }
	 * - { type: 'assistant', message: { role, content } }
	 * - { type: 'result', result: string, session_id, modelUsage, usage, total_cost_usd }
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const msg: ClaudeRawMessage = JSON.parse(line);

			// DEBUG: Log raw message if it contains usage data
			if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
				console.log('[ClaudeOutputParser] Raw message with usage data:', JSON.stringify(msg, null, 2));
			}

			return this.transformMessage(msg);
		} catch {
			// Not valid JSON - return as raw text event
			// Note: This doesn't set isPartial, so it won't be emitted as thinking content
			return {
				type: 'text',
				text: line,
				raw: line,
			};
		}
	}

	/**
	 * Transform a parsed Claude message into a normalized ParsedEvent
	 */
	private transformMessage(msg: ClaudeRawMessage): ParsedEvent {
		// Handle system/init messages
		if (msg.type === 'system' && msg.subtype === 'init') {
			return {
				type: 'init',
				sessionId: msg.session_id,
				slashCommands: msg.slash_commands,
				raw: msg,
			};
		}

		// Handle result messages (final complete response)
		if (msg.type === 'result') {
			// The result field contains the complete formatted response
			// Fall back to message.content if result is not present
			let resultText = msg.result;
			if (!resultText && msg.message?.content) {
				resultText = this.extractTextFromMessage(msg);
			}

			const event: ParsedEvent = {
				type: 'result',
				text: resultText,
				sessionId: msg.session_id,
				raw: msg,
			};

			// Extract usage stats if present
			const usage = this.extractUsageFromRaw(msg);
			if (usage) {
				event.usage = usage;
			}

			return event;
		}

		// Handle assistant messages (streaming partial responses)
		if (msg.type === 'assistant') {
			const text = this.extractTextFromMessage(msg);
			const thinkingText = this.extractThinkingFromMessage(msg);
			const toolUseBlocks = this.extractToolUseBlocks(msg);

			// For thinking content, prioritize thinking blocks over text blocks
			// This ensures extended thinking (Claude 3.7+, Claude 4+) content streams properly
			// When thinking blocks are present, emit them as partial content for thinking-chunk events
			const contentToEmit = thinkingText || text;

			return {
				type: 'text',
				text: contentToEmit,
				sessionId: msg.session_id,
				isPartial: true,
				toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
				raw: msg,
			};
		}

		// Handle messages with only usage stats (no content type)
		if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
			const usage = this.extractUsageFromRaw(msg);
			return {
				type: 'usage',
				sessionId: msg.session_id,
				usage: usage || undefined,
				raw: msg,
			};
		}

		// Handle system messages (other subtypes)
		if (msg.type === 'system') {
			return {
				type: 'system',
				sessionId: msg.session_id,
				raw: msg,
			};
		}

		// Default: preserve as system event
		return {
			type: 'system',
			sessionId: msg.session_id,
			raw: msg,
		};
	}

	/**
	 * Extract tool_use blocks from a Claude assistant message
	 * These blocks contain tool invocation requests from the AI
	 */
	private extractToolUseBlocks(
		msg: ClaudeRawMessage
	): Array<{ name: string; id?: string; input?: unknown }> {
		if (!msg.message?.content || typeof msg.message.content === 'string') {
			return [];
		}

		return msg.message.content
			.filter((block) => block.type === 'tool_use' && block.name)
			.map((block) => ({
				name: block.name!,
				id: block.id,
				input: block.input,
			}));
	}

	/**
	 * Extract text content from a Claude assistant message
	 *
	 * Only extracts 'text' type blocks - explicitly excludes:
	 * - 'thinking' blocks (handled by extractThinkingFromMessage)
	 * - 'redacted_thinking' blocks (safety-encrypted thinking)
	 * - 'tool_use' blocks (handled separately by extractToolUseBlocks)
	 *
	 * @see extractThinkingFromMessage for thinking content extraction
	 */
	private extractTextFromMessage(msg: ClaudeRawMessage): string {
		if (!msg.message?.content) {
			return '';
		}

		// Content can be string or array of content blocks
		if (typeof msg.message.content === 'string') {
			return msg.message.content;
		}

		// Array of content blocks - extract ONLY text blocks
		// Thinking blocks (type: 'thinking', 'redacted_thinking') are intentionally excluded
		return msg.message.content
			.filter((block) => block.type === 'text' && block.text)
			.map((block) => block.text!)
			.join('');
	}

	/**
	 * Extract thinking content from a Claude assistant message
	 *
	 * Extracts 'thinking' type blocks from extended thinking (Claude 3.7+, Claude 4+).
	 * This content represents the model's internal reasoning process.
	 *
	 * Note: 'redacted_thinking' blocks are excluded as they contain encrypted content
	 * that cannot be displayed.
	 */
	private extractThinkingFromMessage(msg: ClaudeRawMessage): string {
		if (!msg.message?.content) {
			return '';
		}

		// Content must be array for thinking blocks
		if (typeof msg.message.content === 'string') {
			return '';
		}

		// Extract thinking blocks (excluding redacted_thinking which is encrypted)
		return msg.message.content
			.filter((block) => block.type === 'thinking' && block.thinking)
			.map((block) => block.thinking!)
			.join('');
	}

	/**
	 * Extract usage statistics from raw Claude message
	 */
	private extractUsageFromRaw(msg: ClaudeRawMessage): ParsedEvent['usage'] | null {
		if (!msg.modelUsage && !msg.usage && msg.total_cost_usd === undefined) {
			return null;
		}

		// Use the aggregateModelUsage helper from process-manager
		const aggregated = aggregateModelUsage(
			msg.modelUsage,
			msg.usage || {},
			msg.total_cost_usd || 0
		);

		return {
			inputTokens: aggregated.inputTokens,
			outputTokens: aggregated.outputTokens,
			cacheReadTokens: aggregated.cacheReadInputTokens,
			cacheCreationTokens: aggregated.cacheCreationInputTokens,
			contextWindow: aggregated.contextWindow,
			costUsd: aggregated.totalCostUsd,
		};
	}

	/**
	 * Check if an event is a final result message
	 */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	/**
	 * Extract session ID from an event
	 */
	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId || null;
	}

	/**
	 * Extract usage statistics from an event
	 */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	/**
	 * Extract slash commands from an event
	 */
	extractSlashCommands(event: ParsedEvent): string[] | null {
		return event.slashCommands || null;
	}

	/**
	 * Detect an error from a line of agent output
	 *
	 * IMPORTANT: Only detect errors from structured JSON error events, not from
	 * arbitrary text content. Pattern matching on conversational text leads to
	 * false positives (e.g., AI discussing "timeout" triggers timeout error).
	 *
	 * Error detection sources (in order of reliability):
	 * 1. Structured JSON: { type: "error", message: "..." } or { error: "..." }
	 * 2. stderr output (handled separately by process-manager)
	 * 3. Non-zero exit code (handled by detectErrorFromExit)
	 */
	private extractErrorMessage(errorField: unknown): string | null {
		if (typeof errorField === 'string') {
			return errorField;
		}

		if (typeof errorField === 'number' || typeof errorField === 'boolean') {
			return String(errorField);
		}

		if (errorField && typeof errorField === 'object') {
			const message = (errorField as { message?: unknown }).message;
			if (typeof message === 'string') {
				return message;
			}
			return JSON.stringify(errorField);
		}

		return null;
	}

	private extractErrorFromParsedLine(parsed: unknown): ExtractedStructuredError {
		if (!parsed || typeof parsed !== 'object') {
			return { errorText: null, parsedJson: null };
		}

		const parsedRecord = parsed as {
			type?: unknown;
			message?: unknown;
			error?: unknown;
		};

		const type = typeof parsedRecord.type === 'string' ? parsedRecord.type : '';
		const message = typeof parsedRecord.message === 'string' ? parsedRecord.message : null;
		const errorField = parsedRecord.error;

		if (type === 'error' && message) {
			return { errorText: message, parsedJson: parsed };
		}

		if (type === 'turn.failed' || type === 'turn_failed') {
			const turnFailedMessage = this.extractErrorMessage(errorField);
			if (turnFailedMessage) {
				return { errorText: turnFailedMessage, parsedJson: parsed };
			}
		}

		if (type === 'error') {
			const nestedErrorMessage = this.extractErrorMessage(errorField);
			if (nestedErrorMessage) {
				return { errorText: nestedErrorMessage, parsedJson: parsed };
			}
		}

		if (errorField) {
			const errorMessage = this.extractErrorMessage(errorField);
			if (errorMessage) {
				return { errorText: errorMessage, parsedJson: parsed };
			}
		}

		return { errorText: null, parsedJson: null };
	}

	private buildPatternMatchedError(
		errorText: string,
		raw: NonNullable<AgentError['raw']>,
		parsedJson?: unknown
	): AgentError | null {
		const match = matchErrorPattern(this.errorPatterns, errorText);
		if (!match) {
			return null;
		}

		return {
			type: match.type,
			message: match.message,
			recoverable: match.recoverable,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw,
			parsedJson,
		};
	}

	private buildUnknownStructuredError(
		errorText: string,
		raw: NonNullable<AgentError['raw']>,
		parsedJson: unknown
	): AgentError {
		return {
			type: 'unknown',
			message: errorText,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw,
			parsedJson,
		};
	}

	detectErrorFromLine(line: string): AgentError | null {
		// Skip empty lines
		if (!line.trim()) {
			return null;
		}

		let extracted: ExtractedStructuredError = { errorText: null, parsedJson: null };
		try {
			extracted = this.extractErrorFromParsedLine(JSON.parse(line));
		} catch {
			// Not pure JSON - try to extract embedded JSON from stderr messages
			// Example: "Error streaming...: 400 {"type":"error","error":{"type":"invalid_request_error","message":"..."}}"
			extracted = this.extractErrorFromMixedLine(line);
		}

		if (!extracted.errorText) {
			return null;
		}

		const raw: NonNullable<AgentError['raw']> = { errorLine: line };
		const matchedError = this.buildPatternMatchedError(
			extracted.errorText,
			raw,
			extracted.parsedJson ?? undefined
		);
		if (matchedError) {
			return matchedError;
		}

		if (extracted.parsedJson) {
			return this.buildUnknownStructuredError(extracted.errorText, raw, extracted.parsedJson);
		}

		return null;
	}

	/**
	 * Extract error message + JSON from a line that contains embedded JSON.
	 *
	 * Handles stderr output like:
	 * "Error streaming, falling back to non-streaming mode: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 206491 tokens > 200000 maximum"}}"
	 */
	private extractErrorFromMixedLine(line: string): ExtractedStructuredError {
		// Look for embedded JSON in the line
		const jsonStart = line.indexOf('{');
		if (jsonStart === -1) {
			return { errorText: null, parsedJson: null };
		}

		try {
			const jsonPart = line.substring(jsonStart);
			return this.extractErrorFromParsedLine(JSON.parse(jsonPart));
		} catch {
			// JSON parsing failed, ignore
		}

		return { errorText: null, parsedJson: null };
	}

	/**
	 * Detect an error from process exit information
	 */
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		// Exit code 0 is success
		if (exitCode === 0) {
			return null;
		}

		const raw: NonNullable<AgentError['raw']> = {
			exitCode,
			stderr,
			stdout,
		};

		// First try to extract detailed error from embedded JSON in stderr
		const extracted = this.extractErrorFromMixedLine(stderr);
		if (extracted.errorText) {
			const matchedStructuredError = this.buildPatternMatchedError(
				extracted.errorText,
				raw,
				extracted.parsedJson ?? undefined
			);
			if (matchedStructuredError) {
				return matchedStructuredError;
			}
		}

		// Check stderr and stdout for error patterns (fallback to raw text matching)
		const combined = `${stderr}\n${stdout}`;
		const matchedFallbackError = this.buildPatternMatchedError(
			combined,
			raw,
			extracted.parsedJson ?? undefined
		);
		if (matchedFallbackError) {
			return matchedFallbackError;
		}

		// We have a structured error but no pattern match - return it verbatim
		if (extracted.errorText && extracted.parsedJson) {
			return this.buildUnknownStructuredError(extracted.errorText, raw, extracted.parsedJson);
		}

		// Non-zero exit with no recognized pattern - treat as crash
		return {
			type: 'agent_crashed',
			message: `Agent exited with code ${exitCode}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: {
				exitCode,
				stderr,
				stdout,
			},
		};
	}
}
