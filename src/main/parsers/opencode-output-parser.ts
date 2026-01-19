/**
 * OpenCode Output Parser
 *
 * Parses JSON output from OpenCode CLI (`opencode run --format json`).
 * OpenCode outputs JSONL with the following message types:
 *
 * - step_start: Beginning of an agent step (contains sessionID, part.type="step-start")
 * - text: Text content (contains part.text, streaming response chunks)
 * - tool_use: Tool execution (contains part.tool, part.state with status/input/output)
 * - step_finish: End of step (contains part.reason, part.tokens with usage stats)
 *
 * Key schema details:
 * - Each message has: type, timestamp, sessionID, part
 * - Session IDs use camelCase: sessionID (not snake_case like Claude)
 * - Text is in part.text, not directly on message
 * - Token stats are in part.tokens: { input, output, reasoning, cache: { read, write } }
 * - Tool state has: status, input, output, title, metadata
 * - step_finish reason values: "stop" (complete), "tool-calls" (more work), "error"
 *
 * Verified against OpenCode CLI output (2025-12-16)
 * @see https://github.com/opencode-ai/opencode
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import { stripAllAnsiCodes } from '../utils/terminalFilter';

/**
 * Error object structure from OpenCode
 * Can be a simple string or a complex object with nested error details
 */
interface OpenCodeErrorObject {
	name?: string;
	message?: string;
	data?: {
		message?: string;
		[key: string]: unknown;
	};
	responseBody?: {
		error?: {
			type?: string;
			message?: string;
		};
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/**
 * Raw message structure from OpenCode output
 * Verified from actual OpenCode CLI output (2025-12-16)
 */
interface OpenCodeRawMessage {
	type?: 'step_start' | 'text' | 'tool_use' | 'step_finish' | 'error';
	timestamp?: number;
	sessionID?: string;
	part?: OpenCodePart;
	error?: string | OpenCodeErrorObject;
}

/**
 * Part structure embedded in OpenCode messages
 * Different message types have different part structures
 */
interface OpenCodePart {
	id?: string;
	sessionID?: string;
	messageID?: string;
	type?: 'step-start' | 'text' | 'tool' | 'step-finish';

	// For text type
	text?: string;
	time?: {
		start?: number;
		end?: number;
	};

	// For tool type
	callID?: string;
	tool?: string;
	state?: {
		status?: 'pending' | 'running' | 'completed' | 'error';
		input?: Record<string, unknown>;
		output?: string;
		title?: string;
		metadata?: Record<string, unknown>;
		time?: {
			start?: number;
			end?: number;
		};
	};

	// For step-finish type
	reason?: 'stop' | 'tool-calls' | 'error';
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cache?: {
			read?: number;
			write?: number;
		};
	};
}

/**
 * OpenCode Output Parser Implementation
 *
 * Transforms OpenCode's JSON format into normalized ParsedEvents.
 * Verified against actual OpenCode CLI output (2025-12-16).
 */
export class OpenCodeOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'opencode';

	/**
	 * Parse a single JSON line from OpenCode output
	 *
	 * OpenCode message types (verified 2025-12-16):
	 * - { type: 'step_start', sessionID, part: { type: 'step-start' } }
	 * - { type: 'text', sessionID, part: { text, type: 'text' } }
	 * - { type: 'tool_use', sessionID, part: { tool, state: { status, input, output }, type: 'tool' } }
	 * - { type: 'step_finish', sessionID, part: { reason, tokens, type: 'step-finish' } }
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const msg: OpenCodeRawMessage = JSON.parse(line);
			return this.transformMessage(msg);
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
	 * Transform a parsed OpenCode message into a normalized ParsedEvent
	 */
	private transformMessage(msg: OpenCodeRawMessage): ParsedEvent {
		// Handle step_start messages (session initialization)
		if (msg.type === 'step_start') {
			return {
				type: 'init',
				sessionId: msg.sessionID,
				raw: msg,
			};
		}

		// Handle text messages (streaming content)
		if (msg.type === 'text') {
			return {
				type: 'text',
				text: msg.part?.text || '',
				sessionId: msg.sessionID,
				isPartial: true,
				raw: msg,
			};
		}

		// Handle tool_use messages
		// Tool info is in part.tool (tool name) and part.state (execution state)
		if (msg.type === 'tool_use') {
			return {
				type: 'tool_use',
				toolName: msg.part?.tool,
				toolState: msg.part?.state,
				sessionId: msg.sessionID,
				raw: msg,
			};
		}

		// Handle step_finish messages (step completion with token stats)
		// part.reason indicates: "stop" (final), "tool-calls" (more work), "error"
		if (msg.type === 'step_finish') {
			// Only mark as "result" if reason is "stop" (final response)
			// "tool-calls" means more work is coming, so treat as system event
			const isFinalResult = msg.part?.reason === 'stop';

			const event: ParsedEvent = {
				type: isFinalResult ? 'result' : 'system',
				sessionId: msg.sessionID,
				raw: msg,
			};

			// Extract usage stats if present
			const usage = this.extractUsageFromRaw(msg);
			if (usage) {
				event.usage = usage;
			}

			return event;
		}

		// Handle error messages (e.g., { type: "error", error: { name: "APIError", data: { message: "..." } } })
		// These should NOT emit text data - they're handled by detectErrorFromLine
		if (msg.type === 'error' || msg.error) {
			// Extract human-readable message for display if available
			let errorMessage = '';
			const errorObj = msg.error;
			if (typeof errorObj === 'string') {
				errorMessage = errorObj;
			} else if (errorObj && typeof errorObj === 'object') {
				if (errorObj.data?.message) {
					errorMessage = errorObj.data.message;
				} else if (errorObj.message) {
					errorMessage = errorObj.message;
				}
			}
			return {
				type: 'error',
				text: errorMessage,
				sessionId: msg.sessionID,
				raw: msg,
			};
		}

		// Handle messages with only session info or other types
		if (msg.sessionID) {
			return {
				type: 'system',
				sessionId: msg.sessionID,
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
	 * Extract usage statistics from raw OpenCode message
	 * OpenCode tokens structure: { input, output, reasoning, cache: { read, write } }
	 */
	private extractUsageFromRaw(msg: OpenCodeRawMessage): ParsedEvent['usage'] | null {
		if (!msg.part?.tokens) {
			return null;
		}

		const tokens = msg.part.tokens;
		return {
			inputTokens: tokens.input || 0,
			outputTokens: tokens.output || 0,
			cacheReadTokens: tokens.cache?.read || 0,
			cacheCreationTokens: tokens.cache?.write || 0,
			// OpenCode provides cost per step in part.cost (in dollars)
			costUsd: msg.part.cost || 0,
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
	 * NOTE: OpenCode slash command support is unverified
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
	 * 1. Structured JSON: { error: "message" } or { type: "error", message: "..." }
	 * 2. stderr output (handled separately by process-manager)
	 * 3. Non-zero exit code (handled by detectErrorFromExit)
	 */
	detectErrorFromLine(line: string): AgentError | null {
		// Skip empty lines
		if (!line.trim()) {
			return null;
		}

		// Only detect errors from structured JSON error events
		// Do NOT pattern match on arbitrary text - it causes false positives
		let errorText: string | null = null;
		let parsedJson: unknown = null;
		try {
			const parsed = JSON.parse(line);

			// OpenCode error format: { type: "error", error: { name: "APIError", data: { message: "..." }, ... } }
			if (parsed.type === 'error' && parsed.error) {
				// Store the full parsed error for display in the modal
				parsedJson = parsed;

				// Extract the error message from various possible locations
				const errorObj = parsed.error;
				if (errorObj.data?.message) {
					errorText = errorObj.data.message;
				} else if (errorObj.message) {
					errorText = errorObj.message;
				} else if (errorObj.responseBody?.error?.message) {
					errorText = errorObj.responseBody.error.message;
				} else if (typeof errorObj === 'string') {
					errorText = errorObj;
				}
			}
			// Simple error format: { error: "message" }
			else if (typeof parsed.error === 'string') {
				errorText = parsed.error;
				parsedJson = parsed;
			}
			// Alternative format: { type: "error", message: "..." }
			else if (parsed.type === 'error' && parsed.message) {
				errorText = parsed.message;
				parsedJson = parsed;
			}
			// If no error field in JSON, this is normal output - don't check it
		} catch {
			// Not JSON - skip pattern matching entirely
			// Errors should come through structured JSON, stderr, or exit codes
			// Pattern matching on arbitrary text causes false positives
		}

		// If no error text was extracted, no error to detect
		if (!errorText) {
			return null;
		}

		// Match against error patterns
		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, errorText);

		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: {
					errorLine: line,
				},
				parsedJson,
			};
		}

		// If we found a structured error but no pattern matched, return a generic error
		if (parsedJson) {
			return {
				type: 'unknown',
				message: errorText,
				recoverable: true,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: {
					errorLine: line,
				},
				parsedJson,
			};
		}

		return null;
	}

	/**
	 * Detect an error from process exit information
	 */
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		// OpenCode quirk: sometimes exits with code 0 even on errors (e.g., invalid provider)
		// If exit code is 0 but there's stderr content and no stdout, treat as error
		const hasStderr = stderr?.trim().length > 0;
		const hasStdout = stdout?.trim().length > 0;

		if (exitCode === 0 && hasStderr && !hasStdout) {
			// Check stderr for known error patterns (strip ANSI codes first)
			const cleanedStderrForPatterns = stripAllAnsiCodes(stderr);
			const patterns = getErrorPatterns(this.agentId);
			const match = matchErrorPattern(patterns, cleanedStderrForPatterns);

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

			// No pattern matched but stderr with no stdout is suspicious
			// Strip ANSI codes and extract the actual error message from stderr
			const cleanedStderr = stripAllAnsiCodes(stderr);
			const stderrLines = cleanedStderr.trim().split('\n');

			// Look for actual error messages, skipping:
			// - Source code lines (e.g., "847 |     const provider = ...")
			// - Empty lines
			// - Lines that are just variable assignments or code
			const meaningfulLine =
				stderrLines.find((line) => {
					const trimmed = line.trim();
					// Skip empty or very short lines
					if (trimmed.length < 10) return false;
					// Skip source code context lines (numbered lines like "847 |")
					if (trimmed.match(/^\d+\s*\|/)) return false;
					// Skip lines that look like code (assignments, function calls without error keywords)
					if (trimmed.match(/^(const|let|var|if|for|while|return|function)\s+/)) return false;
					// Skip lines that are just variable references
					if (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*\s*(=|\.)/)) return false;
					// Prefer lines with error-like keywords
					if (trimmed.match(/error|fail|invalid|not found|unknown|cannot|unable/i)) return true;
					// Accept other non-code looking lines
					return !trimmed.match(/^\s*[{}\[\]();,]\s*$/);
				}) ||
				stderrLines.find(
					(line) =>
						// Fallback: find any line that's not obviously code
						line.trim().length > 10 && !line.match(/^\s*\d+\s*\|/)
				) ||
				'Unknown error (check stderr)';

			return {
				type: 'agent_crashed',
				message: `OpenCode failed: ${meaningfulLine.trim().substring(0, 200)}`,
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

		// Exit code 0 with stdout is success
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
		// Include stderr in the message if available for better debugging
		const stderrPreview = stderr?.trim()
			? `: ${stderr.trim().split('\n')[0].substring(0, 200)}`
			: '';
		return {
			type: 'agent_crashed',
			message: `Agent exited with code ${exitCode}${stderrPreview}`,
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
