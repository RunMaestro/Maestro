/**
 * Parser for Oh My Pi's (`omp`) JSON event protocol (`omp -p --mode json ...`).
 *
 * Oh My Pi streams newline-delimited JSON, one event per line:
 *   - `session`            first line, `.id` is the resumable session id.
 *   - `agent_start` / `turn_start`
 *   - `message_start` / `message_end` for user and assistant turns.
 *   - `message_update`     carries streaming deltas via `assistantMessageEvent`
 *                          (`text_delta` -> answer chunk, `thinking_delta` -> reasoning).
 *   - `message_end` (assistant) carries the authoritative `usage` (tokens + cost).
 *   - `turn_end`
 *   - `agent_end`          final event; `.messages` holds the completed transcript.
 *   - `tool_execution_start|update|end` for tool lifecycle.
 *
 * Oh My Pi shares Pi's documented JSON shape but is registered as its own agent
 * with its own parser instance and error patterns.
 */

import type { AgentError, ToolType } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import { stripAnsiCodes } from '../../shared/stringUtils';

/**
 * Oh My Pi's Time-Traveling Stream Rules (TTSR) deliberately abort the in-flight
 * turn when generated output matches a rule (e.g. `ts-no-any`), inject the rule
 * reminder, and let the agent re-iterate on its own. The aborted turn carries an
 * `errorMessage` of the form `TTSR matched rule: <names>` (see
 * `#formatTtsrAbortReason` in the agent). This is an in-loop interrupt, not a
 * failure, so it must never surface as an agent error - doing so aborts Auto Run
 * and Session runs on something omp resolves by itself. Anchored to the exact
 * label the agent emits so a real error that merely mentions a rule is unaffected.
 */
const TTSR_ABORT_REASON_PATTERN = /^TTSR matched rules?:/i;

interface OmpUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number | { total?: number };
}

interface OmpContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

interface OmpMessage {
	role?: string;
	content?: string | OmpContentBlock[];
	usage?: OmpUsage;
	errorMessage?: string;
}

interface OmpMessageDelta {
	type?: string;
	delta?: string;
}

interface OmpRawEvent {
	type?: string;
	id?: string;
	sessionId?: string;
	session_id?: string;
	message?: OmpMessage;
	messages?: OmpMessage[];
	assistantMessageEvent?: OmpMessageDelta;
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

export class OmpOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'omp';

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

		const event = parsed as OmpRawEvent;
		const sessionId =
			event.sessionId || event.session_id || (event.type === 'session' ? event.id : undefined);

		if ((event.error || event.message?.errorMessage) && !event.willRetry) {
			const errorText = this.extractErrorText(event);
			// A TTSR rule match is a deliberate in-loop interrupt, not a failure:
			// fall through so the aborted `message_end` still yields its usage and
			// the agent's own re-iteration continues uninterrupted.
			if (!TTSR_ABORT_REASON_PATTERN.test(errorText.trim())) {
				return {
					type: 'error',
					text: errorText,
					sessionId,
					raw: event,
				};
			}
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
					// A TTSR rule match is a deliberate in-loop interrupt: the agent
					// re-iterates, so the aborted turn is never the run's real result.
					// Return a non-result event (like the empty-transcript case below)
					// so the stdout handler does not mark output emitted with the
					// partial aborted text and drop the self-healed result; the exit
					// fallback flushes the assembled streamed text the user already saw.
					if (TTSR_ABORT_REASON_PATTERN.test(finalMessage.errorMessage.trim())) {
						return { type: 'system', sessionId, raw: event };
					}
					return {
						type: 'error',
						text: finalMessage.errorMessage,
						sessionId,
						raw: event,
					};
				}
				if (!finalMessage) {
					// No assistant message in the final transcript (empty or missing
					// `messages`). Return a non-result event so the stdout handler does
					// not mark output as emitted with an empty string; the exit fallback
					// then flushes the assembled streamed text the user already saw.
					return { type: 'system', sessionId, raw: event };
				}
				return {
					type: 'result',
					text: this.extractMessageText(finalMessage),
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

		const event = parsed as OmpRawEvent;
		if (event.willRetry) {
			return null;
		}
		const errorText = this.extractErrorText(event);
		if (!errorText) {
			return null;
		}
		if (TTSR_ABORT_REASON_PATTERN.test(errorText.trim())) {
			// In-loop TTSR rule interrupt (see TTSR_ABORT_REASON_PATTERN), never a session error.
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

		const cleanedOutput = stripAnsiCodes(`${stderr}\n${stdout}`).trim();
		const match = matchErrorPattern(getErrorPatterns(this.agentId), cleanedOutput, {
			minLength: 0,
		});
		return {
			type: match?.type || 'agent_crashed',
			message:
				match?.message ||
				`Oh My Pi exited with code ${exitCode}${cleanedOutput ? `: ${cleanedOutput.split('\n')[0]}` : ''}`,
			recoverable: match?.recoverable ?? true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}

	private extractMessageText(message: OmpMessage): string {
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

	private findFinalAssistantMessage(messages?: OmpMessage[]): OmpMessage | undefined {
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

	private extractUsageFromMessage(message: OmpMessage): ParsedEvent['usage'] | undefined {
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

	private extractErrorText(event: OmpRawEvent): string {
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
