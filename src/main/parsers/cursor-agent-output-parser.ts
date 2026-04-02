/**
 * Cursor Agent Output Parser
 *
 * Parses Cursor Agent CLI stream-json output (`cursor-agent --print --output-format stream-json`).
 *
 * Cursor's official CLI docs and local help confirm:
 * - `--print` enables headless/script mode
 * - `--output-format stream-json` emits structured line-delimited events
 * - `--resume [chatId]` resumes a previous chat
 *
 * The parser is intentionally defensive because Cursor may add fields over time.
 * It recognizes common init/result/tool/message shapes and falls back cleanly.
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

interface CursorContentBlock {
	type?: string;
	text?: string;
	name?: string;
	id?: string;
	input?: unknown;
	output?: unknown;
	status?: string;
}

interface CursorToolPayload {
	id?: string;
	name?: string;
	input?: unknown;
	output?: unknown;
	status?: string;
}

interface CursorRawMessage {
	type?: string;
	subtype?: string;
	role?: string;
	session_id?: string;
	chat_id?: string;
	chatId?: string;
	text?: string;
	delta?: string;
	result?: string;
	finalText?: string;
	message?: {
		role?: string;
		content?: string | CursorContentBlock[];
	};
	content?: string | CursorContentBlock[];
	tool_call?: CursorToolPayload;
	tool_result?: CursorToolPayload;
	tool?: CursorToolPayload;
	slash_commands?: string[];
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		reasoning_tokens?: number;
	};
	error?: string | { message?: string; type?: string };
}

function extractSessionId(msg: CursorRawMessage): string | null {
	return msg.session_id || msg.chat_id || msg.chatId || null;
}

function extractBlocksContent(
	content: string | CursorContentBlock[] | undefined,
	blockType: 'text' | 'tool_use'
): string | Array<{ name: string; id?: string; input?: unknown }> {
	if (!content) {
		return blockType === 'text' ? '' : [];
	}

	if (typeof content === 'string') {
		return blockType === 'text' ? content : [];
	}

	if (blockType === 'text') {
		return content
			.filter((block) => (block.type || 'text') === 'text' && block.text)
			.map((block) => block.text || '')
			.join('');
	}

	return content
		.filter((block) => block.type === 'tool_use' && block.name)
		.map((block) => ({
			name: block.name!,
			id: block.id,
			input: block.input,
		}));
}

function extractErrorText(error: CursorRawMessage['error']): string {
	if (typeof error === 'string') return error;
	if (typeof error === 'object' && error?.message) return error.message;
	return 'Unknown error';
}

export class CursorAgentOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'cursor-agent';

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
				isPartial: true,
				raw: line,
			};
		}
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as CursorRawMessage;
		const sessionId = extractSessionId(msg) || undefined;

		if ((msg.type === 'system' && msg.subtype === 'init') || msg.type === 'init') {
			return {
				type: 'init',
				sessionId,
				slashCommands: msg.slash_commands,
				raw: msg,
			};
		}

		if (msg.type === 'result' || msg.type === 'completion' || msg.result || msg.finalText) {
			const text =
				msg.result ||
				msg.finalText ||
				(typeof msg.text === 'string' ? msg.text : '') ||
				(typeof msg.message?.content === 'string'
					? msg.message.content
					: (extractBlocksContent(msg.message?.content, 'text') as string));

			return {
				type: 'result',
				sessionId,
				text,
				usage: this.extractUsageFromMessage(msg),
				raw: msg,
			};
		}

		const toolPayload = msg.tool_call || msg.tool_result || msg.tool;
		if (msg.type === 'tool_call' || msg.type === 'tool_result' || toolPayload) {
			return {
				type: 'tool_use',
				sessionId,
				toolName: toolPayload?.name,
				toolState: {
					status: toolPayload?.status || (msg.type === 'tool_result' ? 'completed' : 'running'),
					input: toolPayload?.input,
					output: toolPayload?.output,
				},
				raw: msg,
			};
		}

		const messageRole = msg.role || msg.message?.role;
		const messageText =
			(typeof msg.delta === 'string' && msg.delta) ||
			(typeof msg.text === 'string' && msg.text) ||
			(typeof msg.message?.content === 'string'
				? msg.message.content
				: (extractBlocksContent(msg.message?.content, 'text') as string)) ||
			(typeof msg.content === 'string'
				? msg.content
				: (extractBlocksContent(msg.content, 'text') as string));
		const toolUseBlocks = [
			...(extractBlocksContent(msg.message?.content, 'tool_use') as Array<{
				name: string;
				id?: string;
				input?: unknown;
			}>),
			...(extractBlocksContent(msg.content, 'tool_use') as Array<{
				name: string;
				id?: string;
				input?: unknown;
			}>),
		];

		if (messageRole === 'assistant' && messageText) {
			return {
				type: 'text',
				sessionId,
				text: messageText,
				isPartial: true,
				toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
				raw: msg,
			};
		}

		const usage = this.extractUsageFromMessage(msg);
		if (usage) {
			return {
				type: 'usage',
				sessionId,
				usage,
				raw: msg,
			};
		}

		if (msg.error || msg.type === 'error') {
			return {
				type: 'error',
				sessionId,
				text: extractErrorText(msg.error),
				raw: msg,
			};
		}

		return {
			type: 'system',
			sessionId,
			raw: msg,
		};
	}

	private extractUsageFromMessage(msg: CursorRawMessage): ParsedEvent['usage'] | undefined {
		if (!msg.usage) return undefined;

		return {
			inputTokens: msg.usage.input_tokens || 0,
			outputTokens: msg.usage.output_tokens || 0,
			cacheReadTokens: msg.usage.cache_read_input_tokens || 0,
			cacheCreationTokens: msg.usage.cache_creation_input_tokens || 0,
			reasoningTokens: msg.usage.reasoning_tokens || 0,
		};
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

	extractSlashCommands(event: ParsedEvent): string[] | null {
		return event.slashCommands || null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		try {
			return this.detectErrorFromParsed(JSON.parse(line));
		} catch {
			const match = matchErrorPattern(getErrorPatterns(this.agentId), line);
			if (!match) return null;
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: { errorLine: line },
			};
		}
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') return null;
		const msg = parsed as CursorRawMessage;

		const textCandidates = [
			msg.error ? extractErrorText(msg.error) : '',
			typeof msg.text === 'string' ? msg.text : '',
			typeof msg.result === 'string' ? msg.result : '',
		].filter(Boolean);

		for (const candidate of textCandidates) {
			const match = matchErrorPattern(getErrorPatterns(this.agentId), candidate);
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
		}

		return null;
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) return null;

		const combined = `${stderr}\n${stdout}`.trim();
		const match = matchErrorPattern(getErrorPatterns(this.agentId), combined);
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
			type: 'unknown',
			message: combined || `Cursor Agent exited with code ${exitCode}`,
			recoverable: false,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}
}
