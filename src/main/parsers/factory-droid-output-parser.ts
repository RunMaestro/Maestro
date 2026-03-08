/**
 * Factory Droid Output Parser
 *
 * Parses JSON output from Factory Droid CLI (`droid exec -o stream-json`).
 *
 * Factory Droid outputs JSONL with the following format:
 *
 * 1. Init event:
 *    {"type":"system","subtype":"init","session_id":"...","model":"...","tools":[...],...}
 *
 * 2. User message:
 *    {"type":"message","role":"user","id":"...","text":"...","timestamp":...,"session_id":"..."}
 *
 * 3. Assistant message:
 *    {"type":"message","role":"assistant","id":"...","text":"...","timestamp":...,"session_id":"..."}
 *
 * 4. Completion event:
 *    {"type":"completion","finalText":"...","numTurns":...,"durationMs":...,"session_id":"..."}
 *
 * Verified against Factory Droid CLI output (2026-01-22)
 * @see https://docs.factory.ai/cli
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/**
 * Raw message structure from Factory Droid stream-json output
 */
interface FactoryStreamMessage {
	type: 'system' | 'message' | 'completion' | 'error';
	subtype?: 'init'; // For system events
	role?: 'user' | 'assistant';
	id?: string;
	text?: string;
	finalText?: string;
	timestamp?: number;
	session_id?: string;
	// Init event fields
	cwd?: string;
	tools?: string[];
	model?: string;
	reasoning_effort?: string;
	// Completion event fields
	numTurns?: number;
	durationMs?: number;
	// Error fields
	error?: string | { message?: string; data?: { message?: string } };
	// Usage stats (in completion event) - uses snake_case
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
		thinking_tokens?: number;
	};
}

/**
 * Type guard to validate parsed JSON matches FactoryStreamMessage structure
 */
function isFactoryStreamMessage(data: unknown): data is FactoryStreamMessage {
	if (typeof data !== 'object' || data === null) {
		return false;
	}
	const obj = data as Record<string, unknown>;
	// Must have a valid type field
	return (
		typeof obj.type === 'string' && ['system', 'message', 'completion', 'error'].includes(obj.type)
	);
}

/**
 * Factory Droid Output Parser Implementation
 *
 * Transforms Factory Droid's stream-json format into normalized ParsedEvents.
 */
export class FactoryDroidOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'factory-droid';

	/**
	 * Parse a single JSON line from Factory Droid output.
	 * Delegates to parseJsonObject after JSON.parse.
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const parsed: unknown = JSON.parse(line);
			// parseJsonObject handles non-Factory messages by returning null;
			// fall through to raw text for those
			return (
				this.parseJsonObject(parsed) ?? {
					type: 'text' as const,
					text: line,
					isPartial: true,
					raw: parsed,
				}
			);
		} catch {
			// Not valid JSON - return as raw text event
			if (line.trim()) {
				return {
					type: 'text',
					text: line,
					isPartial: true,
					raw: line,
				};
			}
			return null;
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

		if (!isFactoryStreamMessage(parsed)) {
			return null;
		}

		const data = parsed;

		switch (data.type) {
			case 'system':
				return this.parseSystemEvent(data);

			case 'message':
				return this.parseMessageEvent(data);

			case 'completion':
				return this.parseCompletionEvent(data);

			case 'error':
				return this.parseErrorEvent(data);

			default:
				return {
					type: 'system',
					sessionId: data.session_id,
					raw: data,
				};
		}
	}

	/**
	 * Parse system events (init, etc.)
	 */
	private parseSystemEvent(data: FactoryStreamMessage): ParsedEvent {
		if (data.subtype === 'init') {
			return {
				type: 'init',
				sessionId: data.session_id,
				raw: data,
			};
		}

		return {
			type: 'system',
			sessionId: data.session_id,
			raw: data,
		};
	}

	/**
	 * Parse message events (user and assistant messages)
	 */
	private parseMessageEvent(data: FactoryStreamMessage): ParsedEvent | null {
		if (data.role === 'assistant' && data.text) {
			// Assistant message - emit as partial text for streaming
			return {
				type: 'text',
				text: data.text,
				isPartial: true,
				raw: data,
			};
		}

		if (data.role === 'user' && data.text) {
			// User message echo - just return as system info
			return {
				type: 'system',
				raw: data,
			};
		}

		return null;
	}

	/**
	 * Parse completion event (end of response)
	 */
	private parseCompletionEvent(data: FactoryStreamMessage): ParsedEvent {
		return {
			type: 'result',
			text: data.finalText || '',
			sessionId: data.session_id,
			usage: this.extractUsageFromData(data),
			raw: data,
		};
	}

	/**
	 * Parse error event
	 */
	private parseErrorEvent(data: FactoryStreamMessage): ParsedEvent {
		let errorText = '';
		if (typeof data.error === 'string') {
			errorText = data.error;
		} else if (data.error) {
			errorText = data.error.data?.message || data.error.message || 'Unknown error';
		}
		return {
			type: 'error',
			text: errorText,
			raw: data,
		};
	}

	/**
	 * Extract usage statistics from completion data
	 */
	private extractUsageFromData(data: FactoryStreamMessage): ParsedEvent['usage'] | undefined {
		const usage = data.usage;
		if (!usage) return undefined;

		return {
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
			cacheReadTokens: usage.cache_read_input_tokens || 0,
			cacheCreationTokens: usage.cache_creation_input_tokens || 0,
			reasoningTokens: usage.thinking_tokens || 0,
		};
	}

	/**
	 * Check if an event is a final result message
	 */
	isResultMessage(event: ParsedEvent): boolean {
		if (event.type === 'result') return true;
		const raw = event.raw as FactoryStreamMessage | undefined;
		return raw?.type === 'completion';
	}

	/**
	 * Extract session ID from an event
	 */
	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) return event.sessionId;
		const raw = event.raw as FactoryStreamMessage | undefined;
		return raw?.session_id || null;
	}

	/**
	 * Extract usage statistics from an event
	 */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	/**
	 * Extract slash commands from an event
	 * NOTE: Factory Droid doesn't use slash commands
	 */
	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

	/**
	 * Detect an error from a line of agent output.
	 * Delegates to detectErrorFromParsed after JSON.parse.
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
			// Not JSON - skip
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

		const obj = parsed as FactoryStreamMessage;
		let errorText: string | null = null;

		if (obj.type === 'error' && obj.error) {
			if (typeof obj.error === 'string') {
				errorText = obj.error;
			} else if (obj.error.data?.message) {
				errorText = obj.error.data.message;
			} else if (obj.error.message) {
				errorText = obj.error.message;
			}
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
				raw: { parsedJson: parsed },
				parsedJson: parsed,
			};
		}

		return {
			type: 'unknown',
			message: errorText,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { parsedJson: parsed },
			parsedJson: parsed,
		};
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
				raw: { exitCode, stderr, stdout },
			};
		}

		// Non-zero exit with no recognized pattern
		const stderrPreview = stderr?.trim()
			? `: ${stderr.trim().split('\n')[0].substring(0, 200)}`
			: '';
		return {
			type: 'agent_crashed',
			message: `Factory Droid exited with code ${exitCode}${stderrPreview}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}
}
