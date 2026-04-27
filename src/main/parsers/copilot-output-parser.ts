/**
 * GitHub Copilot CLI Output Parser
 *
 * Parses structured output from `copilot --output-format json`.
 *
 * Verified locally against Copilot CLI 1.0.5 output. The CLI emits JSON
 * events, and the live stdout stream may concatenate multiple objects in a
 * single chunk without newline separators. The events include:
 * - session.tools_updated
 * - user.message
 * - assistant.turn_start / assistant.turn_end
 * - assistant.message
 * - assistant.reasoning_delta
 * - assistant.reasoning
 * - tool.execution_start / tool.execution_complete
 * - result
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

interface CopilotToolRequest {
	toolCallId?: string;
	name?: string;
	arguments?: unknown;
}

interface CopilotToolExecutionResult {
	content?: string;
	detailedContent?: string;
}

interface CopilotRawMessage {
	type?: string;
	id?: string;
	timestamp?: string;
	sessionId?: string;
	exitCode?: number;
	data?: {
		sessionId?: string;
		content?: string;
		deltaContent?: string;
		phase?: string;
		toolRequests?: CopilotToolRequest[];
		toolCallId?: string;
		toolName?: string;
		arguments?: unknown;
		success?: boolean;
		result?: CopilotToolExecutionResult;
		error?: string;
		message?: string;
		/** Per-model token metrics emitted in session.shutdown events */
		modelMetrics?: Record<
			string,
			{
				usage?: {
					inputTokens?: number;
					outputTokens?: number;
					cacheReadTokens?: number;
					cacheWriteTokens?: number;
				};
			}
		>;
	};
	error?: string | { message?: string };
}

/** Extract non-empty text from strings or simple string arrays. */
function extractTextValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.filter((part): part is string => typeof part === 'string').join('');
	}
	return '';
}

/** Extract a human-readable error message from a string or { message } object. */
function extractErrorText(value: unknown): string | null {
	if (!value) return null;
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'object' && value !== null) {
		const message = (value as { message?: string }).message;
		if (typeof message === 'string' && message.trim()) {
			return message.trim();
		}
	}
	return null;
}

/** Extract tool output text from a Copilot tool execution result. */
function extractToolOutput(result: CopilotToolExecutionResult | undefined): string {
	if (!result) return '';
	return result.content || result.detailedContent || '';
}

/**
 * Parses GitHub Copilot CLI JSON output into normalized ParsedEvents.
 *
 * Handles concatenated JSON objects (no newline separators), tracks tool
 * names across execution_start/complete events, and detects agent errors
 * from structured error events and non-zero exit codes.
 */
export class CopilotOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'copilot-cli';

	private toolNames = new Map<string, string>();
	/** Tracks whether reasoning deltas were received in the current turn.
	 *  Used to dedupe the `assistant.reasoning` summary against its preceding
	 *  delta stream. */
	private turnHadReasoningDeltas = false;

	/** Parse a single JSON line from Copilot's JSONL output stream. */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			return this.parseJsonObject(JSON.parse(line));
		} catch {
			return {
				type: 'text',
				text: line,
				raw: line,
			};
		}
	}

	/** Parse an already-deserialized JSON object into a normalized ParsedEvent. */
	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as CopilotRawMessage;

		switch (msg.type) {
			case 'assistant.message':
				return this.parseAssistantMessage(msg);
			case 'assistant.message_delta':
				return this.parseAssistantMessageDelta(msg);
			case 'assistant.reasoning_delta':
			case 'assistant.reasoning':
				return this.parseAssistantReasoning(msg);
			case 'assistant.turn_start':
				this.turnHadReasoningDeltas = false;
				return {
					type: 'system',
					raw: msg,
				};
			case 'assistant.turn_end':
			case 'session.tools_updated':
			case 'user.message':
				return {
					type: 'system',
					raw: msg,
				};
			case 'session.start':
				return {
					type: 'init',
					sessionId: msg.data?.sessionId,
					raw: msg,
				};
			case 'session.shutdown':
				return this.parseSessionShutdown(msg);
			case 'tool.execution_start':
				return this.parseToolExecutionStart(msg);
			case 'tool.execution_complete':
				return this.parseToolExecutionComplete(msg);
			case 'result':
				return {
					type: 'result',
					sessionId: msg.sessionId,
					raw: msg,
				};
			case 'error':
				return {
					type: 'error',
					text:
						extractErrorText(msg.error || msg.data?.error || msg.data?.message) || 'Unknown error',
					raw: msg,
				};
			default:
				return {
					type: 'system',
					raw: msg,
				};
		}
	}

	/** Parse assistant.message events.
	 *
	 *  Shape of the three assistant.message variants we see in practice:
	 *   1. Intermediate turn:  content = "" + toolRequests present         → emit tools
	 *   2. Final turn:         content = "<full answer>" + no toolRequests → emit result
	 *   3. Legacy/edge:        phase = 'final_answer'                      → emit result
	 *
	 *  Modern Copilot CLI does not emit the `phase` field, so we recognize
	 *  the final answer structurally: non-empty content with no tool
	 *  requests. Emitting as `type: 'result'` with the full message content
	 *  guarantees StdoutHandler has the authoritative final text even when
	 *  the accumulated delta stream is incomplete or lagging. */
	private parseAssistantMessage(msg: CopilotRawMessage): ParsedEvent {
		const content = msg.data?.content || '';
		const phase = msg.data?.phase;
		const toolRequests = msg.data?.toolRequests || [];

		const toolUseBlocks = toolRequests
			.filter(
				(tool): tool is Required<Pick<CopilotToolRequest, 'name'>> & CopilotToolRequest =>
					!!tool.name
			)
			.map((tool) => {
				if (tool.toolCallId && tool.name) {
					this.toolNames.set(tool.toolCallId, tool.name);
				}
				return {
					name: tool.name,
					id: tool.toolCallId,
					input: tool.arguments,
				};
			});

		// Final answer: either the explicit phase (legacy) OR the structural
		// pattern used by modern Copilot CLI (no phase field, non-empty
		// content, no pending tool calls). Phase values like 'commentary'
		// opt out — they mark the message as an intermediate narration.
		const isFinalAnswer =
			phase === 'final_answer' || (phase === undefined && !!content && toolUseBlocks.length === 0);

		if (isFinalAnswer) {
			return {
				type: 'result',
				text: content,
				toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
				raw: msg,
			};
		}

		// Intermediate turn with tool calls — forward the tool blocks. The
		// accompanying text (if any) was already streamed via deltas and will
		// be finalized when the session-ending assistant.message arrives.
		if (toolUseBlocks.length > 0) {
			return {
				type: 'text',
				text: '',
				toolUseBlocks,
				raw: msg,
			};
		}

		// Empty content, no tools — pure signal event, nothing to render.
		return {
			type: 'system',
			raw: msg,
		};
	}

	/** Parse assistant.message_delta events as partial streaming text. */
	private parseAssistantMessageDelta(msg: CopilotRawMessage): ParsedEvent | null {
		const deltaContent = msg.data?.deltaContent || '';
		if (!deltaContent) {
			return null;
		}

		return {
			type: 'text',
			text: deltaContent,
			isPartial: true,
			raw: msg,
		};
	}

	/** Parse assistant.reasoning and assistant.reasoning_delta events.
	 *  Deltas are forwarded as partial text with isReasoning=true so
	 *  StdoutHandler can display them in thinking UI without accumulating
	 *  them into the final response. The summary (assistant.reasoning)
	 *  repeats content already streamed via deltas — when deltas were received,
	 *  the summary is skipped to avoid double-accumulation. */
	private parseAssistantReasoning(msg: CopilotRawMessage): ParsedEvent | null {
		const deltaContent = extractTextValue(msg.data?.deltaContent);

		if (deltaContent) {
			this.turnHadReasoningDeltas = true;
			return {
				type: 'text',
				text: deltaContent,
				isPartial: true,
				isReasoning: true,
				raw: msg,
			};
		}

		// Summary event (assistant.reasoning with content only, no deltaContent).
		// Skip if deltas already delivered this content.
		if (this.turnHadReasoningDeltas) {
			return null;
		}

		// No deltas preceded — use the content directly
		const content = extractTextValue(msg.data?.content);
		if (content) {
			return {
				type: 'text',
				text: content,
				isPartial: true,
				isReasoning: true,
				raw: msg,
			};
		}

		return null;
	}

	/** Parse tool.execution_start and register the tool name for later correlation. */
	private parseToolExecutionStart(msg: CopilotRawMessage): ParsedEvent {
		const callId = msg.data?.toolCallId;
		const toolName = msg.data?.toolName;
		if (callId && toolName) {
			this.toolNames.set(callId, toolName);
		}

		return {
			type: 'tool_use',
			toolName,
			toolCallId: callId,
			toolState: {
				status: 'running',
				input: msg.data?.arguments,
			},
			raw: msg,
		};
	}

	/** Parse tool.execution_complete, resolving tool name from the tracked map. */
	private parseToolExecutionComplete(msg: CopilotRawMessage): ParsedEvent {
		const callId = msg.data?.toolCallId;
		const toolName = (callId && this.toolNames.get(callId)) || msg.data?.toolName || undefined;
		const success = msg.data?.success !== false;
		const toolOutput = extractToolOutput(msg.data?.result);
		const errorOutput = extractErrorText(msg.data?.error);

		if (callId) {
			this.toolNames.delete(callId);
		}

		return {
			type: 'tool_use',
			toolName,
			toolCallId: callId,
			toolState: {
				status: success ? 'completed' : 'failed',
				output: toolOutput || (!success ? errorOutput || '' : ''),
			},
			raw: msg,
		};
	}

	/** Parse session.shutdown events, extracting aggregate token usage from modelMetrics. */
	private parseSessionShutdown(msg: CopilotRawMessage): ParsedEvent {
		const modelMetrics = msg.data?.modelMetrics;
		if (!modelMetrics) {
			return { type: 'system', raw: msg };
		}

		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheCreationTokens = 0;

		for (const metric of Object.values(modelMetrics)) {
			inputTokens += metric.usage?.inputTokens || 0;
			outputTokens += metric.usage?.outputTokens || 0;
			cacheReadTokens += metric.usage?.cacheReadTokens || 0;
			cacheCreationTokens += metric.usage?.cacheWriteTokens || 0;
		}

		if (inputTokens === 0 && outputTokens === 0) {
			return { type: 'system', raw: msg };
		}

		return {
			type: 'usage',
			usage: {
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreationTokens,
			},
			raw: msg,
		};
	}

	/** Check whether a parsed event represents a completed agent response. */
	isResultMessage(event: ParsedEvent): boolean {
		if (event.type !== 'result') return false;

		// Treat any final_answer event as a result, including empty ones (tool-only responses)
		const raw = event.raw as CopilotRawMessage | undefined;
		if (raw?.data?.phase === 'final_answer') return true;

		// The session-end "result" event from Copilot has no text but signals completion.
		// Recognizing it sets resultEmitted, preventing the ExitHandler from re-emitting
		// content that was already streamed via thinking-chunk events.
		if (raw?.type === 'result') return true;

		return !!event.text || !!event.toolUseBlocks?.length;
	}

	/** Extract the Copilot session ID from a parsed event, if present. */
	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) return event.sessionId;

		const raw = event.raw as CopilotRawMessage | undefined;
		return raw?.sessionId || raw?.data?.sessionId || null;
	}

	/** Extract usage/token statistics from a parsed event. */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	/** Extract slash commands from events. Returns null — Copilot slash commands are interactive-only. */
	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

	/** Detect agent errors from a raw JSON line string. */
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
			return null;
		}
	}

	/** Detect agent errors from an already-parsed JSON object. Skips bare exit codes to allow detectErrorFromExit to classify with full context. */
	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as CopilotRawMessage;
		if (msg.type === 'tool.execution_complete') {
			return null;
		}

		const errorText = extractErrorText(msg.error) || extractErrorText(msg.data?.error);

		// Do NOT synthesize an error for bare non-zero exit codes.
		// Returning null here lets detectErrorFromExit() run with full
		// stderr+stdout context for richer error classification.
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
				parsedJson: parsed,
			};
		}

		return {
			type: 'unknown',
			message: errorText,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			parsedJson: parsed,
		};
	}

	/** Detect agent errors from process exit code and stderr/stdout content. */
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
				raw: { exitCode, stderr, stdout },
			};
		}

		return {
			type: 'agent_crashed',
			message: `Agent exited with code ${exitCode}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}
}
