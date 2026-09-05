/**
 * Grok CLI Output Parser
 *
 * Parses streaming output from `grok --output-format streaming-json`. The
 * stream is strict JSONL: one JSON object per line. Four event types were
 * verified against grok v0.2.93:
 *
 *   {"type":"thought","data":"<delta>"}   reasoning delta
 *   {"type":"text","data":"<delta>"}      assistant text delta
 *   {"type":"end","stopReason":"EndTurn","sessionId":"<uuid>","requestId":"<uuid>"}
 *   {"type":"error","message":"<text>"}
 *
 * grok 1.x adds two more (`tool_call`, `tool_call_update`) - see TOOL EVENTS
 * below.
 *
 * stopReason semantics (verified against grok 1.0.5): a completed turn ends
 * with "end_turn" ("EndTurn" on 0.x). Anything else means the turn DIED EARLY
 * with the streamed text unfinished - most commonly "cancelled", which is what
 * headless grok answers every permission prompt with (there is no TTY to ask),
 * and a cancelled prompt kills the whole turn rather than feeding a denial
 * back to the model. Such an end must surface as an error, not a result:
 * recording it as success is how a consult once delivered its preamble as the
 * "answer" with no hint that the actual work never ran.
 *
 * Schema notes (verified against grok v0.2.93):
 * - There is NO init/session-start event. The session ID (camelCase
 *   `sessionId`, UUIDv7) arrives only on the final `end` event, so it is
 *   extracted from the `result` event rather than an `init` event.
 * - No token usage or cost appears anywhere in the stream, so `end` maps to a
 *   `result` event without a usage object.
 * - Runtime failures emit the `error` JSON on stdout, duplicate the message on
 *   stderr as `Error: <message>`, and exit 1.
 *
 * TOOL EVENTS (grok 1.x). 0.2.93 emitted none - a tool-use turn produced only
 * thought/text/end lines - and this parser used to say so and drop everything
 * else into the `default` system branch. That is no longer true: grok 1.x adds
 * two more line types, and a single 1.0.5 turn was observed writing 121
 * `tool_call` and 242 `tool_call_update` records (issue #1485), every one of
 * which the default branch swallowed. The transcript then rendered as a
 * thinking block and nothing else.
 *
 *   {"type":"tool_call","toolCallId":"...","toolName":"run_terminal_command",
 *    "kind":"execute","rawInput":{...}}
 *   {"type":"tool_call_update","toolCallId":"...","status":"completed",
 *    "rawOutput":"..."}
 *
 * `toolCallId` is what makes parallel calls correlate: StdoutHandler keys the
 * running/completed merge on it (`tool-<id>`), so without one the renderer
 * falls back to matching the newest still-running badge BY TOOL NAME and two
 * concurrent calls to the same tool settle onto each other.
 *
 * Field reading is deliberately tolerant (camelCase and snake_case, `rawInput`
 * and `input`, `rawOutput` and `output`) because this shape comes from the
 * grok-build 1.0.16 sources plus a captured updates.jsonl rather than from a
 * schema this repo can pin a fixture to. A line that carries neither an id nor
 * a name is absorbed as a system event, so schema drift degrades to the old
 * drop-it behaviour instead of emitting a nameless badge.
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
	/** Present on `end` events: "end_turn" ("EndTurn" on 0.x) when the turn
	 *  completed, "cancelled" (or another non-end_turn value) when it died early */
	stopReason?: string;
	/** Present on `end` events - the only place the session ID appears */
	sessionId?: string;
	requestId?: string;
	/** Present on `error` events */
	message?: string;

	// --- `tool_call` / `tool_call_update` events (grok 1.x) ---
	// Both spellings are accepted; see the tolerant-reading note in the file
	// header. Every field is optional because a drifted line is absorbed as a
	// system event rather than rendered as a half-built badge.
	/** Stable per-invocation id, correlating a call with its updates. */
	toolCallId?: string;
	tool_call_id?: string;
	/** Tool being invoked, e.g. `run_terminal_command`. Only on `tool_call`. */
	toolName?: string;
	tool_name?: string;
	/** Coarse category (`execute`, `read`, `edit`, ...). Carried through to the
	 *  badge's raw payload; Maestro does not branch on it. */
	kind?: string;
	/** Invocation arguments. Only on `tool_call`. */
	rawInput?: unknown;
	input?: unknown;
	/** Lifecycle word on `tool_call_update`: pending/running/completed/failed. */
	status?: string;
	/** Tool result. Only on a settling `tool_call_update`. */
	rawOutput?: unknown;
	output?: unknown;
	/** Failure detail on a settling `tool_call_update`. */
	error?: unknown;
}

/** Grok statuses that mean the call has settled, mapped onto the status
 *  vocabulary StdoutHandler and the tool badge read (`running` | `completed` |
 *  `failed`). An unrecognized status is treated as still running so a badge is
 *  never wrongly reported as finished. */
function normalizeToolStatus(status: unknown): 'running' | 'completed' | 'failed' {
	const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
	if (value === 'completed' || value === 'success' || value === 'succeeded' || value === 'done') {
		return 'completed';
	}
	if (value === 'failed' || value === 'error' || value === 'cancelled' || value === 'canceled') {
		return 'failed';
	}
	return 'running';
}

/** First non-empty string among the candidates, or undefined. */
function firstString(...candidates: unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim()) return candidate;
	}
	return undefined;
}

/** First defined, non-null value among the candidates, or undefined. */
function firstDefined(...candidates: unknown[]): unknown {
	for (const candidate of candidates) {
		if (candidate !== undefined && candidate !== null) return candidate;
	}
	return undefined;
}

/** Truncate long unmatched error bodies for UI/logs. Full text stays in raw. */
function truncateErrorText(text: string): string {
	if (text.length <= MAX_ERROR_MESSAGE_CHARS) return text;
	return `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}...`;
}

/** The stopReason of an `end` event that died early, or null if the turn
 *  completed. A missing stopReason is treated as completed (schema drift must
 *  not turn every turn into an error). */
function incompleteStopReason(msg: GrokRawMessage): string | null {
	const reason = typeof msg.stopReason === 'string' ? msg.stopReason : '';
	if (!reason || reason === 'end_turn' || reason === 'EndTurn') return null;
	return reason;
}

/** User-facing message for a turn that ended without completing. */
function incompleteTurnMessage(stopReason: string): string {
	const hint =
		stopReason === 'cancelled'
			? ' In a non-interactive run this usually means a tool call needed a permission approval that headless Grok cannot grant, which cancels the whole turn.'
			: '';
	return `Grok ended the turn without completing (stopReason: ${stopReason}). Any streamed response is incomplete.${hint}`;
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

	/** Tool name per open call id. `tool_call_update` lines carry the id but not
	 *  the name, and a `tool_use` event without a `toolName` is dropped by
	 *  StdoutHandler, so the name has to be carried forward from the opening
	 *  `tool_call`. Entries are removed as each call settles; a parser instance
	 *  lives for one process, so an unsettled call cannot outlive the run. */
	private readonly toolNamesById = new Map<string, string>();

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
			case 'tool_call':
				// A tool line we cannot render (no id and no name) is absorbed as
				// system, exactly like an unknown type: raw is kept for debugging
				// and nothing half-built reaches the transcript.
				return this.toolCallEvent(msg, false) ?? { type: 'system', raw: msg };
			case 'tool_call_update':
				return this.toolCallEvent(msg, true) ?? { type: 'system', raw: msg };
			case 'end': {
				const sessionId =
					typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : undefined;
				// A non-end_turn stop means the turn died early (headless
				// permission cancel, token limit, ...). Reclassify as an error so
				// the unfinished streamed text is not recorded as a successful
				// result - same pattern as the Antigravity parser's failed
				// terminal envelope. sessionId stays attached so resume capture
				// still works.
				const stopReason = incompleteStopReason(msg);
				if (stopReason) {
					return {
						type: 'error',
						sessionId,
						text: incompleteTurnMessage(stopReason),
						raw: msg,
					};
				}
				// Sole result-style event. The full answer text was already
				// streamed via `text` deltas, so no text is attached here.
				// No usage object exists anywhere in the stream.
				return {
					type: 'result',
					sessionId,
					raw: msg,
				};
			}
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

	/**
	 * Build a `tool_use` event from a `tool_call` (opening) or a
	 * `tool_call_update` (progress / settling) line.
	 *
	 * The two share one builder because the renderer merges them by
	 * `toolCallId` and only cares which fields are present: the opening line
	 * carries the name and input, the settling one carries the status and
	 * output. A `tool_call` has no status word, so it is always `running` -
	 * reading `msg.status` there would let an absent field settle a badge that
	 * has not run yet.
	 *
	 * `toolName` is remembered per call id so a later update can be labeled: the
	 * update lines carry the id but not the name, and StdoutHandler drops a
	 * `tool_use` event with no `toolName`, which would strand every badge in
	 * `running` forever.
	 */
	private toolCallEvent(msg: GrokRawMessage, isUpdate: boolean): ParsedEvent | null {
		const toolCallId = firstString(msg.toolCallId, msg.tool_call_id);
		const reportedName = firstString(msg.toolName, msg.tool_name);
		// A line with neither an id nor a name is not a tool event we can render.
		// Return null so the caller absorbs it as a system event instead of
		// emitting a nameless, uncorrelatable badge.
		if (!toolCallId && !reportedName) {
			return null;
		}

		const toolName =
			reportedName || (toolCallId ? this.toolNamesById.get(toolCallId) : undefined) || 'tool';
		if (toolCallId && reportedName) {
			this.toolNamesById.set(toolCallId, reportedName);
		}

		const status = isUpdate ? normalizeToolStatus(msg.status) : 'running';
		if (toolCallId && status !== 'running') {
			this.toolNamesById.delete(toolCallId);
		}

		const input = firstDefined(msg.rawInput, msg.input);
		// A failure's detail goes in `output` rather than a field of its own:
		// `LogEntry.metadata.toolState` is {status,input,output}, so an `error` key
		// would survive the merge and render nowhere - the badge would say failed
		// and show nothing. A call that produced real output keeps it.
		const output = firstDefined(msg.rawOutput, msg.output, msg.error);

		return {
			type: 'tool_use',
			toolName,
			...(toolCallId ? { toolCallId } : {}),
			toolState: {
				status,
				// Only send fields the line actually carried. The renderer merges
				// a running badge with its update and falls back to the existing
				// value per field, so omitting a field the line did not restate
				// keeps the value recorded when the call opened.
				...(input !== undefined ? { input } : {}),
				...(output !== undefined ? { output } : {}),
			},
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
	 *  stdout, and an `end` event with a non-end_turn stopReason is a turn that
	 *  died early (see incompleteStopReason). parseJsonObject reclassifies that
	 *  end as an error EVENT (blocking the bogus result); this detection is what
	 *  actually emits the agent-error, mirroring the Antigravity parser's dual
	 *  handling of its failed terminal envelope. */
	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as GrokRawMessage;
		if (msg.type === 'end') {
			const stopReason = incompleteStopReason(msg);
			if (!stopReason) {
				return null;
			}
			return this.toAgentError('unknown', incompleteTurnMessage(stopReason), true, {
				parsedJson: parsed,
			});
		}
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
