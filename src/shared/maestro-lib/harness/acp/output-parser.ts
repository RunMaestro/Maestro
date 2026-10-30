import type { ToolType, AgentError } from '../../../types';
import type { AgentOutputParser, ParsedEvent } from '../../parsers/agent-output-parser';

/** Normalized parser for ACP's translated JSONL, independent of the underlying harness. */
export class AcpOutputParser implements AgentOutputParser {
	constructor(
		readonly agentId: ToolType,
		private readonly delegate?: AgentOutputParser
	) {}

	/** Parse one translated JSONL line, ignoring blank or malformed provider output. */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) return null;
		try {
			return this.parseJsonObject(JSON.parse(line));
		} catch {
			return null;
		}
	}

	/** Normalize ACP text, tools, commands, usage, results, and errors into Maestro events. */
	parseJsonObject(raw: unknown): ParsedEvent | null {
		if (!raw || typeof raw !== 'object') return null;
		const event = raw as Record<string, unknown>;
		const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
		switch (event.type) {
			case 'acp.init':
				return { type: 'init', sessionId, raw };
			case 'acp.text':
				return {
					type: 'text',
					sessionId,
					text: typeof event.text === 'string' ? event.text : '',
					isPartial: true,
					isReasoning: event.reasoning === true,
					raw,
				};
			case 'acp.tool':
				return {
					type: 'tool_use',
					sessionId,
					toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
					toolName: typeof event.toolName === 'string' ? event.toolName : 'tool',
					toolState: event.state,
					raw,
				};
			case 'acp.commands':
				return {
					type: 'init',
					sessionId,
					slashCommands: Array.isArray(event.commands)
						? event.commands.filter((command): command is string => typeof command === 'string')
						: [],
					raw,
				};
			case 'acp.usage': {
				const usage = (event.usage ?? {}) as Record<string, unknown>;
				return {
					type: 'usage',
					sessionId,
					usage: {
						inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
						outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
						cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
						cacheCreationTokens:
							typeof usage.cacheCreationTokens === 'number' ? usage.cacheCreationTokens : 0,
						reasoningTokens: typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0,
						contextWindow:
							typeof usage.contextWindow === 'number' ? usage.contextWindow : undefined,
						contextWindowReported: typeof usage.contextWindow === 'number',
						costUsd: typeof usage.costUsd === 'number' ? usage.costUsd : undefined,
						...(typeof usage.contextUsed === 'number'
							? {
									absoluteUsage: {
										inputTokens: usage.contextUsed,
										outputTokens: 0,
										cacheReadInputTokens: 0,
										cacheCreationInputTokens: 0,
										reasoningTokens: 0,
									},
								}
							: {}),
					},
					raw,
				};
			}
			case 'acp.result':
				return {
					type:
						event.stopReason === 'end_turn' || event.stopReason === 'cancelled'
							? 'result'
							: 'error',
					sessionId,
					text: typeof event.text === 'string' ? event.text : '',
					raw,
				};
			case 'acp.error':
				return {
					type: 'error',
					sessionId,
					text: typeof event.message === 'string' ? event.message : 'ACP transport failed',
					raw,
				};
			case 'acp.system':
				return { type: 'system', sessionId, raw };
			default:
				return null;
		}
	}

	/** Identify terminal result events without treating provider errors as successful results. */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	/** Extract the provider session identifier when the event carries one. */
	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId ?? null;
	}

	/** Extract normalized token, context, and cost usage from an event. */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage ?? null;
	}

	/** Extract dynamically discovered slash commands from an ACP init event. */
	extractSlashCommands(event: ParsedEvent): string[] | null {
		return event.slashCommands ?? null;
	}

	/** Delegate provider-specific stderr heuristics to the fallback parser when present. */
	detectErrorFromLine(line: string): AgentError | null {
		return this.delegate?.detectErrorFromLine(line) ?? null;
	}

	/** Delegate provider-specific structured error detection to the fallback parser. */
	detectErrorFromParsed(parsed: unknown): AgentError | null {
		return this.delegate?.detectErrorFromParsed(parsed) ?? null;
	}

	/** Delegate exit-code classification to the fallback parser when present. */
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		return this.delegate?.detectErrorFromExit(exitCode, stderr, stdout) ?? null;
	}
}
