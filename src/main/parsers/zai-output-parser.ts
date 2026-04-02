/**
 * Z.ai (Zhipu AI) CLI Output Parser
 *
 * Parses JSON output from Zhipu AI CLI (`zai exec --json`).
 * Z.ai outputs JSONL similar to Codex/Grok CLI with the following message types:
 *
 * - thread.started: Thread initialization (contains thread_id for resume)
 * - turn.started: Beginning of a turn (agent is processing)
 * - item.completed: Completed item (reasoning, agent_message, tool_call, tool_result)
 * - turn.completed: End of turn (contains usage stats)
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/**
 * Raw message structure from Z.ai JSON output
 */
interface ZaiRawMessage {
	type?:
		| 'thread.started'
		| 'turn.started'
		| 'item.completed'
		| 'turn.completed'
		| 'turn.failed'
		| 'error';
	thread_id?: string;
	item?: ZaiItem;
	usage?: ZaiUsage;
	error?: string | { message?: string; type?: string };
}

interface ZaiItem {
	id?: string;
	type?: 'reasoning' | 'agent_message' | 'tool_call' | 'tool_result';
	text?: string;
	tool?: string;
	args?: Record<string, unknown>;
	output?: string | number[];
}

interface ZaiUsage {
	input_tokens?: number;
	output_tokens?: number;
	cached_input_tokens?: number;
	reasoning_output_tokens?: number;
}

function extractErrorText(error: ZaiRawMessage['error'], fallback = 'Unknown error'): string {
	if (typeof error === 'object' && error?.message) return error.message;
	if (typeof error === 'string') return error;
	return fallback;
}

export class ZaiOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'zai';

	private lastToolName: string | null = null;

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

		const msg = parsed as ZaiRawMessage;

		if (msg.type === 'thread.started') {
			return {
				type: 'init',
				sessionId: msg.thread_id,
				raw: msg,
			};
		}

		if (msg.type === 'turn.started') {
			return {
				type: 'system',
				raw: msg,
			};
		}

		if (msg.type === 'item.completed' && msg.item) {
			return this.transformItem(msg.item, msg);
		}

		if (msg.type === 'turn.completed') {
			const event: ParsedEvent = {
				type: 'usage',
				raw: msg,
			};
			if (msg.usage) {
				event.usage = {
					inputTokens: msg.usage.input_tokens || 0,
					outputTokens: (msg.usage.output_tokens || 0) + (msg.usage.reasoning_output_tokens || 0),
					cacheReadTokens: msg.usage.cached_input_tokens || 0,
					reasoningTokens: msg.usage.reasoning_output_tokens || 0,
				};
			}
			return event;
		}

		if (msg.type === 'turn.failed' || msg.type === 'error' || msg.error) {
			return {
				type: 'error',
				text: extractErrorText(msg.error),
				raw: msg,
			};
		}

		return {
			type: 'system',
			raw: msg,
		};
	}

	private transformItem(item: ZaiItem, msg: ZaiRawMessage): ParsedEvent {
		switch (item.type) {
			case 'reasoning':
				return {
					type: 'text',
					text: (item.text || '').replace(/(\*\*[^*]+\*\*)/g, '\n\n$1'),
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
					toolState: { status: 'running', input: item.args },
					raw: msg,
				};
			case 'tool_result': {
				const toolName = this.lastToolName || undefined;
				this.lastToolName = null;
				return {
					type: 'tool_use',
					toolName,
					toolState: { status: 'completed', output: this.decodeOutput(item.output) },
					raw: msg,
				};
			}
			default:
				return { type: 'system', raw: msg };
		}
	}

	private decodeOutput(output: string | number[] | undefined): string {
		if (output === undefined) return '';
		if (typeof output === 'string') return output;
		if (Array.isArray(output)) return Buffer.from(output).toString('utf-8');
		return String(output);
	}

	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result' && !!event.text;
	}

	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId || null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		try {
			return this.detectErrorFromParsed(JSON.parse(line));
		} catch {
			return null;
		}
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') return null;
		const obj = parsed as Record<string, unknown>;
		const errorText = extractErrorText(obj.error as ZaiRawMessage['error']);
		if (errorText === 'Unknown error' && !obj.error) return null;

		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, errorText);

		return match
			? {
					type: match.type,
					message: match.message,
					recoverable: match.recoverable,
					agentId: this.agentId,
					timestamp: Date.now(),
					parsedJson: parsed,
				}
			: obj.error
				? {
						type: 'unknown',
						message: errorText,
						recoverable: true,
						agentId: this.agentId,
						timestamp: Date.now(),
						parsedJson: parsed,
					}
				: null;
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) return null;
		const combined = `${stderr}\n${stdout}`;
		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, combined);

		return match
			? {
					type: match.type,
					message: match.message,
					recoverable: match.recoverable,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr, stdout },
				}
			: {
					type: 'agent_crashed',
					message: `Agent exited with code ${exitCode}`,
					recoverable: true,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { exitCode, stderr, stdout },
				};
	}
}
