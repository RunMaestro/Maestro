import type { AgentError, ToolType } from '../../shared/types';
import type { ParsedEvent } from './agent-output-parser';
import { matchErrorPattern, type AgentErrorPatterns } from './error-patterns';

export interface PiProtocolUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number | { total?: number };
}

export interface PiProtocolContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

export interface PiProtocolMessage {
	role?: string;
	content?: string | PiProtocolContentBlock[];
	usage?: PiProtocolUsage;
	errorMessage?: string;
}

export interface PiProtocolMessageDelta {
	type?: string;
	delta?: string;
}

export interface PiProtocolRawEvent {
	type?: string;
	id?: string;
	sessionId?: string;
	session_id?: string;
	message?: PiProtocolMessage;
	messages?: PiProtocolMessage[];
	assistantMessageEvent?: PiProtocolMessageDelta;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	error?: unknown;
	messageText?: string;
	willRetry?: boolean;
}

export interface PiProtocolAdapter {
	readonly agentId: ToolType;
	readonly agentDisplayName: string;
	readonly errorPatterns: AgentErrorPatterns;
	readonly emitEmptyAgentEndResult: boolean;
	stripExitOutput(output: string): string;
	shouldSuppressError(event: PiProtocolRawEvent, errorText: string): boolean;
}

export interface PiProtocolCore {
	parseJsonLine(line: string): ParsedEvent | null;
	parseJsonObject(parsed: unknown): ParsedEvent | null;
	detectErrorFromLine(line: string): AgentError | null;
	detectErrorFromParsed(parsed: unknown): AgentError | null;
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null;
}

function isRawEvent(parsed: unknown): parsed is PiProtocolRawEvent {
	return Boolean(parsed) && typeof parsed === 'object';
}

function extractSessionId(event: PiProtocolRawEvent): string | undefined {
	return event.sessionId || event.session_id || (event.type === 'session' ? event.id : undefined);
}

function extractMessageText(message: PiProtocolMessage): string {
	if (typeof message.content === 'string') {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return '';
	}
	return message.content
		.filter((block) => block.type === 'text')
		.map((block) => block.text || '')
		.join('');
}

function findFinalAssistantMessage(messages?: PiProtocolMessage[]): PiProtocolMessage | undefined {
	if (!messages) {
		return undefined;
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === 'assistant') {
			return messages[index];
		}
	}
	return undefined;
}

function extractUsageFromMessage(message: PiProtocolMessage): ParsedEvent['usage'] | undefined {
	const usage = message.usage;
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: usage.input || 0,
		outputTokens: usage.output || 0,
		cacheReadTokens: usage.cacheRead || 0,
		cacheCreationTokens: usage.cacheWrite || 0,
		costUsd: typeof usage.cost === 'number' ? usage.cost : usage.cost?.total || 0,
	};
}

function extractErrorText(event: PiProtocolRawEvent): string {
	if (event.message?.errorMessage) {
		return event.message.errorMessage;
	}
	const finalMessage = findFinalAssistantMessage(event.messages);
	if (finalMessage?.errorMessage) {
		return finalMessage.errorMessage;
	}
	if (typeof event.error === 'string') {
		return event.error;
	}
	if (event.error && typeof event.error === 'object') {
		const error = event.error as Record<string, unknown>;
		if (typeof error.errorMessage === 'string') {
			return error.errorMessage;
		}
		if (typeof error.message === 'string') {
			return error.message;
		}
	}
	return event.messageText || '';
}

export function createPiProtocolCore(adapter: PiProtocolAdapter): PiProtocolCore {
	const parseJsonObject = (parsed: unknown): ParsedEvent | null => {
		if (!isRawEvent(parsed)) {
			return null;
		}

		const event = parsed;
		const sessionId = extractSessionId(event);
		const errorText = extractErrorText(event);
		if (
			(event.error || event.message?.errorMessage) &&
			!adapter.shouldSuppressError(event, errorText)
		) {
			return { type: 'error', text: errorText, sessionId, raw: event };
		}

		switch (event.type) {
			case 'session':
				return { type: 'init', sessionId, raw: event };

			case 'message_update': {
				const update = event.assistantMessageEvent;
				if (update?.type === 'text_delta') {
					return {
						type: 'text',
						text: update.delta || '',
						sessionId,
						isPartial: true,
						raw: event,
					};
				}
				if (update?.type === 'thinking_delta') {
					return {
						type: 'text',
						text: update.delta || '',
						sessionId,
						isPartial: true,
						isReasoning: true,
						raw: event,
					};
				}
				return { type: 'system', sessionId, raw: event };
			}

			case 'message_end':
				if (event.message?.role === 'assistant') {
					return {
						type: 'usage',
						sessionId,
						usage: extractUsageFromMessage(event.message),
						raw: event,
					};
				}
				return { type: 'system', sessionId, raw: event };

			case 'agent_end': {
				if (event.willRetry) {
					return { type: 'system', sessionId, raw: event };
				}
				const finalMessage = findFinalAssistantMessage(event.messages);
				if (finalMessage?.errorMessage) {
					if (adapter.shouldSuppressError(event, finalMessage.errorMessage)) {
						return { type: 'system', sessionId, raw: event };
					}
					return { type: 'error', text: finalMessage.errorMessage, sessionId, raw: event };
				}
				if (!finalMessage && !adapter.emitEmptyAgentEndResult) {
					return { type: 'system', sessionId, raw: event };
				}
				return {
					type: 'result',
					text: finalMessage ? extractMessageText(finalMessage) : '',
					sessionId,
					raw: event,
				};
			}

			case 'tool_execution_start':
				return {
					type: 'tool_use',
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					toolState: { status: 'running', input: event.args },
					sessionId,
					raw: event,
				};

			case 'tool_execution_update':
				return {
					type: 'tool_use',
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					toolState: { status: 'running', output: event.partialResult },
					sessionId,
					raw: event,
				};

			case 'tool_execution_end':
				return {
					type: 'tool_use',
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					toolState: {
						status: event.isError ? 'failed' : 'completed',
						output: event.result,
					},
					sessionId,
					raw: event,
				};

			default:
				return { type: 'system', sessionId, raw: event };
		}
	};

	return {
		parseJsonLine(line) {
			if (!line.trim()) {
				return null;
			}
			try {
				return parseJsonObject(JSON.parse(line));
			} catch {
				return { type: 'text', text: line, raw: line };
			}
		},
		parseJsonObject,
		detectErrorFromLine(line) {
			if (!line.trim()) {
				return null;
			}
			try {
				return this.detectErrorFromParsed(JSON.parse(line));
			} catch {
				return null;
			}
		},
		detectErrorFromParsed(parsed) {
			if (!isRawEvent(parsed)) {
				return null;
			}
			const errorText = extractErrorText(parsed);
			if (!errorText || adapter.shouldSuppressError(parsed, errorText)) {
				return null;
			}
			const match = matchErrorPattern(adapter.errorPatterns, errorText, { minLength: 0 });
			return {
				type: match?.type || 'unknown',
				message: match?.message || errorText,
				recoverable: match?.recoverable ?? true,
				agentId: adapter.agentId,
				timestamp: Date.now(),
				parsedJson: parsed,
			};
		},
		detectErrorFromExit(exitCode, stderr, stdout) {
			if (exitCode === 0) {
				return null;
			}
			const cleanedOutput = adapter.stripExitOutput(`${stderr}\n${stdout}`).trim();
			const match = matchErrorPattern(adapter.errorPatterns, cleanedOutput, { minLength: 0 });
			return {
				type: match?.type || 'agent_crashed',
				message:
					match?.message ||
					`${adapter.agentDisplayName} exited with code ${exitCode}${cleanedOutput ? `: ${cleanedOutput.split('\n')[0]}` : ''}`,
				recoverable: match?.recoverable ?? true,
				agentId: adapter.agentId,
				timestamp: Date.now(),
				raw: { exitCode, stderr, stdout },
			};
		},
	};
}
