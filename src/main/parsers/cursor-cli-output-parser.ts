/**
 * Cursor CLI Output Parser
 *
 * Parses stream-json output from the Cursor Agent CLI (`agent -p ... --output-format stream-json`).
 * Verified against live CLI output. The schema closely mirrors Claude Code stream-json:
 *
 *   {"type":"system","subtype":"init","session_id":"...","model":"...","permissionMode":"..."}
 *   {"type":"user","message":{...},"session_id":"..."}
 *   {"type":"thinking","subtype":"delta","text":"...","session_id":"..."}
 *   {"type":"thinking","subtype":"completed","session_id":"..."}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"session_id":"..."}
 *   {"type":"result","subtype":"success","result":"...","session_id":"...","usage":{...}}
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/** Cap for user-facing unmatched error bodies in UI/logs. */
const MAX_ERROR_MESSAGE_CHARS = 500;

interface CursorContentBlock {
	type: string;
	text?: string;
}

interface CursorToolCallPayload {
	function?: {
		name?: unknown;
		arguments?: unknown;
	};
	toolCallId?: unknown;
	[key: string]: unknown;
}

interface CursorRawMessage {
	type: string;
	subtype?: string;
	session_id?: string;
	result?: string;
	is_error?: boolean;
	timestamp_ms?: number;
	model_call_id?: string;
	call_id?: string;
	tool_call?: CursorToolCallPayload;
	message?: {
		role?: string;
		content?: string | CursorContentBlock[];
	};
	text?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
}

/** Truncate long unmatched error bodies for UI/logs. Full text stays in raw. */
function truncateErrorText(text: string): string {
	if (text.length <= MAX_ERROR_MESSAGE_CHARS) return text;
	return `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}...`;
}

export class CursorCliOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'cursor-cli';
	private sawAssistantPartialOutput = false;

	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			return this.parseJsonObject(JSON.parse(line));
		} catch {
			return null;
		}
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as CursorRawMessage;

		if (msg.type === 'system' && msg.subtype === 'init') {
			return {
				type: 'init',
				sessionId: msg.session_id,
				raw: msg,
			};
		}

		if (msg.type === 'thinking' && msg.subtype === 'delta') {
			const text = typeof msg.text === 'string' ? msg.text : '';
			if (!text) {
				return null;
			}
			return {
				type: 'text',
				text,
				sessionId: msg.session_id,
				isPartial: true,
				isReasoning: true,
				raw: msg,
			};
		}

		if (msg.type === 'thinking') {
			return {
				type: 'system',
				sessionId: msg.session_id,
				raw: msg,
			};
		}

		if (msg.type === 'tool_call') {
			return this.parseToolCall(msg);
		}

		if (msg.type === 'result') {
			let resultText = typeof msg.result === 'string' ? msg.result : undefined;
			if (!resultText && msg.message?.content) {
				resultText = this.extractTextFromMessage(msg);
			}

			if (msg.is_error) {
				return {
					type: 'error',
					text: resultText || 'Agent reported an error',
					sessionId: msg.session_id,
					raw: msg,
				};
			}

			const event: ParsedEvent = {
				type: 'result',
				text: resultText,
				sessionId: msg.session_id,
				raw: msg,
			};

			const usage = this.extractUsageFromRaw(msg);
			if (usage) {
				event.usage = usage;
			}

			return event;
		}

		if (msg.type === 'assistant') {
			const text = this.extractTextFromMessage(msg);
			if (!text) {
				return {
					type: 'system',
					sessionId: msg.session_id,
					raw: msg,
				};
			}

			// With --stream-partial-output Cursor emits:
			// 1. timestamped text deltas (new text),
			// 2. timestamped + model_call_id buffered flushes (duplicates), and
			// 3. an untimestamped final full-message flush (duplicate).
			// Without the flag there is only the untimestamped complete message,
			// which remains useful as a fallback when a terminal result is absent.
			if (msg.model_call_id) {
				return null;
			}
			if (typeof msg.timestamp_ms === 'number') {
				this.sawAssistantPartialOutput = true;
			} else if (this.sawAssistantPartialOutput) {
				return null;
			}

			return {
				type: 'text',
				text,
				sessionId: msg.session_id,
				isPartial: true,
				raw: msg,
			};
		}

		if (msg.type === 'user') {
			return {
				type: 'system',
				sessionId: msg.session_id,
				raw: msg,
			};
		}

		if (msg.type === 'system') {
			return {
				type: 'system',
				sessionId: msg.session_id,
				raw: msg,
			};
		}

		return {
			type: 'system',
			sessionId: msg.session_id,
			raw: msg,
		};
	}

	private extractTextFromMessage(msg: CursorRawMessage): string {
		if (!msg.message?.content) {
			return '';
		}

		if (typeof msg.message.content === 'string') {
			return msg.message.content;
		}

		return msg.message.content
			.filter((block) => block.type === 'text' && block.text)
			.map((block) => block.text!)
			.join('');
	}

	private parseToolCall(msg: CursorRawMessage): ParsedEvent | null {
		const payload = msg.tool_call;
		if (!payload) return null;

		let toolName: string | undefined;
		let input: unknown;
		let result: unknown;

		if (payload.function && typeof payload.function === 'object') {
			toolName = typeof payload.function.name === 'string' ? payload.function.name : undefined;
			input = this.parseFunctionArguments(payload.function.arguments);
		} else {
			const entry = Object.entries(payload).find(
				([key, value]) => key.endsWith('ToolCall') && value !== null && typeof value === 'object'
			);
			if (entry) {
				const [key, value] = entry as [string, Record<string, unknown>];
				toolName = key.slice(0, -'ToolCall'.length);
				input = value.args;
				result = value.result;
			}
		}

		if (!toolName) return null;

		const resultRecord =
			result !== null && typeof result === 'object'
				? (result as Record<string, unknown>)
				: undefined;
		const failed = Boolean(resultRecord && ('error' in resultRecord || 'failure' in resultRecord));
		const output = resultRecord
			? (resultRecord.success ?? resultRecord.error ?? resultRecord.failure ?? result)
			: result;
		const completed = msg.subtype === 'completed';

		return {
			type: 'tool_use',
			toolName,
			toolCallId:
				typeof msg.call_id === 'string'
					? msg.call_id
					: typeof payload.toolCallId === 'string'
						? payload.toolCallId
						: undefined,
			toolState: completed
				? {
						status: failed ? 'failed' : 'completed',
						...(input !== undefined ? { input } : {}),
						...(output !== undefined ? { output } : {}),
					}
				: {
						status: 'running',
						...(input !== undefined ? { input } : {}),
					},
			sessionId: msg.session_id,
			raw: msg,
		};
	}

	private parseFunctionArguments(value: unknown): unknown {
		if (typeof value !== 'string') return value;
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}

	private extractUsageFromRaw(msg: CursorRawMessage): ParsedEvent['usage'] | null {
		const usage = msg.usage;
		if (!usage) {
			return null;
		}

		const inputTokens = usage.inputTokens ?? 0;
		const outputTokens = usage.outputTokens ?? 0;
		const cacheReadTokens = usage.cacheReadTokens ?? 0;
		const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

		if (
			inputTokens === 0 &&
			outputTokens === 0 &&
			cacheReadTokens === 0 &&
			cacheWriteTokens === 0
		) {
			return null;
		}

		return {
			inputTokens,
			outputTokens,
			cacheReadTokens: cacheReadTokens,
			cacheCreationTokens: cacheWriteTokens,
		};
	}

	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		if (typeof event.sessionId === 'string' && event.sessionId) {
			return event.sessionId;
		}

		const raw = event.raw as CursorRawMessage | undefined;
		return typeof raw?.session_id === 'string' && raw.session_id ? raw.session_id : null;
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
				error.raw = { ...(error.raw || {}), errorLine: line };
			}
			return error;
		} catch {
			return this.matchPattern(line, { errorLine: line });
		}
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as CursorRawMessage;

		if (msg.type === 'result' && msg.is_error) {
			const errorText = typeof msg.result === 'string' ? msg.result.trim() : '';
			if (!errorText) {
				return this.toAgentError('unknown', 'Agent reported an error', true, {
					parsedJson: parsed,
				});
			}
			const matched = this.matchPattern(errorText, undefined, parsed);
			return (
				matched ??
				this.toAgentError('unknown', truncateErrorText(errorText), true, { parsedJson: parsed })
			);
		}

		return null;
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) {
			return null;
		}

		const combined = `${stderr}\n${stdout}`;
		const raw = { exitCode, stderr, stdout };
		const matched = this.matchPattern(combined, raw);
		if (matched) {
			return matched;
		}

		return this.toAgentError('agent_crashed', `Agent exited with code ${exitCode}`, true, { raw });
	}

	private matchPattern(
		errorText: string,
		rawBase?: AgentError['raw'],
		parsedJson?: unknown
	): AgentError | null {
		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, errorText);
		if (!match) {
			return null;
		}

		const raw: AgentError['raw'] = {
			...(rawBase || {}),
			...(!rawBase?.errorLine && !rawBase?.stderr
				? { errorLine: truncateErrorText(errorText) }
				: {}),
		};

		return this.toAgentError(match.type, match.message, match.recoverable, {
			raw: Object.keys(raw).length > 0 ? raw : undefined,
			parsedJson,
		});
	}

	private toAgentError(
		type: AgentError['type'],
		message: string,
		recoverable: boolean,
		options: { raw?: AgentError['raw']; parsedJson?: unknown } = {}
	): AgentError {
		return {
			type,
			message,
			recoverable,
			agentId: this.agentId,
			timestamp: Date.now(),
			...(options.raw ? { raw: options.raw } : {}),
			...(options.parsedJson !== undefined ? { parsedJson: options.parsedJson } : {}),
		};
	}
}
