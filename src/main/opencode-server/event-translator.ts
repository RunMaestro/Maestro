// src/main/opencode-server/event-translator.ts

/**
 * OpenCode SSE -> CLI JSONL translator.
 *
 * The OpenCode SDK server streams a rich SSE event union (`message.part.updated`,
 * `session.idle`, `session.error`, ...). Maestro's existing OpenCode pipeline -
 * the main-process `OpenCodeOutputParser`, the renderer peek/wizard parsers, and
 * everything downstream - was built against the JSONL that `opencode run --format
 * json` writes to stdout, i.e. lines shaped like:
 *
 *   { type: 'step_start' | 'text' | 'tool_use' | 'step_finish' | 'error',
 *     sessionID, part: { ... } }
 *
 * Rather than re-plumb the whole stack, this translator converts SDK events back
 * into those identical JSONL lines so the server path reuses the CLI parse/render
 * stack verbatim. The SDK `Part` shapes already match the CLI `part` fields
 * one-to-one; the only real work is:
 *   - mapping the SDK part.type (hyphenated: "step-start", "tool", "step-finish")
 *     to the CLI top-level message type (underscored: "step_start", "tool_use",
 *     "step_finish"),
 *   - filtering the shared server's multiplexed stream down to a single session,
 *   - gating streaming text so each completed text block is emitted exactly once
 *     (the CLI emits one complete `text` message per block, not per delta).
 *
 * The translator is intentionally pure/stateful-per-session and free of any SDK
 * client or process concerns so it can be unit-tested in isolation.
 */

import type { Event, Part } from '@opencode-ai/sdk';

/** A single translated result of feeding one SDK event to the translator. */
export interface TranslatedEvent {
	/** CLI-format JSONL lines to feed through StdoutHandler (may be empty). */
	lines: string[];
	/** True when this event signals the target session has gone idle (turn done). */
	idle: boolean;
	/** True when this event carried a session error for the target session. */
	errored: boolean;
}

const EMPTY: TranslatedEvent = { lines: [], idle: false, errored: false };

/**
 * Translate a single OpenCode server session's SSE events into CLI JSONL lines.
 *
 * One instance per spawned prompt. Construct it with the OpenCode session id so
 * events belonging to other sessions/projects on the shared server are ignored.
 */
export class OpencodeEventTranslator {
	/** Text part ids already flushed as a completed `text` line (dedup guard). */
	private emittedTextPartIds = new Set<string>();
	/** Latest cumulative text seen per text part id, for end-of-turn flushing. */
	private pendingText = new Map<string, string>();

	constructor(private readonly sessionId: string) {}

	/**
	 * Feed one SDK event. Returns the JSONL line(s) to forward plus idle/error
	 * signals. Events for other sessions return an empty result.
	 */
	handle(event: Event): TranslatedEvent {
		switch (event.type) {
			case 'message.part.updated':
				return this.handlePart(event.properties.part);

			case 'session.idle':
				if (event.properties.sessionID !== this.sessionId) return EMPTY;
				return { lines: this.flushPendingText(), idle: true, errored: false };

			case 'session.error': {
				// Only end this turn on an error explicitly scoped to our session. The
				// SDK marks `session.error.sessionID` optional, and session-less errors
				// (init/provider failures with no owning session) are broadcast to every
				// subscriber on the shared server. Treating those as ours would abort
				// unrelated concurrent turns, so we require an exact id match and drop
				// the rest. (Trade-off: a truly global fatal error won't force-end this
				// turn; it ends on the normal session.idle instead.)
				if (event.properties.sessionID !== this.sessionId) return EMPTY;
				const line = this.buildErrorLine(event.properties.error);
				return { lines: line ? [line] : [], idle: false, errored: true };
			}

			default:
				return EMPTY;
		}
	}

	/** Flush any streamed-but-not-completed text blocks (called on idle). */
	private flushPendingText(): string[] {
		const lines: string[] = [];
		for (const [partId, text] of this.pendingText) {
			if (this.emittedTextPartIds.has(partId)) continue;
			this.emittedTextPartIds.add(partId);
			lines.push(this.buildTextLine(text));
		}
		this.pendingText.clear();
		return lines;
	}

	private handlePart(part: Part): TranslatedEvent {
		if (part.sessionID !== this.sessionId) return EMPTY;

		switch (part.type) {
			case 'step-start':
				return {
					lines: [this.buildLine('step_start', { type: 'step-start' })],
					idle: false,
					errored: false,
				};

			case 'text': {
				// SDK emits `message.part.updated` repeatedly as text streams in, each
				// carrying the cumulative text. The CLI emits one complete `text`
				// message per block. Emit only when the block is complete (time.end set),
				// exactly once; otherwise buffer for an end-of-turn flush.
				const complete = part.time?.end !== undefined;
				if (!complete) {
					this.pendingText.set(part.id, part.text);
					return EMPTY;
				}
				if (this.emittedTextPartIds.has(part.id)) return EMPTY;
				this.emittedTextPartIds.add(part.id);
				this.pendingText.delete(part.id);
				return { lines: [this.buildTextLine(part.text, part.time)], idle: false, errored: false };
			}

			case 'tool': {
				// The renderer merges running/completed/error updates by callID, so
				// forwarding every non-pending state transition gives live tool status
				// without duplicate log entries. Pending carries no useful detail yet.
				if (part.state.status === 'pending') return EMPTY;
				return {
					lines: [
						this.buildLine('tool_use', {
							type: 'tool',
							tool: part.tool,
							callID: part.callID,
							state: part.state,
						}),
					],
					idle: false,
					errored: false,
				};
			}

			case 'step-finish':
				return {
					lines: [
						this.buildLine('step_finish', {
							type: 'step-finish',
							reason: part.reason,
							cost: part.cost,
							tokens: part.tokens,
						}),
					],
					idle: false,
					errored: false,
				};

			// reasoning/file/snapshot/patch/agent/retry/compaction/subtask parts have
			// no CLI-JSONL equivalent the existing parser consumes; skip for parity.
			default:
				return EMPTY;
		}
	}

	/** Build a CLI JSONL message line: `{ type, sessionID, part }`. */
	private buildLine(type: string, part: Record<string, unknown>): string {
		return JSON.stringify({ type, sessionID: this.sessionId, part });
	}

	private buildTextLine(text: string, time?: { start: number; end?: number }): string {
		return this.buildLine('text', { type: 'text', text, ...(time ? { time } : {}) });
	}

	/**
	 * Build a CLI `error` line. The SDK error objects (`ApiError`, `UnknownError`,
	 * `ProviderAuthError`, ...) already expose `{ name, data: { message } }`, which
	 * is exactly the shape `OpenCodeOutputParser.detectErrorFromParsed` reads.
	 */
	private buildErrorLine(error: unknown): string | null {
		if (!error) {
			// A session error with no payload still needs to surface as an error so the
			// turn doesn't silently succeed. Emit a minimal recognizable error object.
			return JSON.stringify({
				type: 'error',
				sessionID: this.sessionId,
				error: { name: 'UnknownError', data: { message: 'OpenCode session error' } },
			});
		}
		return JSON.stringify({ type: 'error', sessionID: this.sessionId, error });
	}
}
