/**
 * Grok CLI Output Parser
 *
 * Parses streaming output from `grok --output-format streaming-json` (verified
 * against grok v0.2.93). The stream is strict JSONL: one JSON object per line,
 * and exactly four event types appear on stdout:
 *
 *   {"type":"thought","data":"<delta>"}   reasoning delta
 *   {"type":"text","data":"<delta>"}      assistant text delta
 *   {"type":"end","stopReason":"EndTurn","sessionId":"<uuid>","requestId":"<uuid>"}
 *   {"type":"error","message":"<text>"}
 *
 * Schema notes (verified against grok v0.2.93):
 * - There is NO init/session-start event. The session ID (camelCase
 *   `sessionId`, UUIDv7) arrives only on the final `end` event, so it is
 *   extracted from the `result` event rather than an `init` event.
 * - Tool invocations are NOT emitted on stdout at all - a tool-use turn
 *   produces only thought/text/end lines. Tool telemetry exists solely in the
 *   on-disk session files (`~/.grok/sessions/.../events.jsonl`). No
 *   `tool_use` events can be parsed here.
 * - No token usage or cost appears anywhere in the stream, so `end` maps to a
 *   `result` event without a usage object.
 * - Runtime failures emit the `error` JSON on stdout, duplicate the message on
 *   stderr as `Error: <message>`, and exit 1.
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

interface GrokRawMessage {
	type?: string;
	/** Delta payload for `thought` and `text` events */
	data?: string;
	/** Present on `end` events (only `"EndTurn"` observed) */
	stopReason?: string;
	/** Present on `end` events - the only place the session ID appears */
	sessionId?: string;
	requestId?: string;
	/** Present on `error` events */
	message?: string;
}

/**
 * Parses Grok CLI streaming-json output into normalized ParsedEvents.
 *
 * Grok's stream is delta-based: `thought` and `text` events carry token-sized
 * chunks that concatenate directly (whitespace is embedded in the payload).
 * Both are forwarded as partial text events, with reasoning tagged
 * `isReasoning: true` per the Thinking / Tool Log Contract
 * (docs/agent-guides/AGENT-INFRA.md).
 */
export class GrokOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'grok';

	/** Parse a single JSON line from Grok's JSONL output stream.
	 *  Non-JSON lines (e.g. stray stderr text like `Error: ...`) return null. */
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

	/** Parse an already-deserialized JSON object into a normalized ParsedEvent. */
	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as GrokRawMessage;

		switch (msg.type) {
			case 'thought': {
				const data = typeof msg.data === 'string' ? msg.data : '';
				if (!data) {
					return null;
				}
				return {
					type: 'text',
					text: data,
					isPartial: true,
					isReasoning: true,
					raw: msg,
				};
			}
			case 'text': {
				const data = typeof msg.data === 'string' ? msg.data : '';
				if (!data) {
					return null;
				}
				return {
					type: 'text',
					text: data,
					isPartial: true,
					raw: msg,
				};
			}
			case 'end':
				// Sole result-style event. The full answer text was already
				// streamed via `text` deltas, so no text is attached here.
				// No usage object exists anywhere in the stream.
				return {
					type: 'result',
					sessionId: msg.sessionId,
					raw: msg,
				};
			case 'error':
				return {
					type: 'error',
					text: msg.message || 'Unknown error',
					raw: msg,
				};
			default:
				return {
					type: 'system',
					raw: msg,
				};
		}
	}

	/** Check whether a parsed event represents a completed agent response. */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	/** Extract the Grok session ID from a parsed event, if present.
	 *  Grok reports the session ID only on the final `end` event. */
	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) return event.sessionId;

		const raw = event.raw as GrokRawMessage | undefined;
		return raw?.sessionId || null;
	}

	/** Extract usage/token statistics from a parsed event.
	 *  Grok's stream carries no usage or cost data, so this is always null
	 *  unless a future CLI version adds it. */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	/** Extract slash commands from events. Returns null - Grok has no init event
	 *  and never advertises slash commands in the stream. */
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

	/** Detect agent errors from an already-parsed JSON object.
	 *  Grok surfaces runtime failures as `{"type":"error","message":...}` on
	 *  stdout; every other event type is never an error. */
	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as GrokRawMessage;
		if (msg.type !== 'error') {
			return null;
		}

		const errorText = typeof msg.message === 'string' ? msg.message.trim() : '';
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

	/** Detect agent errors from process exit code and stderr/stdout content.
	 *  Grok duplicates its error message on stderr (`Error: <message>`) and
	 *  exits 1, so the combined text is matched against the pattern bank. */
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
