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
	};
	error?: string | { message?: string };
}

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

function extractToolOutput(result: CopilotToolExecutionResult | undefined): string {
	if (!result) return '';
	return result.content || result.detailedContent || '';
}

export class CopilotOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'copilot';

	private toolNames = new Map<string, string>();

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
			case 'assistant.reasoning':
			case 'assistant.turn_start':
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
			case 'tool.execution_start':
				return this.parseToolExecutionStart(msg);
			case 'tool.execution_complete':
				return this.parseToolExecutionComplete(msg);
			case 'result':
				return {
					type: 'system',
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

		if (phase === 'final_answer') {
			return {
				type: 'result',
				text: content,
				toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
				raw: msg,
			};
		}

		return {
			type: 'text',
			text: content,
			isPartial: true,
			raw: msg,
		};
	}

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

	isResultMessage(event: ParsedEvent): boolean {
		if (event.type !== 'result') return false;

		// Treat any final_answer event as a result, including empty ones (tool-only responses)
		const raw = event.raw as CopilotRawMessage | undefined;
		if (raw?.data?.phase === 'final_answer') return true;

		return !!event.text || !!event.toolUseBlocks?.length;
	}

	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) return event.sessionId;

		const raw = event.raw as CopilotRawMessage | undefined;
		return raw?.sessionId || raw?.data?.sessionId || null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

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

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as CopilotRawMessage;
		if (msg.type === 'tool.execution_complete') {
			return null;
		}

		const errorText =
			extractErrorText(msg.error) ||
			extractErrorText(msg.data?.error) ||
			extractErrorText(msg.data?.message);

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
