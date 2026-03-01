/**
 * Codex CLI Output Parser
 *
 * Parses JSON output from OpenAI Codex CLI (`codex exec --json`).
 *
 * Supports TWO output formats:
 *
 * OLD format (item-envelope, Codex CLI ≤ v0.x legacy):
 *   { type: 'thread.started', thread_id: '...' }
 *   { type: 'turn.started' }
 *   { type: 'item.completed', item: { type: 'reasoning' | 'agent_message' | 'tool_call' | 'tool_result', ... } }
 *   { type: 'turn.completed', usage: { input_tokens, output_tokens, ... } }
 *
 * NEW format (msg-envelope, Codex CLI v0.41.0+):
 *   { id: '0', msg: { type: 'task_started', model_context_window: N } }
 *   { id: '0', msg: { type: 'agent_reasoning', text: '...' } }
 *   { id: '0', msg: { type: 'agent_message', message: '...' } }
 *   { id: '0', msg: { type: 'exec_command_begin', call_id, command, cwd } }
 *   { id: '0', msg: { type: 'exec_command_end', call_id, stdout, exit_code } }
 *   { id: '0', msg: { type: 'token_count', info: { total_token_usage, model_context_window } } }
 *   Plus non-envelope lines: { model: '...', sandbox: '...' } and { prompt: '...' }
 *
 * @see https://github.com/openai/codex
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { captureException } from '../utils/sentry';
import { logger } from '../utils/logger';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

// ─── OLD FORMAT INTERFACES ──────────────────────────────────────────

/**
 * Raw message structure from old Codex JSON output (item-envelope format)
 */
interface CodexOldMessage {
	type?:
		| 'thread.started'
		| 'turn.started'
		| 'item.completed'
		| 'turn.completed'
		| 'turn.failed'
		| 'error';
	thread_id?: string;
	item?: CodexItem;
	usage?: CodexOldUsage;
	error?: string | { message?: string; type?: string };
}

interface CodexItem {
	id?: string;
	type?: 'reasoning' | 'agent_message' | 'tool_call' | 'tool_result';
	text?: string;
	tool?: string;
	args?: Record<string, unknown>;
	output?: string | number[];
}

interface CodexOldUsage {
	input_tokens?: number;
	output_tokens?: number;
	cached_input_tokens?: number;
	reasoning_output_tokens?: number;
}

// ─── NEW FORMAT INTERFACES ──────────────────────────────────────────

/**
 * New format envelope: { id: string, msg: { type: string, ... } }
 */
interface CodexNewEnvelope {
	id: string;
	msg: CodexNewMsg;
}

type CodexNewMsg =
	| CodexNewTaskStarted
	| CodexNewAgentReasoning
	| CodexNewReasoningSectionBreak
	| CodexNewAgentMessage
	| CodexNewExecCommandBegin
	| CodexNewExecCommandOutputDelta
	| CodexNewExecCommandEnd
	| CodexNewTokenCount
	| CodexNewGenericMsg;

interface CodexNewTaskStarted {
	type: 'task_started';
	model_context_window?: number;
}

interface CodexNewAgentReasoning {
	type: 'agent_reasoning';
	text?: string;
}

interface CodexNewReasoningSectionBreak {
	type: 'agent_reasoning_section_break';
}

interface CodexNewAgentMessage {
	type: 'agent_message';
	message?: string;
}

interface CodexNewExecCommandBegin {
	type: 'exec_command_begin';
	call_id?: string;
	command?: string[];
	parsed_cmd?: Array<{ cmd?: string; args?: string[] }>;
	cwd?: string;
}

interface CodexNewExecCommandOutputDelta {
	type: 'exec_command_output_delta';
	call_id?: string;
	stream?: string; // 'stdout' | 'stderr'
	chunk?: string; // base64-encoded
}

interface CodexNewExecCommandEnd {
	type: 'exec_command_end';
	call_id?: string;
	stdout?: string;
	stderr?: string;
	aggregated_output?: string;
	exit_code?: number;
	duration?: number;
	formatted_output?: string;
}

interface CodexNewTokenCount {
	type: 'token_count';
	info?: {
		total_token_usage?: {
			input_tokens?: number;
			cached_input_tokens?: number;
			output_tokens?: number;
			reasoning_output_tokens?: number;
			total_tokens?: number;
		};
		last_token_usage?: {
			input_tokens?: number;
			cached_input_tokens?: number;
			output_tokens?: number;
			reasoning_output_tokens?: number;
			total_tokens?: number;
		};
		model_context_window?: number;
	};
	rate_limits?: unknown;
}

interface CodexNewGenericMsg {
	type: string;
	[key: string]: unknown;
}

/**
 * Non-envelope config line: { model: '...', sandbox: '...' }
 */
interface CodexConfigLine {
	model?: string;
	sandbox?: string;
	[key: string]: unknown;
}

// ─── PARSER IMPLEMENTATION ──────────────────────────────────────────

/**
 * Extract a human-readable error message from Codex's polymorphic error field.
 * Codex sends errors as either a plain string or { message?, type? } object.
 */
function extractErrorText(error: CodexOldMessage['error'], fallback = 'Unknown error'): string {
	if (typeof error === 'object' && error?.message) return error.message;
	if (typeof error === 'string') return error;
	return fallback;
}

/**
 * Codex CLI Output Parser Implementation
 *
 * Transforms Codex's JSON format into normalized ParsedEvents.
 * Supports both old (item-envelope) and new (msg-envelope) formats.
 */
export class CodexOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'codex';

	// Cached context window - read once from config
	private contextWindow: number;
	private model: string;

	// OLD FORMAT: Track tool name from tool_call to carry over to tool_result
	// (Codex old format emits tool_call and tool_result as separate item.completed events,
	// but tool_result doesn't include the tool name)
	private lastToolName: string | null = null;

	// NEW FORMAT: Track tool names by call_id for exec_command_begin → exec_command_end carryover
	private toolNamesByCallId: Map<string, string> = new Map();

	constructor() {
		// Read config at initialization.
		// NOTE: This parser is a SINGLETON (registered once via initializeOutputParsers).
		// Call refreshConfig() before each spawn to pick up config changes.
		const config = readCodexConfig();
		this.model = config.model || 'gpt-5.2-codex-max';

		// Priority: 1) explicit model_context_window in config, 2) lookup by model name
		this.contextWindow = config.contextWindow || getModelContextWindow(this.model);
	}

	/**
	 * Re-read ~/.codex/config.toml to pick up model/context window changes.
	 * Must be called before each process spawn since this parser is a singleton.
	 */
	refreshConfig(): void {
		const config = readCodexConfig();
		this.model = config.model || 'gpt-5.2-codex-max';
		this.contextWindow = config.contextWindow || getModelContextWindow(this.model);
		// Reset stateful fields so they don't leak across sessions (parser is a singleton)
		this.lastToolName = null;
		this.toolNamesByCallId.clear();
	}

	/**
	 * Parse a single JSON line from Codex output.
	 *
	 * Detects the format automatically:
	 * - If parsed object has `msg` field → new format (msg-envelope)
	 * - If parsed object has `type` field → old format (item-envelope)
	 * - If parsed object has `model` or `prompt` → config/prompt echo line (new format only)
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const parsed = JSON.parse(line);
			return this.routeMessage(parsed);
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
	 * Route a parsed JSON object to the appropriate format handler
	 */
	private routeMessage(parsed: Record<string, unknown>): ParsedEvent {
		// New format detection: presence of `msg` field with `type` inside
		if (
			parsed.msg &&
			typeof parsed.msg === 'object' &&
			(parsed.msg as Record<string, unknown>).type
		) {
			return this.transformNewFormat(parsed as unknown as CodexNewEnvelope);
		}

		// Old format detection: top-level `type` field or standalone `error` field
		if (typeof parsed.type === 'string' || typeof parsed.error === 'string') {
			return this.transformOldFormat(parsed as unknown as CodexOldMessage);
		}

		// Non-envelope lines (new format only): config echo or prompt echo
		if (parsed.model || parsed.prompt !== undefined) {
			return this.transformConfigLine(parsed as CodexConfigLine);
		}

		// Unknown structure - preserve as system event
		return {
			type: 'system',
			raw: parsed,
		};
	}

	// ─── NEW FORMAT HANDLERS ──────────────────────────────────────

	/**
	 * Transform a new-format msg-envelope event into a normalized ParsedEvent
	 */
	private transformNewFormat(envelope: CodexNewEnvelope): ParsedEvent {
		const msg = envelope.msg;

		switch (msg.type) {
			case 'task_started':
				// Update context window if provided by the agent
				if ((msg as CodexNewTaskStarted).model_context_window) {
					this.contextWindow = (msg as CodexNewTaskStarted).model_context_window!;
				}
				// Emit as system event with raw.type = 'turn.started' so StdoutHandler's
				// reset check at line 319 recognizes it as a turn boundary
				return {
					type: 'system',
					raw: { type: 'turn.started', _originalType: 'task_started' },
				};

			case 'agent_reasoning':
				return {
					type: 'text',
					text: this.formatReasoningText((msg as CodexNewAgentReasoning).text || ''),
					isPartial: true,
					raw: envelope,
				};

			case 'agent_reasoning_section_break':
				// Section break between reasoning blocks — emit as a newline in reasoning
				return {
					type: 'text',
					text: '\n\n',
					isPartial: true,
					raw: envelope,
				};

			case 'agent_message':
				// Final text response — note: new format uses `message` not `text`
				return {
					type: 'result',
					text: (msg as CodexNewAgentMessage).message || '',
					isPartial: false,
					raw: envelope,
				};

			case 'exec_command_begin':
				return this.transformExecCommandBegin(msg as CodexNewExecCommandBegin, envelope);

			case 'exec_command_end':
				return this.transformExecCommandEnd(msg as CodexNewExecCommandEnd, envelope);

			case 'exec_command_output_delta':
				// Streaming output chunk — ignore, final output comes in exec_command_end
				return {
					type: 'system',
					raw: envelope,
				};

			case 'token_count':
				return this.transformTokenCount(msg as CodexNewTokenCount, envelope);

			default:
				return {
					type: 'system',
					raw: envelope,
				};
		}
	}

	/**
	 * Transform exec_command_begin → tool_use (running)
	 */
	private transformExecCommandBegin(
		msg: CodexNewExecCommandBegin,
		envelope: CodexNewEnvelope
	): ParsedEvent {
		// Extract tool name from command array or parsed_cmd
		let toolName: string | undefined;
		if (msg.command && msg.command.length > 0) {
			toolName = msg.command[0];
		} else if (msg.parsed_cmd && msg.parsed_cmd.length > 0 && msg.parsed_cmd[0].cmd) {
			toolName = msg.parsed_cmd[0].cmd;
		}

		// Store tool name by call_id for carryover to exec_command_end
		if (msg.call_id && toolName) {
			this.toolNamesByCallId.set(msg.call_id, toolName);
		}

		return {
			type: 'tool_use',
			toolName,
			toolState: {
				status: 'running',
				input: {
					command: msg.command,
					cwd: msg.cwd,
				},
			},
			raw: envelope,
		};
	}

	/**
	 * Transform exec_command_end → tool_use (completed)
	 */
	private transformExecCommandEnd(
		msg: CodexNewExecCommandEnd,
		envelope: CodexNewEnvelope
	): ParsedEvent {
		// Retrieve and clean up tool name by call_id
		let toolName: string | undefined;
		if (msg.call_id) {
			toolName = this.toolNamesByCallId.get(msg.call_id);
			this.toolNamesByCallId.delete(msg.call_id);
		}

		// Use aggregated_output, stdout, stderr, or formatted_output, with truncation
		const rawOutput =
			msg.aggregated_output || msg.stdout || msg.stderr || msg.formatted_output || '';
		const output = this.truncateToolOutput(rawOutput);

		return {
			type: 'tool_use',
			toolName,
			toolState: {
				status: 'completed',
				output,
				exitCode: msg.exit_code,
			},
			raw: envelope,
		};
	}

	/**
	 * Transform token_count → usage event
	 */
	private transformTokenCount(msg: CodexNewTokenCount, envelope: CodexNewEnvelope): ParsedEvent {
		// token_count events without info are rate-limit-only — skip usage extraction
		if (!msg.info?.total_token_usage) {
			return {
				type: 'usage',
				raw: envelope,
			};
		}

		const total = msg.info.total_token_usage;
		const inputTokens = total.input_tokens || 0;
		const outputTokens = total.output_tokens || 0;
		const cachedInputTokens = total.cached_input_tokens || 0;
		const reasoningOutputTokens = total.reasoning_output_tokens || 0;
		const totalOutputTokens = outputTokens + reasoningOutputTokens;

		// Update context window if provided
		if (msg.info.model_context_window) {
			this.contextWindow = msg.info.model_context_window;
		}

		return {
			type: 'usage',
			usage: {
				inputTokens,
				outputTokens: totalOutputTokens,
				cacheReadTokens: cachedInputTokens,
				cacheCreationTokens: 0,
				contextWindow: this.contextWindow,
				reasoningTokens: reasoningOutputTokens,
			},
			raw: envelope,
		};
	}

	/**
	 * Transform a non-envelope config/prompt echo line
	 */
	private transformConfigLine(parsed: CodexConfigLine): ParsedEvent {
		// If the config line tells us the model, update our context window
		if (parsed.model && typeof parsed.model === 'string') {
			this.model = parsed.model;
			this.contextWindow = getModelContextWindow(this.model);
		}
		return {
			type: 'system',
			raw: parsed,
		};
	}

	// ─── OLD FORMAT HANDLERS ──────────────────────────────────────

	/**
	 * Transform an old-format (item-envelope) message into a normalized ParsedEvent
	 */
	private transformOldFormat(msg: CodexOldMessage): ParsedEvent {
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
		if (msg.type === 'turn.completed') {
			const event: ParsedEvent = {
				type: 'usage',
				raw: msg,
			};

			const usage = this.extractOldFormatUsage(msg);
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
	 * Transform an old-format item.completed event based on item type
	 */
	private transformItemCompleted(item: CodexItem, msg: CodexOldMessage): ParsedEvent {
		switch (item.type) {
			case 'reasoning':
				return {
					type: 'text',
					text: this.formatReasoningText(item.text || ''),
					isPartial: true,
					raw: msg,
				};

			case 'agent_message':
				return {
					type: 'result',
					text: item.text || '',
					isPartial: false,
					raw: msg,
				};

			case 'tool_call':
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

			default:
				return {
					type: 'system',
					raw: msg,
				};
		}
	}

	// ─── SHARED UTILITIES ───────────────────────────────────────────

	/**
	 * Format reasoning text by adding line breaks before **section** markers
	 */
	private formatReasoningText(text: string): string {
		if (!text) {
			return text;
		}
		return text.replace(/(\*\*[^*]+\*\*)/g, '\n\n$1');
	}

	/** Maximum character length for tool output before truncation */
	private static readonly MAX_TOOL_OUTPUT_LENGTH = 10000;

	/**
	 * Truncate tool output if it exceeds the limit
	 */
	private truncateToolOutput(output: string): string {
		if (output.length > CodexOutputParser.MAX_TOOL_OUTPUT_LENGTH) {
			const originalLength = output.length;
			logger.warn(
				`Tool output truncated: ${originalLength} chars → ${CodexOutputParser.MAX_TOOL_OUTPUT_LENGTH} chars`,
				'CodexOutputParser'
			);
			return (
				output.substring(0, CodexOutputParser.MAX_TOOL_OUTPUT_LENGTH) +
				`\n... [output truncated, ${originalLength} chars total]`
			);
		}
		return output;
	}

	/**
	 * Decode tool output which may be a string or byte array (old format only)
	 */
	private decodeToolOutput(output: string | number[] | undefined): string {
		let decoded: string;

		if (output === undefined) {
			return '';
		}

		if (typeof output === 'string') {
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

		return this.truncateToolOutput(decoded);
	}

	/**
	 * Extract usage statistics from old-format turn.completed message
	 */
	private extractOldFormatUsage(msg: CodexOldMessage): ParsedEvent['usage'] | null {
		if (!msg.usage) {
			return null;
		}

		const usage = msg.usage;
		const inputTokens = usage.input_tokens || 0;
		const outputTokens = usage.output_tokens || 0;
		const cachedInputTokens = usage.cached_input_tokens || 0;
		const reasoningOutputTokens = usage.reasoning_output_tokens || 0;
		const totalOutputTokens = outputTokens + reasoningOutputTokens;

		return {
			inputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: cachedInputTokens,
			cacheCreationTokens: 0,
			contextWindow: this.contextWindow,
			reasoningTokens: reasoningOutputTokens,
		};
	}

	/**
	 * Check if an event is a final result message.
	 * For both formats, agent_message items produce type: 'result' with text.
	 */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result' && !!event.text;
	}

	/**
	 * Extract session ID from an event.
	 * Old format uses thread_id; new format doesn't provide a session ID.
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
		return null;
	}

	/**
	 * Detect an error from a line of agent output.
	 *
	 * Only detect errors from structured JSON error events, not from
	 * arbitrary text content.
	 */
	detectErrorFromLine(line: string): AgentError | null {
		if (!line.trim()) {
			return null;
		}

		let errorText: string | null = null;
		let parsedJson: unknown = null;
		try {
			const parsed = JSON.parse(line);
			// Check for error type messages
			// Codex uses type: 'error' for some errors and type: 'turn.failed' for others
			if (parsed.type === 'error' || parsed.type === 'turn.failed' || parsed.error) {
				parsedJson = parsed;
				errorText = extractErrorText(parsed.error);
				if (errorText === 'Unknown error') errorText = null; // No useful info to match
			}
			// New format: check inside msg envelope
			if (!errorText && parsed.msg && typeof parsed.msg === 'object') {
				const msg = parsed.msg as Record<string, unknown>;
				if (msg.type === 'error' && msg.error) {
					errorText = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
				}
			}
		} catch {
			// Not JSON - skip pattern matching entirely
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
				raw: {
					exitCode,
					stderr,
					stdout,
				},
			};
		}

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
