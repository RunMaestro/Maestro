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

/** Cap for user-facing unmatched error bodies in UI/logs. */
const MAX_ERROR_MESSAGE_CHARS = 500;

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

/** Truncate long unmatched error bodies for UI/logs. Full text stays in raw. */
function truncateErrorText(text: string): string {
	if (text.length <= MAX_ERROR_MESSAGE_CHARS) return text;
	return `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}...`;
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
			case 'thought':
				return this.deltaEvent(msg, true);
			case 'text':
				return this.deltaEvent(msg, false);
			case 'end':
				// Sole result-style event. The full answer text was already
				// streamed via `text` deltas, so no text is attached here.
				// No usage object exists anywhere in the stream.
				return {
					type: 'result',
					sessionId: typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : undefined,
					raw: msg,
				};
			case 'error': {
				// Align with detectErrorFromParsed: empty/non-string messages are
				// not errors (avoid synthetic "Unknown error" on the CLI path).
				const message = typeof msg.message === 'string' ? msg.message.trim() : '';
				if (!message) {
					return null;
				}
				return {
					type: 'error',
					text: message,
					raw: msg,
				};
			}
			default:
				// Unknown types are absorbed as system (forward-compat with CLI
				// schema growth). No user-visible error; keep raw for debugging.
				return {
					type: 'system',
					raw: msg,
				};
		}
	}

	/** thought/text deltas share the same shape; only isReasoning differs. */
	private deltaEvent(msg: GrokRawMessage, isReasoning: boolean): ParsedEvent | null {
		const data = typeof msg.data === 'string' ? msg.data : '';
		if (!data) {
			return null;
		}
		return {
			type: 'text',
			text: data,
			isPartial: true,
			...(isReasoning ? { isReasoning: true as const } : {}),
			raw: msg,
		};
	}

	/** Check whether a parsed event represents a completed agent response. */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	/** Extract the Grok session ID from a parsed event, if present.
	 *  Grok reports the session ID only on the final `end` event. */
	extractSessionId(event: ParsedEvent): string | null {
		if (typeof event.sessionId === 'string' && event.sessionId) {
			return event.sessionId;
		}

		const raw = event.raw as GrokRawMessage | undefined;
		return typeof raw?.sessionId === 'string' && raw.sessionId ? raw.sessionId : null;
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

	/**
	 * Detect agent errors from a raw line (stdout JSON or stderr plain text).
	 *
	 * Mid-run: stderr often carries `Error: <message>` as non-JSON. Matching
	 * the pattern bank here surfaces auth/rate/model failures before process
	 * exit. Unmatched free-form stderr returns null so classification can
	 * wait for the exit path (avoids false mid-stream unknowns).
	 */
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

		const matched = this.matchPattern(errorText, undefined, parsed);
		if (matched) {
			return matched;
		}

		// Truncate unmatched bodies for UI; full text remains in parsedJson.
		return this.toAgentError('unknown', truncateErrorText(errorText), true, {
			parsedJson: parsed,
		});
	}

	/** Detect agent errors from process exit code and stderr/stdout content.
	 *  Grok duplicates its error message on stderr (`Error: <message>`) and
	 *  exits 1, so the combined text is matched against the pattern bank. */
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

	/**
	 * Match free-form text against the Grok error pattern bank.
	 * On match, UI gets canned copy; truncated original is stored on
	 * `raw.errorLine` when no stderr/errorLine is already present so
	 * operators can still see which model id / detail failed.
	 */
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

		// Preserve a truncated original so canned messages do not erase
		// which model id / detail failed. Prefer existing stderr/errorLine.
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

	/** Build a consistent AgentError payload. */
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
