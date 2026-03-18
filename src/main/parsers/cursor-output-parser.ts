/**
 * Cursor CLI Output Parser
 *
 * Parses stream-json output from Cursor CLI (`agent -p --output-format stream-json`).
 * Cursor outputs newline-delimited JSON with the following event types:
 *
 * - system (subtype: "init"): Initialization with model info
 * - assistant: Generated text content with incremental deltas
 * - tool_call: Tool execution tracking (started/completed subtypes)
 *   - Tool types: writeToolCall, readToolCall, etc.
 * - result: Final completion with duration_ms
 *
 * Key differences from Claude Code:
 * - No documented session ID field in stream-json output
 * - No token usage or cost reporting in output
 * - Tool calls use subtypes "started"/"completed" instead of separate event types
 * - Binary name is `agent` (not `cursor`)
 *
 * @see docs/cursor-cli-research.md
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/**
 * Content block in Cursor assistant messages
 */
interface CursorContentBlock {
	type: string;
	text?: string;
}

/**
 * Raw message structure from Cursor stream-json output
 */
interface CursorRawMessage {
	type?: string;
	subtype?: string;
	model?: string;
	duration_ms?: number;
	message?: {
		role?: string;
		content?: CursorContentBlock[] | string;
	};
	args?: Record<string, unknown>;
	result?: unknown;
	error?: string | { message?: string; type?: string };
}

/**
 * Extract a human-readable error message from Cursor's polymorphic error field.
 */
function extractErrorText(error: CursorRawMessage['error'], fallback = 'Unknown error'): string {
	if (typeof error === 'object' && error?.message) return error.message;
	if (typeof error === 'string') return error;
	return fallback;
}

/**
 * Cursor CLI Output Parser Implementation
 *
 * Transforms Cursor's stream-json format into normalized ParsedEvents.
 * Based on the documented output format from cursor.com/docs/cli/headless.
 */
export class CursorOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'cursor';

	/**
	 * Parse a single JSON line from Cursor output.
	 * Delegates to parseJsonObject after JSON.parse.
	 *
	 * Cursor stream-json event types:
	 * - { type: 'system', subtype: 'init', model: '...' }
	 * - { type: 'assistant', message: { content: [{ text: '...' }] } }
	 * - { type: 'tool_call', subtype: 'started'|'completed', args: { path: '...' } }
	 * - { type: 'result', duration_ms: 1234 }
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			return this.parseJsonObject(JSON.parse(line));
		} catch {
			// Not valid JSON - return as raw text event
			return {
				type: 'text',
				text: line,
				raw: line,
			};
		}
	}

	/**
	 * Parse a pre-parsed JSON object into a normalized event.
	 * Core logic extracted from parseJsonLine to avoid redundant JSON.parse calls.
	 */
	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		return this.transformMessage(parsed as CursorRawMessage);
	}

	/**
	 * Transform a parsed Cursor message into a normalized ParsedEvent
	 */
	private transformMessage(msg: CursorRawMessage): ParsedEvent {
		// Handle system/init messages
		if (msg.type === 'system' && msg.subtype === 'init') {
			return {
				type: 'init',
				text: msg.model ? `Model: ${msg.model}` : undefined,
				raw: msg,
			};
		}

		// Handle assistant messages (text content)
		if (msg.type === 'assistant') {
			const text = this.extractTextFromMessage(msg);
			return {
				type: 'text',
				text,
				isPartial: true,
				raw: msg,
			};
		}

		// Handle tool_call events
		if (msg.type === 'tool_call') {
			return this.transformToolCall(msg);
		}

		// Handle result messages (final completion)
		if (msg.type === 'result') {
			return {
				type: 'result',
				text: msg.duration_ms !== undefined ? `Completed in ${msg.duration_ms}ms` : undefined,
				raw: msg,
			};
		}

		// Handle error messages
		if (msg.type === 'error' || msg.error) {
			return {
				type: 'error',
				text: extractErrorText(msg.error),
				raw: msg,
			};
		}

		// Default: preserve as system event
		return {
			type: 'system',
			raw: msg,
		};
	}

	/**
	 * Transform a tool_call event based on its subtype
	 */
	private transformToolCall(msg: CursorRawMessage): ParsedEvent {
		const toolName = this.extractToolName(msg);

		if (msg.subtype === 'started') {
			return {
				type: 'tool_use',
				toolName,
				toolState: {
					status: 'running',
					input: msg.args,
				},
				raw: msg,
			};
		}

		if (msg.subtype === 'completed') {
			return {
				type: 'tool_use',
				toolName,
				toolState: {
					status: 'completed',
					output: msg.result,
				},
				raw: msg,
			};
		}

		// Unknown tool_call subtype
		return {
			type: 'tool_use',
			toolName,
			toolState: {
				status: msg.subtype || 'unknown',
			},
			raw: msg,
		};
	}

	/**
	 * Extract tool name from a tool_call message.
	 * Cursor uses tool type names like writeToolCall, readToolCall.
	 * Strip the "ToolCall" suffix for cleaner display.
	 */
	private extractToolName(msg: CursorRawMessage): string | undefined {
		// Check args for path-based tool identification
		const args = msg.args as Record<string, unknown> | undefined;
		if (args?.path) {
			// If it has a path arg, try to derive tool name from context
			if (msg.subtype === 'started' && args.content !== undefined) {
				return 'write';
			}
			return 'read';
		}

		// Fallback: use subtype or generic name
		return undefined;
	}

	/**
	 * Extract text content from a Cursor assistant message
	 */
	private extractTextFromMessage(msg: CursorRawMessage): string {
		if (!msg.message?.content) {
			return '';
		}

		if (typeof msg.message.content === 'string') {
			return msg.message.content;
		}

		// Array of content blocks - extract text
		return msg.message.content
			.filter((block) => block.type === 'text' && block.text)
			.map((block) => block.text!)
			.join('');
	}

	/**
	 * Check if an event is a final result message
	 */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	/**
	 * Extract session ID from an event.
	 * Cursor does not document session IDs in stream-json output,
	 * but we check in case they appear in undocumented fields.
	 */
	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId || null;
	}

	/**
	 * Extract usage statistics from an event.
	 * Cursor does not expose token usage or cost in CLI output.
	 */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	/**
	 * Extract slash commands from an event.
	 * Cursor supports slash commands (/plan, /ask, /sandbox, /max-mode)
	 * but they are not reported in stream-json init events.
	 * Return known commands from documentation.
	 */
	extractSlashCommands(event: ParsedEvent): string[] | null {
		if (event.type === 'init') {
			return ['/plan', '/ask', '/sandbox', '/max-mode'];
		}
		return null;
	}

	/**
	 * Detect an error from a line of agent output.
	 * Delegates to detectErrorFromParsed for valid JSON.
	 */
	detectErrorFromLine(line: string): AgentError | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const error = this.detectErrorFromParsed(JSON.parse(line));
			if (error) {
				error.raw = { ...(error.raw as Record<string, unknown>), errorLine: line };
			}
			return error;
		} catch {
			// Not JSON - check raw text for error patterns
			const patterns = getErrorPatterns(this.agentId);
			const match = matchErrorPattern(patterns, line);
			if (match) {
				return {
					type: match.type,
					message: match.message,
					recoverable: match.recoverable,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { errorLine: line },
				};
			}
			return null;
		}
	}

	/**
	 * Detect an error from a pre-parsed JSON object.
	 * Core logic extracted from detectErrorFromLine to avoid redundant JSON.parse calls.
	 */
	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const obj = parsed as Record<string, unknown>;
		let errorText: string | null = null;
		let parsedJson: unknown = null;

		if (obj.type === 'error' || obj.error) {
			parsedJson = parsed;
			errorText = extractErrorText(obj.error as CursorRawMessage['error']);
			if (errorText === 'Unknown error') errorText = null;
		}

		if (!errorText) {
			return null;
		}

		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, errorText);

		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				parsedJson,
			};
		}

		// Structured error event that didn't match a known pattern
		if (parsedJson) {
			return {
				type: 'unknown',
				message: errorText,
				recoverable: true,
				agentId: this.agentId,
				timestamp: Date.now(),
				parsedJson,
			};
		}

		return null;
	}

	/**
	 * Detect an error from process exit information
	 */
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		// Exit code 0 is success
		if (exitCode === 0) {
			return null;
		}

		// Check stderr and stdout for error patterns
		const combined = `${stderr}\n${stdout}`;
		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, combined);

		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: {
					exitCode,
					stderr,
					stdout,
				},
			};
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
