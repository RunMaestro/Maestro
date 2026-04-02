/**
 * OpenClaw Output Parser
 *
 * Parses OpenClaw's JSON output into Maestro's normalized ParsedEvent format.
 *
 * OpenClaw's --json output is a single JSON object (not JSONL stream),
 * emitted when the process completes. stderr contains ANSI-colored debug logs.
 *
 * Output structure:
 * {
 *   payloads: [{ text: string, mediaUrl: string | null }],
 *   meta: {
 *     durationMs: number,
 *     agentMeta: {
 *       sessionId: string,
 *       provider: string,
 *       model: string,
 *       usage: { input, output, cacheWrite, total },
 *       lastCallUsage: { input, output, cacheRead, cacheWrite }
 *     }
 *   }
 * }
 *
 * CLI: openclaw agent --json --agent <id> --message "prompt"
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import type { AgentErrorPatterns } from './error-patterns';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[OpenClawParser]';

/** OpenClaw payloads array element */
interface OpenClawPayload {
	text: string;
	mediaUrl: string | null;
}

/** OpenClaw usage structure */
interface OpenClawUsage {
	input: number;
	output: number;
	cacheWrite?: number;
	cacheRead?: number;
	total?: number;
}

/** OpenClaw agentMeta structure */
interface OpenClawAgentMeta {
	sessionId: string;
	provider: string;
	model: string;
	usage: OpenClawUsage;
	lastCallUsage?: OpenClawUsage;
}

/** OpenClaw --json output root structure */
interface OpenClawJsonResult {
	payloads: OpenClawPayload[];
	meta: {
		durationMs: number;
		agentMeta: OpenClawAgentMeta;
	};
}

export class OpenClawOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'openclaw';
	private readonly errorPatterns: AgentErrorPatterns = getErrorPatterns('openclaw');

	parseJsonLine(line: string): ParsedEvent | null {
		const stripped = stripAnsiCodes(line).trim();
		if (!stripped) {
			return null;
		}

		try {
			const parsed = JSON.parse(stripped);
			return this.parseJsonObject(parsed);
		} catch {
			// Incomplete JSON line or non-JSON stderr output — skip
			return null;
		}
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') return null;
		const msg = parsed as Record<string, unknown>;

		// Detect OpenClaw standard --json output: { payloads: [...], meta: { ... } }
		if (Array.isArray(msg.payloads) && msg.meta) {
			return this.parseOpenClawResult(msg as unknown as OpenClawJsonResult);
		}

		// Fallback: future JSONL streaming support
		const eventType = (msg.type as string) || '';

		if (eventType === 'error') {
			return {
				type: 'error',
				text: (msg.message as string) || (msg.error as string) || 'Unknown OpenClaw error',
				raw: msg,
			};
		}

		// Unrecognized structure
		logger.debug(`${LOG_CONTEXT} Unrecognized JSON structure`, LOG_CONTEXT, {
			keys: Object.keys(msg),
		});
		return null;
	}

	/**
	 * Convert OpenClaw completion JSON response to ParsedEvent
	 */
	private parseOpenClawResult(result: OpenClawJsonResult): ParsedEvent {
		const agentMeta = result.meta?.agentMeta;

		// Concatenate payload texts (usually one element)
		const text = result.payloads
			.map((p) => p.text)
			.filter(Boolean)
			.join('\n');

		// Extract usage stats
		let usage: ParsedEvent['usage'] | undefined;
		if (agentMeta?.usage) {
			const u = agentMeta.usage;
			usage = {
				inputTokens: u.input || 0,
				outputTokens: u.output || 0,
				cacheCreationTokens: u.cacheWrite || undefined,
				cacheReadTokens: agentMeta.lastCallUsage?.cacheRead || undefined,
			};
		}

		return {
			type: 'result',
			sessionId: agentMeta?.sessionId || undefined,
			text,
			usage,
			raw: result,
		};
	}

	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId ?? null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage ?? null;
	}

	extractSlashCommands(_event: ParsedEvent): string[] | null {
		// OpenClaw does not support slash commands
		return null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		const match = matchErrorPattern(this.errorPatterns, line);
		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
			};
		}
		return null;
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') return null;
		const msg = parsed as Record<string, unknown>;

		if (msg.type === 'error') {
			const errorMessage =
				(msg.message as string) || (msg.error as string) || 'Unknown OpenClaw error';

			return {
				type: 'agent_crashed',
				message: errorMessage,
				recoverable: true,
				agentId: this.agentId,
				timestamp: Date.now(),
			};
		}

		return null;
	}

	detectErrorFromExit(exitCode: number, stderr: string, _stdout: string): AgentError | null {
		if (exitCode === 0) return null;

		if (stderr) {
			const cleanStderr = stripAnsiCodes(stderr);
			const match = matchErrorPattern(this.errorPatterns, cleanStderr);
			if (match) {
				return {
					type: match.type,
					message: match.message,
					recoverable: match.recoverable,
					agentId: this.agentId,
					timestamp: Date.now(),
				};
			}
		}

		return {
			type: 'agent_crashed',
			message: `OpenClaw process exited with code ${exitCode}`,
			recoverable: exitCode === 1,
			agentId: this.agentId,
			timestamp: Date.now(),
		};
	}
}
