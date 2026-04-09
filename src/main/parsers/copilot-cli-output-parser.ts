/**
 * Copilot CLI Output Parser
 *
 * Parses JSONL output from GitHub Copilot CLI (`copilot -p "prompt" --output-format json`).
 *
 * Verified event types (Copilot CLI v1.x, 2026):
 *
 * Session lifecycle:
 * - session.mcp_server_status_changed: MCP server connection status
 * - session.mcp_servers_loaded: All MCP servers initialized
 * - session.tools_updated: Model and tools finalized (contains model name)
 *
 * Conversation flow:
 * - user.message: Echo of user prompt (data.content, data.transformedContent)
 * - assistant.turn_start: Agent begins processing (data.turnId)
 * - assistant.message_delta: Streaming text chunk (data.deltaContent, ephemeral)
 * - assistant.message: Complete message with optional tool requests
 *     (data.content, data.toolRequests[], data.outputTokens)
 * - assistant.turn_end: Turn completed (data.turnId)
 *
 * Tool execution:
 * - tool.execution_start: Tool call begins (data.toolName, data.arguments)
 * - tool.execution_complete: Tool call finished (data.toolName, data.success, data.result)
 *
 * Completion:
 * - result: Session complete (sessionId, exitCode, usage.premiumRequests,
 *   usage.totalApiDurationMs, usage.sessionDurationMs)
 *
 * @see https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

// ============================================================================
// Copilot CLI JSONL Types (verified against actual output)
// ============================================================================

/** Top-level JSONL message envelope */
interface CopilotCliMessage {
	type: string;
	data?: Record<string, unknown>;
	id?: string;
	timestamp?: string;
	parentId?: string;
	ephemeral?: boolean;
	// Top-level fields on 'result' event
	sessionId?: string;
	exitCode?: number;
	usage?: CopilotCliUsage;
	error?: string | { message?: string; type?: string; code?: string };
}

/** Usage stats from the 'result' event */
interface CopilotCliUsage {
	premiumRequests?: number;
	totalApiDurationMs?: number;
	sessionDurationMs?: number;
	codeChanges?: {
		linesAdded?: number;
		linesRemoved?: number;
		filesModified?: string[];
	};
}

/** Tool request within assistant.message */
interface CopilotCliToolRequest {
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	type?: string;
	intentionSummary?: string;
}

// ============================================================================
// Helper functions
// ============================================================================

/** Extract a human-readable error message from Copilot CLI's polymorphic error field */
function extractErrorText(error: CopilotCliMessage['error'], fallback = 'Unknown error'): string {
	if (typeof error === 'object' && error?.message) return error.message;
	if (typeof error === 'string') return error;
	return fallback;
}

// Maximum length for tool output to prevent oversized log entries
const MAX_TOOL_OUTPUT_LENGTH = 10000;

// ============================================================================
// Parser implementation
// ============================================================================

/**
 * Copilot CLI Output Parser
 *
 * Transforms Copilot CLI's JSONL output into normalized ParsedEvents.
 * Verified against Copilot CLI output (2026).
 */
export class CopilotCliOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'copilot-cli';

	// Accumulate output tokens from assistant.message events for usage reporting
	private accumulatedOutputTokens = 0;

	/**
	 * Parse a single JSON line from Copilot CLI output.
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			return this.parseJsonObject(JSON.parse(line));
		} catch {
			// Not valid JSON — return as raw text event
			return {
				type: 'text',
				text: line,
				raw: line,
			};
		}
	}

	/**
	 * Parse a pre-parsed JSON object into a normalized event.
	 */
	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		return this.transformMessage(parsed as CopilotCliMessage);
	}

	/**
	 * Transform a parsed Copilot CLI message into a normalized ParsedEvent.
	 */
	private transformMessage(msg: CopilotCliMessage): ParsedEvent {
		switch (msg.type) {
			// ---- Session lifecycle (system events) ----

			case 'session.mcp_server_status_changed':
			case 'session.mcp_servers_loaded':
				return { type: 'system', raw: msg };

			case 'session.tools_updated':
				// Contains model name in data.model — emit as init
				return { type: 'init', raw: msg };

			// ---- User message echo ----

			case 'user.message':
				return { type: 'system', raw: msg };

			// ---- Assistant turn lifecycle ----

			case 'assistant.turn_start':
				return { type: 'system', raw: msg };

			case 'assistant.message_delta': {
				// Streaming text chunk — data.deltaContent
				const deltaContent = (msg.data?.deltaContent as string) || '';
				return {
					type: 'text',
					text: deltaContent,
					isPartial: true,
					raw: msg,
				};
			}

			case 'assistant.message': {
				// Complete message — may contain text content and/or tool requests
				const content = (msg.data?.content as string) || '';
				const toolRequests = (msg.data?.toolRequests as CopilotCliToolRequest[]) || [];
				const outputTokens = (msg.data?.outputTokens as number) || 0;

				// Track output tokens for usage reporting
				this.accumulatedOutputTokens += outputTokens;

				// If the message has tool requests but no text, emit tool_use blocks
				if (toolRequests.length > 0 && !content) {
					return {
						type: 'tool_use',
						toolUseBlocks: toolRequests.map((tr) => ({
							name: tr.name,
							id: tr.toolCallId,
							input: tr.arguments,
						})),
						raw: msg,
					};
				}

				// If the message has tool requests AND text, emit as text with tool blocks
				if (toolRequests.length > 0 && content) {
					return {
						type: 'text',
						text: content,
						toolUseBlocks: toolRequests.map((tr) => ({
							name: tr.name,
							id: tr.toolCallId,
							input: tr.arguments,
						})),
						raw: msg,
					};
				}

				// Text-only message — this is the agent's response
				return {
					type: 'result',
					text: content,
					isPartial: false,
					raw: msg,
				};
			}

			case 'assistant.turn_end':
				return { type: 'system', raw: msg };

			// ---- Tool execution ----

			case 'tool.execution_start': {
				const toolName = (msg.data?.toolName as string) || undefined;
				return {
					type: 'tool_use',
					toolName,
					toolState: {
						status: 'running',
						input: msg.data?.arguments,
					},
					raw: msg,
				};
			}

			case 'tool.execution_complete': {
				const toolName = (msg.data?.toolName as string) || undefined;
				const result = msg.data?.result as
					| { content?: string; detailedContent?: string }
					| undefined;
				let output = result?.content || '';
				if (output.length > MAX_TOOL_OUTPUT_LENGTH) {
					const originalLength = output.length;
					output =
						output.substring(0, MAX_TOOL_OUTPUT_LENGTH) +
						`\n... [output truncated, ${originalLength} chars total]`;
				}
				return {
					type: 'tool_use',
					toolName,
					toolState: {
						status: 'completed',
						output,
						success: msg.data?.success,
					},
					raw: msg,
				};
			}

			// ---- Result (session complete) ----

			case 'result': {
				const event: ParsedEvent = {
					type: 'usage',
					sessionId: msg.sessionId,
					raw: msg,
				};

				// Always report accumulated output tokens, regardless of msg.usage
				event.usage = {
					inputTokens: 0,
					outputTokens: this.accumulatedOutputTokens,
				};

				// Reset for next session (parser is a singleton)
				this.accumulatedOutputTokens = 0;

				return event;
			}

			// ---- Error events ----

			default: {
				// Check for error-like events
				if (msg.type?.includes('error') || msg.error) {
					return {
						type: 'error',
						text: extractErrorText(msg.error),
						raw: msg,
					};
				}

				// Unknown event type — preserve as system
				return { type: 'system', raw: msg };
			}
		}
	}

	/**
	 * Check if an event is a final result message.
	 * For Copilot CLI, assistant.message events with content and no tool requests
	 * are result messages.
	 */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result' && !!event.text;
	}

	/**
	 * Extract session ID from an event.
	 * Copilot CLI provides sessionId in the final 'result' event.
	 */
	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId || null;
	}

	/**
	 * Extract usage statistics from an event.
	 */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	/**
	 * Extract slash commands from an event.
	 * Copilot CLI supports slash commands interactively, but they're not
	 * emitted in the JSON output.
	 */
	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

	/**
	 * Detect an error from a line of agent output.
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
			// Not JSON — check plain text against error patterns
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
	 */
	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const obj = parsed as CopilotCliMessage;
		let errorText: string | null = null;
		let parsedJson: unknown = null;

		// Handle session.error events (Copilot CLI format: data.message, data.errorType)
		if (obj.type === 'session.error' && obj.data) {
			parsedJson = parsed;
			errorText = (obj.data.message as string) || null;
		}
		// Handle generic error events
		else if (obj.type?.includes('error') || obj.error) {
			parsedJson = parsed;
			errorText = extractErrorText(obj.error);
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

		// Unrecognized error — still report it
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
	 * Detect an error from process exit information.
	 */
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) {
			return null;
		}

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
				raw: { exitCode },
			};
		}

		// Non-zero exit with no recognized pattern
		return {
			type: 'agent_crashed',
			message: `Copilot CLI exited with code ${exitCode}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode },
		};
	}
}
