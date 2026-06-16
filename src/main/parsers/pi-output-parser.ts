/**
 * Parser for Pi's documented JSONL protocol (`pi --mode json -p ...`).
 *
 * @see https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md
 */

import type { AgentError, ToolType } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import { stripAllAnsiCodes } from '../utils/terminalFilter';

interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number | { total?: number };
}

interface PiContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

interface PiMessage {
	role?: string;
	content?: string | PiContentBlock[];
	usage?: PiUsage;
	errorMessage?: string;
}

interface PiMessageDelta {
	type?: string;
	delta?: string;
}

interface PiRawEvent {
	type?: string;
	id?: string;
	sessionId?: string;
	session_id?: string;
	message?: PiMessage;
	messages?: PiMessage[];
	assistantMessageEvent?: PiMessageDelta;
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

export class PiOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'pi';

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

		const event = parsed as PiRawEvent;
		const sessionId =
			event.sessionId || event.session_id || (event.type === 'session' ? event.id : undefined);

		if (event.error || event.message?.errorMessage) {
			return {
				type: 'error',
				text: this.extractErrorText(event),
				sessionId,
				raw: event,
			};
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
						usage: this.extractUsageFromMessage(event.message),
						raw: event,
					};
				}
				return { type: 'system', sessionId, raw: event };

			case 'agent_end': {
				if (event.willRetry) {
					return { type: 'system', sessionId, raw: event };
				}
				const finalMessage = this.findFinalAssistantMessage(event.messages);
				if (finalMessage?.errorMessage) {
					return {
						type: 'error',
						text: finalMessage.errorMessage,
						sessionId,
						raw: event,
					};
				}
				return {
					type: 'result',
					text: finalMessage ? this.extractMessageText(finalMessage) : '',
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
	}

	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId || null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	extractSlashCommands(event: ParsedEvent): string[] | null {
		return event.slashCommands || null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		if (!line.trim()) {
			return null;
		}

		try {
			return this.detectErrorFromParsed(JSON.parse(line));
		} catch {
			return null;
		}
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const event = parsed as PiRawEvent;
		const errorText = this.extractErrorText(event);
		if (!errorText) {
			return null;
		}

		const match = matchErrorPattern(getErrorPatterns(this.agentId), errorText, { minLength: 0 });
		return {
			type: match?.type || 'unknown',
			message: match?.message || errorText,
			recoverable: match?.recoverable ?? true,
			agentId: this.agentId,
			timestamp: Date.now(),
			parsedJson: parsed,
		};
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) {
			return null;
		}

		const cleanedOutput = stripAllAnsiCodes(`${stderr}\n${stdout}`).trim();
		const match = matchErrorPattern(getErrorPatterns(this.agentId), cleanedOutput, {
			minLength: 0,
		});
		return {
			type: match?.type || 'agent_crashed',
			message:
				match?.message ||
				`Pi exited with code ${exitCode}${cleanedOutput ? `: ${cleanedOutput.split('\n')[0]}` : ''}`,
			recoverable: match?.recoverable ?? true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}

	private extractMessageText(message: PiMessage): string {
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

	private findFinalAssistantMessage(messages?: PiMessage[]): PiMessage | undefined {
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

	private extractUsageFromMessage(message: PiMessage): ParsedEvent['usage'] | undefined {
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

	private extractErrorText(event: PiRawEvent): string {
		if (event.message?.errorMessage) {
			return event.message.errorMessage;
		}
		const finalMessage = this.findFinalAssistantMessage(event.messages);
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
}
