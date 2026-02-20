/**
 * Gemini CLI Output Parser
 *
 * Parses JSON output from Gemini CLI (`gemini --output-format stream-json`).
 * Gemini outputs NDJSON (newline-delimited JSON) with six event types:
 *
 * - init: Session initialization (session_id, model)
 * - message: Text content (role, content, optional delta for streaming)
 * - tool_use: Tool invocation (tool_name, tool_id, parameters)
 * - tool_result: Tool execution result (tool_id, status, output/error)
 * - error: Mid-stream non-fatal warning/error (severity, message)
 * - result: Final result with status and optional usage stats
 *
 * Key schema details:
 * - Session IDs are in session_id field on init events
 * - Token counts are per-turn (NOT cumulative) — no normalization needed
 * - Stats can be flat (input_tokens, output_tokens) or nested under models.{name}.tokens
 * - Exit codes: 0=success, 41=auth, 42=input, 52=config, 53=turn limit, 130=cancelled
 *
 * @see https://github.com/google-gemini/gemini-cli
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

// ============================================================================
// Gemini stream-json Event Interfaces
// ============================================================================

interface GeminiInitEvent {
	type: 'init';
	timestamp?: string;
	session_id?: string;
	model?: string;
}

interface GeminiMessageEvent {
	type: 'message';
	timestamp?: string;
	role: 'user' | 'assistant';
	content: string;
	delta?: boolean;
}

interface GeminiToolUseEvent {
	type: 'tool_use';
	timestamp?: string;
	tool_name: string;
	tool_id: string;
	parameters: Record<string, unknown>;
}

interface GeminiToolResultEvent {
	type: 'tool_result';
	timestamp?: string;
	tool_id: string;
	status: 'success' | 'error';
	output?: string;
	error?: { type: string; message: string };
}

interface GeminiErrorEvent {
	type: 'error';
	timestamp?: string;
	severity: 'warning' | 'error';
	message: string;
}

interface GeminiResultStats {
	total_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	cached?: number;
	duration_ms?: number;
	tool_calls?: number;
	thoughts_tokens?: number;
	models?: Record<string, {
		tokens?: {
			input?: number;
			prompt?: number;
			candidates?: number;
			total?: number;
			cached?: number;
			thoughts?: number;
			tool?: number;
		};
	}>;
}

interface GeminiResultEvent {
	type: 'result';
	timestamp?: string;
	status: 'success' | 'error';
	stats?: GeminiResultStats;
	error?: { type: string; message: string };
}

/** Discriminated union of all Gemini stream-json event types */
type GeminiEvent =
	| GeminiInitEvent
	| GeminiMessageEvent
	| GeminiToolUseEvent
	| GeminiToolResultEvent
	| GeminiErrorEvent
	| GeminiResultEvent;

// ============================================================================
// Gemini Output Parser
// ============================================================================

/**
 * Gemini CLI Output Parser Implementation
 *
 * Transforms Gemini CLI's stream-json NDJSON events into normalized ParsedEvents.
 */
export class GeminiOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'gemini-cli' as ToolType;

	/**
	 * Parse a single JSON line from Gemini stream-json output
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.startsWith('{')) {
			return null;
		}

		let event: GeminiEvent;
		try {
			event = JSON.parse(trimmed);
		} catch {
			return null;
		}

		if (!event.type) {
			return null;
		}

		switch (event.type) {
			case 'init':
				return {
					type: 'init',
					sessionId: event.session_id,
					text: `Gemini CLI session started (model: ${event.model || 'unknown'})`,
					raw: event,
				};

			case 'message':
				// Skip user messages — only emit assistant content
				if (event.role === 'user') {
					return null;
				}
				return {
					type: 'text',
					text: event.content,
					isPartial: event.delta === true,
					raw: event,
				};

			case 'tool_use':
				return {
					type: 'tool_use',
					toolName: event.tool_name,
					toolState: {
						id: event.tool_id,
						name: event.tool_name,
						parameters: event.parameters,
						status: 'running',
					},
					raw: event,
				};

			case 'tool_result':
				return {
					type: 'tool_use',
					toolName: undefined,
					toolState: {
						id: event.tool_id,
						status: event.status,
						output: event.output,
						error: event.error,
					},
					text: event.status === 'error'
						? `Tool error: ${event.error?.message || 'Unknown tool error'}`
						: undefined,
					raw: event,
				};

			case 'error':
				return {
					type: 'error',
					text: event.message,
					raw: event,
				};

			case 'result': {
				if (event.status === 'error') {
					return {
						type: 'error',
						text: event.error?.message || 'Gemini CLI error',
						raw: event,
					};
				}

				const usage = this.extractUsageFromStats(event.stats);
				return {
					type: 'result',
					text: '',
					usage: usage || undefined,
					raw: event,
				};
			}

			default:
				return null;
		}
	}

	/**
	 * Check if an event is a final result message
	 */
	isResultMessage(event: ParsedEvent): boolean {
		return (event.raw as GeminiEvent)?.type === 'result';
	}

	/**
	 * Extract session ID from an event
	 */
	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) {
			return event.sessionId;
		}
		const raw = event.raw as GeminiInitEvent | undefined;
		if (raw?.session_id) {
			return raw.session_id;
		}
		return null;
	}

	/**
	 * Extract usage statistics from an event
	 */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		if (event.usage) {
			return event.usage;
		}
		const raw = event.raw as GeminiResultEvent | undefined;
		if (raw?.stats) {
			return this.extractUsageFromStats(raw.stats);
		}
		return null;
	}

	/**
	 * Extract slash commands from an event
	 * Gemini CLI doesn't expose slash commands in stream-json output
	 */
	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

	/**
	 * Detect an error from a line of agent output
	 */
	detectErrorFromLine(line: string): AgentError | null {
		if (!line.trim()) {
			return null;
		}

		// Only check structured JSON error events to avoid false positives
		let errorText: string | null = null;
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === 'error' && parsed.message) {
				errorText = parsed.message;
			} else if (parsed.type === 'result' && parsed.status === 'error' && parsed.error?.message) {
				errorText = parsed.error.message;
			}
		} catch {
			// Not JSON — skip
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
				raw: { errorLine: line },
			};
		}

		return null;
	}

	/**
	 * Detect an error from process exit information
	 */
	detectErrorFromExit(exitCode: number, stderr: string, _stdout: string): AgentError | null {
		if (exitCode === 0) {
			return null;
		}

		// Check stderr against error patterns first
		if (stderr.trim()) {
			const patterns = getErrorPatterns(this.agentId);
			const match = matchErrorPattern(patterns, stderr);
			if (match) {
				return {
					type: match.type,
					message: match.message,
					recoverable: match.recoverable,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr },
				};
			}
		}

		// Map known Gemini CLI exit codes
		switch (exitCode) {
			case 41:
				return {
					type: 'auth_expired',
					message: 'Gemini authentication failed. Run: gemini login',
					recoverable: true,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr },
				};

			case 42:
				return {
					type: 'unknown',
					message: 'Invalid input — check prompt or arguments.',
					recoverable: false,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr },
				};

			case 52:
				return {
					type: 'unknown',
					message: 'Gemini CLI configuration error. Check ~/.gemini/settings.json',
					recoverable: false,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr },
				};

			case 53:
				return {
					type: 'token_exhaustion',
					message: 'Session turn limit exceeded.',
					recoverable: false,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr },
				};

			case 130:
				return {
					type: 'unknown',
					message: 'Operation cancelled by user.',
					recoverable: true,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr },
				};

			default:
				return {
					type: 'agent_crashed',
					message: `Gemini CLI exited with code ${exitCode}. ${stderr.trim() ? stderr.trim().slice(0, 200) : 'No additional error info.'}`,
					recoverable: false,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr },
				};
		}
	}

	/**
	 * Extract usage statistics from Gemini result stats
	 *
	 * Stats can appear in two formats:
	 * 1. Flat: { input_tokens, output_tokens, cached, duration_ms, tool_calls }
	 * 2. Nested: { models: { "model-name": { tokens: { input, prompt, candidates, total, cached, thoughts, tool } } } }
	 */
	private extractUsageFromStats(stats: GeminiResultStats | undefined): ParsedEvent['usage'] | null {
		if (!stats) {
			return null;
		}

		// Try flat fields first
		if (stats.input_tokens !== undefined || stats.output_tokens !== undefined) {
			return {
				inputTokens: stats.input_tokens || 0,
				outputTokens: stats.output_tokens || 0,
				cacheReadTokens: stats.cached || 0,
				reasoningTokens: stats.thoughts_tokens || 0,
			};
		}

		// Try nested models object
		if (stats.models) {
			const modelNames = Object.keys(stats.models);
			if (modelNames.length > 0) {
				let totalInput = 0;
				let totalOutput = 0;
				let totalCached = 0;
				let totalThoughts = 0;

				for (const modelName of modelNames) {
					const tokens = stats.models[modelName]?.tokens;
					if (tokens) {
						// input + prompt combined for inputTokens
						totalInput += (tokens.input || 0) + (tokens.prompt || 0);
						// candidates for outputTokens
						totalOutput += tokens.candidates || 0;
						totalCached += tokens.cached || 0;
						totalThoughts += tokens.thoughts || 0;
					}
				}

				if (totalInput > 0 || totalOutput > 0) {
					return {
						inputTokens: totalInput,
						outputTokens: totalOutput,
						cacheReadTokens: totalCached || undefined,
						reasoningTokens: totalThoughts || undefined,
					};
				}
			}
		}

		return null;
	}
}
