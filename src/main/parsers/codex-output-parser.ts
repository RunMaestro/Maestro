/**
 * Codex CLI Output Parser
 *
 * Parses JSON output from OpenAI Codex CLI (`codex exec --json`).
 * Supports two output formats:
 *
 * **Legacy format (v0.73.0+):**
 * - { type: 'thread.started', thread_id: 'uuid' }
 * - { type: 'turn.started' }
 * - { type: 'item.completed', item: { id, type, text|tool|args|output } }
 * - { type: 'turn.completed', usage: { input_tokens, output_tokens, cached_input_tokens } }
 *
 * **New format (v0.103.0+):**
 * Events wrapped in { id: 'N', msg: { type, ... } }:
 * - { id: '0', msg: { type: 'task_started', model_context_window: N } }
 * - { id: '0', msg: { type: 'agent_reasoning', text: '...' } }
 * - { id: '0', msg: { type: 'agent_message', message: '...' } }
 * - { id: '0', msg: { type: 'token_count', info: { total_token_usage: {...} }, rate_limits: {...} } }
 *
 * Also handles config/prompt echo lines:
 * - { provider: 'openai', ... } (config echo, ignored)
 * - { prompt: '...' } (prompt echo, ignored)
 *
 * @see https://github.com/openai/codex
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { captureException } from '../utils/sentry';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * OpenAI model pricing per million tokens (USD)
 * Source: https://openai.com/api/pricing/ (updated 2026-02-21)
 */
interface ModelPricing {
	inputPerM: number;
	cachedInputPerM: number;
	outputPerM: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
	// GPT-4o family
	'gpt-4o': { inputPerM: 2.5, cachedInputPerM: 1.25, outputPerM: 10.0 },
	'gpt-4o-mini': { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6 },
	// o-series reasoning models
	o1: { inputPerM: 15.0, cachedInputPerM: 7.5, outputPerM: 60.0 },
	'o1-mini': { inputPerM: 1.1, cachedInputPerM: 0.55, outputPerM: 4.4 },
	o3: { inputPerM: 2.0, cachedInputPerM: 0.5, outputPerM: 8.0 },
	'o3-mini': { inputPerM: 1.1, cachedInputPerM: 0.55, outputPerM: 4.4 },
	'o4-mini': { inputPerM: 1.1, cachedInputPerM: 0.275, outputPerM: 4.4 },
	// GPT-5 family
	'gpt-5-mini': { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2.0 },
	'gpt-5': { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0 },
	'gpt-5.1': { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0 },
	'gpt-5.1-codex': { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0 },
	'gpt-5.1-codex-max': { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0 },
	'gpt-5.2': { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14.0 },
	'gpt-5.2-codex': { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14.0 },
	'gpt-5.2-codex-max': { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14.0 },
	'gpt-5.3': { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14.0 },
	'gpt-5.3-codex': { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14.0 },
	'gpt-5.3-codex-max': { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14.0 },
	// GPT-4 Turbo
	'gpt-4-turbo': { inputPerM: 10.0, cachedInputPerM: 5.0, outputPerM: 30.0 },
	// Default fallback (assumes GPT-5.2-codex pricing)
	default: { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14.0 },
};

/**
 * Get pricing for a given model
 */
function getModelPricing(model: string): ModelPricing {
	if (MODEL_PRICING[model]) {
		return MODEL_PRICING[model];
	}
	for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
		if (model.startsWith(prefix)) {
			return pricing;
		}
	}
	return MODEL_PRICING['default'];
}

/**
 * Calculate cost in USD from token counts and model pricing
 * Note: cached_input_tokens is a SUBSET of input_tokens for OpenAI (already included)
 * So cost = (input - cached) * inputRate + cached * cachedRate + output * outputRate
 */
function calculateCost(
	pricing: ModelPricing,
	inputTokens: number,
	outputTokens: number,
	cachedInputTokens: number
): number {
	const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
	return (
		(uncachedInput / 1_000_000) * pricing.inputPerM +
		(cachedInputTokens / 1_000_000) * pricing.cachedInputPerM +
		(outputTokens / 1_000_000) * pricing.outputPerM
	);
}

/**
 * Known OpenAI model context window sizes (in tokens)
 * Source: https://platform.openai.com/docs/models
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	// GPT-4o family
	'gpt-4o': 128000,
	'gpt-4o-mini': 128000,
	'gpt-4o-2024-05-13': 128000,
	'gpt-4o-2024-08-06': 128000,
	'gpt-4o-2024-11-20': 128000,
	// o1/o3/o4 reasoning models
	o1: 200000,
	'o1-mini': 128000,
	'o1-preview': 128000,
	o3: 200000,
	'o3-mini': 200000,
	'o4-mini': 200000,
	// GPT-4 Turbo
	'gpt-4-turbo': 128000,
	'gpt-4-turbo-preview': 128000,
	'gpt-4-1106-preview': 128000,
	// GPT-4 (original)
	'gpt-4': 8192,
	'gpt-4-32k': 32768,
	// GPT-5 family (Codex default)
	'gpt-5': 200000,
	'gpt-5.1': 200000,
	'gpt-5.1-codex': 200000,
	'gpt-5.1-codex-max': 200000,
	'gpt-5.2': 400000,
	'gpt-5.2-codex': 400000,
	'gpt-5.2-codex-max': 400000,
	'gpt-5.3': 400000,
	'gpt-5.3-codex': 400000,
	'gpt-5.3-codex-max': 400000,
	// Default fallback (Codex defaults to GPT-5.2)
	default: 400000,
};

/**
 * Get the context window size for a given model
 */
function getModelContextWindow(model: string): number {
	// Try exact match first
	if (MODEL_CONTEXT_WINDOWS[model]) {
		return MODEL_CONTEXT_WINDOWS[model];
	}
	// Try prefix match (e.g., "gpt-4o-2024-11-20" matches "gpt-4o")
	for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (model.startsWith(prefix)) {
			return size;
		}
	}
	return MODEL_CONTEXT_WINDOWS['default'];
}

/**
 * Read Codex configuration from ~/.codex/config.toml
 * Returns the model name and context window override if set
 */
function readCodexConfig(): { model?: string; contextWindow?: number } {
	try {
		const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
		const configPath = path.join(codexHome, 'config.toml');

		if (!fs.existsSync(configPath)) {
			return {};
		}

		const content = fs.readFileSync(configPath, 'utf8');
		const result: { model?: string; contextWindow?: number } = {};

		// Simple TOML parsing for the fields we care about
		// model = "gpt-5.1"
		const modelMatch = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
		if (modelMatch) {
			result.model = modelMatch[1];
		}

		// model_context_window = 128000
		const windowMatch = content.match(/^\s*model_context_window\s*=\s*(\d+)/m);
		if (windowMatch) {
			result.contextWindow = parseInt(windowMatch[1], 10);
		}

		return result;
	} catch {
		// Config file doesn't exist or can't be read - use defaults
		return {};
	}
}

/**
 * Raw message structure from Codex JSON output (legacy v0.73.0+ format)
 */
interface CodexRawMessage {
	type?:
		| 'thread.started'
		| 'turn.started'
		| 'item.completed'
		| 'turn.completed'
		| 'turn.failed'
		| 'error';
	thread_id?: string;
	item?: CodexItem;
	usage?: CodexUsage;
	error?: string | { message?: string; type?: string };
}

/**
 * New wrapped message format from Codex CLI v0.103.0+
 * Events are wrapped in { id: 'N', msg: { type, ... } }
 */
interface CodexWrappedMessage {
	id?: string;
	msg?: CodexNewMsg;
	// Config/prompt echo lines
	provider?: string;
	prompt?: string;
}

/**
 * Inner message from the new wrapped format (v0.103.0+)
 */
interface CodexNewMsg {
	type?: string;
	// task_started
	model_context_window?: number;
	// agent_message
	message?: string;
	// agent_reasoning
	text?: string;
	// token_count
	info?: CodexTokenInfo | null;
	rate_limits?: Record<string, unknown>;
	// tool_call (new format)
	tool?: string;
	args?: Record<string, unknown>;
	// tool_result (new format)
	output?: string | number[];
	// error
	error?: string | { message?: string; type?: string };
}

/**
 * Token usage info from the new format's token_count events
 */
interface CodexTokenInfo {
	total_token_usage?: CodexUsage & { total_tokens?: number };
	last_token_usage?: CodexUsage & { total_tokens?: number };
	model_context_window?: number;
}

/**
 * Item structure for item.completed events (legacy format)
 */
interface CodexItem {
	id?: string;
	type?: 'reasoning' | 'agent_message' | 'tool_call' | 'tool_result' | 'error';
	text?: string;
	message?: string;
	tool?: string;
	args?: Record<string, unknown>;
	output?: string | number[];
}

/**
 * Usage statistics from turn.completed / token_count events
 */
interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	cached_input_tokens?: number;
	reasoning_output_tokens?: number;
}

/**
 * Extract a human-readable error message from Codex's polymorphic error field.
 * Codex sends errors as either a plain string or { message?, type? } object.
 */
function extractErrorText(error: CodexRawMessage['error'], fallback = 'Unknown error'): string {
	if (typeof error === 'object' && error?.message) return error.message;
	if (typeof error === 'string') return error;
	return fallback;
}

/**
 * Codex CLI Output Parser Implementation
 *
 * Transforms Codex's JSON format into normalized ParsedEvents.
 * Verified against Codex CLI v0.73.0+ output schema.
 */
export class CodexOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'codex';

	// Cached context window and pricing - read once from config
	private contextWindow: number;
	private model: string;
	private pricing: ModelPricing;

	// Track tool name from tool_call to carry over to tool_result
	// (Codex emits tool_call and tool_result as separate item.completed events,
	// but tool_result doesn't include the tool name)
	private lastToolName: string | null = null;

	constructor() {
		// Read config once at initialization
		const config = readCodexConfig();
		this.model = config.model || 'gpt-5.2-codex-max';

		// Priority: 1) explicit model_context_window in config, 2) lookup by model name
		this.contextWindow = config.contextWindow || getModelContextWindow(this.model);
		this.pricing = getModelPricing(this.model);
	}

	/**
	 * Parse a single JSON line from Codex output.
	 * Handles both legacy (v0.73.0+) and new wrapped (v0.103.0+) formats.
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const parsed = JSON.parse(line);

			// Detect new wrapped format: { id: 'N', msg: { type, ... } }
			if (parsed.id !== undefined && parsed.msg && typeof parsed.msg === 'object') {
				return this.transformWrappedMessage(parsed as CodexWrappedMessage, parsed);
			}

			// Detect config/prompt echo lines (new format preamble)
			if (parsed.provider || parsed.prompt) {
				return {
					type: 'system',
					raw: parsed,
				};
			}

			// Legacy format: { type: '...', ... }
			return this.transformMessage(parsed as CodexRawMessage);
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
	 * Transform a parsed Codex message into a normalized ParsedEvent
	 */
	private transformMessage(msg: CodexRawMessage): ParsedEvent {
		// Handle thread.started (session initialization with thread_id)
		if (msg.type === 'thread.started') {
			return {
				type: 'init',
				sessionId: msg.thread_id,
				raw: msg,
			};
		}

		// Handle turn.started (agent is processing)
		if (msg.type === 'turn.started') {
			return {
				type: 'system',
				raw: msg,
			};
		}

		// Handle item.completed events (reasoning, agent_message, tool_call, tool_result)
		if (msg.type === 'item.completed' && msg.item) {
			return this.transformItemCompleted(msg.item, msg);
		}

		// Handle turn.completed (end of turn with usage stats)
		// Note: This is NOT the result message - actual text comes from agent_message items
		// This event only contains usage statistics
		if (msg.type === 'turn.completed') {
			const event: ParsedEvent = {
				type: 'usage', // Mark as 'usage' type, not 'result'
				raw: msg,
			};

			// Extract usage stats if present
			const usage = this.extractUsageFromRaw(msg);
			if (usage) {
				event.usage = usage;
			}

			return event;
		}

		// Handle turn.failed (API errors, model not found, stream disconnections)
		// Format: {"type":"turn.failed","error":{"message":"stream disconnected before completion: ..."}}
		if (msg.type === 'turn.failed') {
			return {
				type: 'error',
				text: extractErrorText(msg.error, 'Turn failed'),
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
	 * Transform a new wrapped format message (v0.103.0+).
	 * Events are { id: 'N', msg: { type: '...', ... } }
	 */
	private transformWrappedMessage(wrapped: CodexWrappedMessage, raw: unknown): ParsedEvent {
		const msg = wrapped.msg;
		if (!msg || !msg.type) {
			return { type: 'system', raw };
		}

		switch (msg.type) {
			case 'task_started': {
				// Update context window from the actual model value if provided
				if (msg.model_context_window) {
					this.contextWindow = msg.model_context_window;
				}
				// Generate a display-only session ID for UI (so participant card doesn't show "pending").
				// Prefixed with 'codex-0-' to signal it's NOT resumable — synthetic IDs silently
				// start new sessions with `codex exec resume` instead of erroring.
				// Real resumable IDs come from thread.started events (legacy format).
				// The resume logic in group-chat-router.ts checks for this prefix and skips resume.
				const displaySessionId = `codex-0-${Date.now()}`;
				return { type: 'init', sessionId: displaySessionId, raw };
			}

			case 'agent_reasoning_section_break':
				return { type: 'system', raw };

			case 'agent_reasoning':
				// Reasoning shows model's thinking process — emit as partial text
				return {
					type: 'text',
					text: this.formatReasoningText(msg.text || ''),
					isPartial: true,
					raw,
				};

			case 'agent_message':
				// Final text response — the new format uses 'message' field instead of 'text'
				return {
					type: 'result',
					text: msg.message || msg.text || '',
					isPartial: false,
					raw,
				};

			case 'tool_call':
				this.lastToolName = msg.tool || null;
				return {
					type: 'tool_use',
					toolName: msg.tool,
					toolState: {
						status: 'running',
						input: msg.args,
					},
					raw,
				};

			case 'tool_result': {
				const toolName = this.lastToolName || undefined;
				this.lastToolName = null;
				return {
					type: 'tool_use',
					toolName,
					toolState: {
						status: 'completed',
						output: this.decodeToolOutput(msg.output),
					},
					raw,
				};
			}

			case 'token_count': {
				// token_count with usage info serves as the turn completion signal
				const event: ParsedEvent = {
					type: 'usage',
					raw,
				};
				const usage = this.extractUsageFromTokenCount(msg);
				if (usage) {
					event.usage = usage;
				}
				return event;
			}

			case 'error':
			case 'turn.failed':
				return {
					type: 'error',
					text: extractErrorText(msg.error, msg.text || 'Unknown error'),
					raw,
				};

			default:
				return { type: 'system', raw };
		}
	}

	/**
	 * Transform an item.completed event based on item type
	 */
	private transformItemCompleted(item: CodexItem, msg: CodexRawMessage): ParsedEvent {
		switch (item.type) {
			case 'reasoning':
				// Reasoning shows model's thinking process
				// Emit as text but mark it as partial/streaming
				// Format reasoning text: add line breaks before ** SECTION ** markers
				// Codex uses this pattern to separate thinking stages
				return {
					type: 'text',
					text: this.formatReasoningText(item.text || ''),
					isPartial: true,
					raw: msg,
				};

			case 'agent_message':
				// Final text response from agent - mark as 'result' so it gets emitted
				// This is the actual response text (not reasoning or tool output)
				return {
					type: 'result',
					text: item.text || '',
					isPartial: false,
					raw: msg,
				};

			case 'tool_call':
				// Agent is using a tool — store tool name for the subsequent tool_result
				this.lastToolName = item.tool || null;
				return {
					type: 'tool_use',
					toolName: item.tool,
					toolState: {
						status: 'running',
						input: item.args,
					},
					raw: msg,
				};

			case 'tool_result': {
				// Tool execution completed — carry over tool name from preceding tool_call
				const toolName = this.lastToolName || undefined;
				this.lastToolName = null;
				return {
					type: 'tool_use',
					toolName,
					toolState: {
						status: 'completed',
						output: this.decodeToolOutput(item.output),
					},
					raw: msg,
				};
			}

			case 'error':
				// Error items from Codex (e.g., account warnings, sandbox violations)
				// Surface as error events so they can be displayed in group chat UI
				return {
					type: 'error',
					text: item.message || item.text || 'Unknown item error',
					raw: msg,
				};

			default:
				// Unknown item type - preserve as system event
				return {
					type: 'system',
					raw: msg,
				};
		}
	}

	/**
	 * Format reasoning text by adding line breaks before **section** markers
	 * Codex uses patterns like **Thinking**, **Planning**, **Executing** etc.
	 * to separate different stages of its thinking process
	 */
	private formatReasoningText(text: string): string {
		if (!text) {
			return text;
		}
		// Match patterns like **some description** (bold markdown sections)
		// Add a blank line before each section marker for better readability
		return text.replace(/(\*\*[^*]+\*\*)/g, '\n\n$1');
	}

	// Maximum length for tool output to prevent oversized log entries
	private static readonly MAX_TOOL_OUTPUT_LENGTH = 10000;

	/**
	 * Decode tool output which may be a string or byte array
	 * Codex sometimes returns command output as byte arrays
	 * Large outputs are truncated to MAX_TOOL_OUTPUT_LENGTH
	 */
	private decodeToolOutput(output: string | number[] | undefined): string {
		let decoded: string;

		if (output === undefined) {
			return '';
		} else if (typeof output === 'string') {
			decoded = output;
		} else if (Array.isArray(output)) {
			// Byte array - decode to string
			// Note: Using Buffer.from instead of String.fromCharCode(...output) to avoid
			// stack overflow on large arrays (spread operator has argument limit ~10K)
			try {
				decoded = Buffer.from(output).toString('utf-8');
			} catch (err) {
				captureException(err, {
					operation: 'codexParser:decodeToolOutput',
					outputType: typeof output,
					outputLength: output.length,
				});
				decoded = output.toString();
			}
		} else {
			decoded = String(output);
		}

		if (decoded.length > CodexOutputParser.MAX_TOOL_OUTPUT_LENGTH) {
			const originalLength = decoded.length;
			decoded =
				decoded.substring(0, CodexOutputParser.MAX_TOOL_OUTPUT_LENGTH) +
				`\n... [output truncated, ${originalLength} chars total]`;
		}

		return decoded;
	}

	/**
	 * Extract usage statistics from raw Codex message
	 * Codex usage structure: { input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens }
	 * Cost is calculated from token counts using model-specific pricing.
	 */
	private extractUsageFromRaw(msg: CodexRawMessage): ParsedEvent['usage'] | null {
		if (!msg.usage) {
			return null;
		}

		const usage = msg.usage;

		const inputTokens = usage.input_tokens || 0;
		const outputTokens = usage.output_tokens || 0;
		const cachedInputTokens = usage.cached_input_tokens || 0;
		const reasoningOutputTokens = usage.reasoning_output_tokens || 0;

		// Total output tokens = output_tokens + reasoning_output_tokens
		const totalOutputTokens = outputTokens + reasoningOutputTokens;

		return {
			inputTokens,
			outputTokens: totalOutputTokens,
			// Note: For OpenAI/Codex, cached_input_tokens is a SUBSET of input_tokens (already included)
			// Unlike Claude where cache tokens are separate and need to be added to get total context.
			// We still report cacheReadTokens for display purposes (shows cache efficiency).
			// Context calculations should use inputTokens + outputTokens, not add cache tokens again.
			cacheReadTokens: cachedInputTokens,
			// Note: Codex doesn't report cache creation tokens
			cacheCreationTokens: 0,
			// Cost calculated from token counts using model-specific pricing
			costUsd: calculateCost(this.pricing, inputTokens, totalOutputTokens, cachedInputTokens),
			// Context window from Codex config (~/.codex/config.toml) or model lookup table
			contextWindow: this.contextWindow,
			// Store reasoning tokens separately for UI display
			reasoningTokens: reasoningOutputTokens,
		};
	}

	/**
	 * Extract usage stats from new format token_count events.
	 * New format: { type: 'token_count', info: { total_token_usage: {...}, last_token_usage: {...} } }
	 */
	private extractUsageFromTokenCount(msg: CodexNewMsg): ParsedEvent['usage'] | null {
		if (!msg.info) {
			return null;
		}

		// Use last_token_usage for per-turn deltas, fall back to total_token_usage
		const tokenUsage = msg.info.last_token_usage || msg.info.total_token_usage;
		if (!tokenUsage) {
			return null;
		}

		const inputTokens = tokenUsage.input_tokens || 0;
		const outputTokens = tokenUsage.output_tokens || 0;
		const cachedInputTokens = tokenUsage.cached_input_tokens || 0;
		const reasoningOutputTokens = tokenUsage.reasoning_output_tokens || 0;
		const totalOutputTokens = outputTokens + reasoningOutputTokens;

		// Update context window if provided in token_count
		if (msg.info.model_context_window) {
			this.contextWindow = msg.info.model_context_window;
		}

		return {
			inputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: cachedInputTokens,
			cacheCreationTokens: 0,
			costUsd: calculateCost(this.pricing, inputTokens, totalOutputTokens, cachedInputTokens),
			contextWindow: this.contextWindow,
			reasoningTokens: reasoningOutputTokens,
		};
	}

	/**
	 * Check if an event is a final result message
	 * For Codex, agent_message items contain the actual response text
	 * We check for 'result' type which agent_message events are now marked as
	 */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result' && !!event.text;
	}

	/**
	 * Extract session ID from an event
	 * Codex uses thread_id for session continuity
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
	 * NOTE: Codex does not support slash commands
	 */
	extractSlashCommands(_event: ParsedEvent): string[] | null {
		// Codex doesn't have discoverable slash commands
		return null;
	}

	/**
	 * Detect an error from a line of agent output
	 *
	 * IMPORTANT: Only detect errors from structured JSON error events, not from
	 * arbitrary text content. Pattern matching on conversational text leads to
	 * false positives (e.g., AI discussing "timeout" triggers timeout error).
	 *
	 * Error detection sources (in order of reliability):
	 * 1. Structured JSON: { type: "error", error: "..." } or { error: "..." }
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

			// Check legacy format: { type: 'error', error: '...' } or { type: 'turn.failed', ... }
			if (parsed.type === 'error' || parsed.type === 'turn.failed' || parsed.error) {
				parsedJson = parsed;
				errorText = extractErrorText(parsed.error);
				if (errorText === 'Unknown error') errorText = null; // No useful info to match
			}

			// Check new wrapped format: { id: 'N', msg: { type: 'error', ... } }
			if (!errorText && parsed.msg && typeof parsed.msg === 'object') {
				const msg = parsed.msg;
				if (msg.type === 'error' || msg.type === 'turn.failed' || msg.error) {
					parsedJson = parsed;
					errorText = extractErrorText(msg.error || msg.text, 'Unknown error');
					if (errorText === 'Unknown error') errorText = null;
				}
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

		// Structured error event that didn't match a known pattern —
		// still report it rather than silently dropping
		if (parsedJson) {
			return {
				type: 'unknown',
				message: errorText,
				recoverable: true,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: { errorLine: line },
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
