/**
 * The streaming tap on a dispatched agent's output.
 *
 * A voice turn cannot wait for an agent to finish writing. Four hundred lines of
 * implementation detail take a minute to produce and the user is standing there
 * in silence for all of it, so the tap follows the SAME process events the
 * desktop transcript follows and hands the translator coherent pieces as they
 * appear. The first spoken word therefore lands while the agent is still typing.
 *
 * Three rules this file exists to keep:
 *
 *   - **One listener path.** It subscribes to the process manager's own emitter,
 *     the one `src/main/process-listeners/` already uses. A second listener path,
 *     or a poll of the transcript, would drift from what the user sees on screen
 *     and would double-count every chunk.
 *   - **Nothing unspeakable escapes.** Tool calls, diffs, code fences, file
 *     listings, spinner frames, and raw ANSI are dropped HERE rather than being
 *     left for the translator to notice, because a translator handed a diff
 *     spends a model call deciding not to read it out.
 *   - **Silence is never the answer.** An agent that errored or went quiet
 *     produces a short honest status chunk. A voice interface with nothing to say
 *     is indistinguishable from one that is broken.
 *
 * Free of Electron and of the process manager's concrete type: the emitter
 * arrives as {@link AgentOutputSource} so the suite can drive it with a bare
 * EventEmitter.
 */

import { buildProcessSessionId } from '../../dispatch-callbacks/dispatch-callback-registry';
import { extractTextFromStreamJson } from '../../group-chat/output-parser';
import { stripAnsiCodes } from '../../../shared/stringUtils';

/** Handler shape for the untyped `EventEmitter` the process manager really is. */
type ProcessEventHandler = (...args: unknown[]) => void;

/**
 * The slice of `ProcessManager` the tap needs. Narrow on purpose: the tap
 * listens and never spawns, kills, or writes.
 */
export interface AgentOutputSource {
	on(event: string, handler: ProcessEventHandler): unknown;
	off(event: string, handler: ProcessEventHandler): unknown;
}

/**
 * What kind of thing the chunk is.
 *
 *   - `text`   - a completed thought from the middle of a reply.
 *   - `final`  - the tail, flushed when the agent finished its turn.
 *   - `status` - the tap speaking for itself: an error, or an agent gone quiet.
 *                Never model output, so the translator passes it straight
 *                through rather than paying a hop to rephrase a failure.
 */
export type AgentOutputChunkKind = 'text' | 'final' | 'status';

export interface AgentOutputChunk {
	agentSessionId: string;
	tabId: string;
	kind: AgentOutputChunkKind;
	/** Speech-safe prose. Never a diff, a path listing, or a spinner frame. */
	text: string;
	ts: number;
}

export interface AgentOutputTapOptions {
	source: AgentOutputSource;
	/** One coherent piece of the reply, in order. */
	onChunk: (chunk: AgentOutputChunk) => void;
	/** Agent type for the stream-json parser, when the caller knows it. */
	getAgentType?: (agentSessionId: string) => string | undefined;
	/** Quiet for this long with a turn open and the tap says so. */
	hangMs?: number;
	/** Smallest run of prose emitted as its own chunk mid-reply. */
	minChunkChars?: number;
	now?: () => number;
	setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** An agent that has said nothing for this long is worth a word. */
const DEFAULT_HANG_MS = 20_000;

/**
 * Below this, a finished thought waits for the next one instead of becoming its
 * own spoken chunk. Two hundred characters is roughly a spoken sentence and a
 * half: short enough that the first words come fast, long enough that the
 * translator is not called once per "Okay.".
 */
const DEFAULT_MIN_CHUNK_CHARS = 200;

interface WatchEntry {
	agentSessionId: string;
	tabId: string;
	processSessionId: string;
	/** Complete-line buffer: filtering is line-oriented and chunks split anywhere. */
	partialLine: string;
	/** Speech-safe prose waiting to reach `minChunkChars` or a paragraph break. */
	speech: string;
	/** Inside a fenced code block, which can span many `data` events. */
	inFence: boolean;
	/** Something has been emitted for this turn, so a hang notice is not the first word. */
	emitted: boolean;
	hangTimer: ReturnType<typeof setTimeout> | null;
	hangAnnounced: boolean;
}

export class AgentOutputTap {
	private readonly options: AgentOutputTapOptions;
	private readonly hangMs: number;
	private readonly minChunkChars: number;
	private readonly now: () => number;
	private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;

	/** Keyed by the composite process session id, which is what the events carry. */
	private readonly watched = new Map<string, WatchEntry>();
	private readonly registered: [string, ProcessEventHandler][] = [];
	private disposed = false;

	constructor(options: AgentOutputTapOptions) {
		this.options = options;
		this.hangMs = options.hangMs ?? DEFAULT_HANG_MS;
		this.minChunkChars = options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
		this.now = options.now ?? Date.now;
		this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));

		this.listen('data', (sessionId: string, data: string) => this.handleData(sessionId, data));
		this.listen('agent-error', (sessionId: string, error: { message?: string }) =>
			this.handleError(sessionId, error?.message)
		);
		this.listen('query-complete', (sessionId: string) => this.handleTurnEnd(sessionId));
		this.listen('exit', (sessionId: string, code: number) => this.handleExit(sessionId, code));
	}

	/**
	 * Follow one dispatched tab. Re-watching the same tab restarts its buffers,
	 * which is what a second voice turn into the same tab should do.
	 */
	watch(params: { agentSessionId: string; tabId: string }): void {
		if (this.disposed) return;
		const processSessionId = buildProcessSessionId(params.agentSessionId, params.tabId);
		this.stopEntry(this.watched.get(processSessionId));

		const entry: WatchEntry = {
			agentSessionId: params.agentSessionId,
			tabId: params.tabId,
			processSessionId,
			partialLine: '',
			speech: '',
			inFence: false,
			emitted: false,
			hangTimer: null,
			hangAnnounced: false,
		};
		this.watched.set(processSessionId, entry);
		this.armHangTimer(entry);
	}

	/** Stop following one tab, dropping whatever it had buffered. */
	unwatch(params: { agentSessionId: string; tabId: string }): void {
		const processSessionId = buildProcessSessionId(params.agentSessionId, params.tabId);
		this.stopEntry(this.watched.get(processSessionId));
		this.watched.delete(processSessionId);
	}

	/** True while any tab is being followed. */
	get isWatching(): boolean {
		return this.watched.size > 0;
	}

	/** Drop every subscription and every buffer. Safe to repeat. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.watched.values()) this.stopEntry(entry);
		this.watched.clear();
		for (const [event, handler] of this.registered) this.options.source.off(event, handler);
		this.registered.length = 0;
	}

	// -- Events --------------------------------------------------------------

	private handleData(processSessionId: string, data: string): void {
		const entry = this.watched.get(processSessionId);
		if (!entry || typeof data !== 'string') return;

		this.armHangTimer(entry);

		entry.partialLine += toPlainText(data, this.options.getAgentType?.(entry.agentSessionId));
		const lines = entry.partialLine.split('\n');
		// The last element is whatever came after the final newline: an unfinished
		// line that the next `data` event completes.
		entry.partialLine = lines.pop() ?? '';

		for (const line of lines) this.consumeLine(entry, line);
		this.drain(entry, false);
	}

	private handleError(processSessionId: string, message?: string): void {
		const entry = this.watched.get(processSessionId);
		if (!entry) return;
		// The agent's own failure text, said plainly. Going silent here is the
		// worst option: the user has no screen and would wait forever.
		this.flush(entry);
		this.emit(
			entry,
			'status',
			message?.trim() ? `It hit an error: ${oneLine(message)}` : 'It hit an error.'
		);
		this.stopEntry(entry);
	}

	private handleTurnEnd(processSessionId: string): void {
		const entry = this.watched.get(processSessionId);
		if (!entry) return;
		this.finishTurn(entry);
	}

	private handleExit(processSessionId: string, code: number): void {
		const entry = this.watched.get(processSessionId);
		if (!entry) return;

		this.finishTurn(entry);
		if (code !== 0 && !entry.emitted) {
			this.emit(entry, 'status', `It stopped without answering, exit code ${code}.`);
		}
		this.watched.delete(processSessionId);
	}

	/** Flush the tail, close the turn, and stop the hang clock. */
	private finishTurn(entry: WatchEntry): void {
		if (entry.partialLine) {
			this.consumeLine(entry, entry.partialLine);
			entry.partialLine = '';
		}
		this.flush(entry);
		this.stopEntry(entry);
	}

	// -- Filtering -----------------------------------------------------------

	/**
	 * One complete line, kept or dropped.
	 *
	 * Line-oriented rather than whole-buffer, because a `data` event splits
	 * anywhere - including in the middle of a code fence - and a filter that
	 * re-examined the whole buffer each time would re-decide earlier lines with
	 * different context.
	 */
	private consumeLine(entry: WatchEntry, rawLine: string): void {
		// A carriage return is a spinner redrawing itself in place. Only the last
		// frame is even a candidate, and it is dropped below along with the rest.
		const line = rawLine.split('\r').pop() ?? '';
		const trimmed = line.trim();

		if (isFenceDelimiter(trimmed)) {
			entry.inFence = !entry.inFence;
			return;
		}
		if (entry.inFence) return;

		if (!trimmed) {
			// A blank line is a paragraph boundary: the completed thought before it is
			// the natural place to cut a spoken chunk.
			if (entry.speech.trim()) entry.speech += '\n\n';
			return;
		}

		if (isUnspeakableLine(trimmed)) return;

		const prose = toProse(trimmed);
		if (!prose) return;

		entry.speech += entry.speech && !entry.speech.endsWith('\n') ? ` ${prose}` : prose;
	}

	// -- Emission ------------------------------------------------------------

	/**
	 * Emit whatever is ready.
	 *
	 * Mid-reply the cut is a paragraph boundary, so a chunk is a completed thought
	 * rather than a sentence torn off a list. A run that has passed
	 * `minChunkChars` with no paragraph in sight is cut at its last sentence
	 * boundary instead: an agent writing one long block should not buy silence.
	 */
	private drain(entry: WatchEntry, final: boolean): void {
		if (final) {
			const text = entry.speech.trim();
			entry.speech = '';
			if (text) this.emit(entry, 'final', text);
			return;
		}

		let boundary = entry.speech.indexOf('\n\n');
		while (boundary !== -1) {
			const piece = entry.speech.slice(0, boundary).trim();
			entry.speech = entry.speech.slice(boundary + 2);
			if (piece) this.emit(entry, 'text', piece);
			boundary = entry.speech.indexOf('\n\n');
		}

		if (entry.speech.trim().length < this.minChunkChars) return;
		const cut = lastSentenceBoundary(entry.speech);
		if (cut <= 0) return;

		const piece = entry.speech.slice(0, cut).trim();
		entry.speech = entry.speech.slice(cut);
		if (piece) this.emit(entry, 'text', piece);
	}

	private flush(entry: WatchEntry): void {
		this.drain(entry, true);
	}

	private emit(entry: WatchEntry, kind: AgentOutputChunkKind, text: string): void {
		entry.emitted = true;
		this.options.onChunk({
			agentSessionId: entry.agentSessionId,
			tabId: entry.tabId,
			kind,
			text: oneLine(text),
			ts: this.now(),
		});
	}

	// -- Hang detection ------------------------------------------------------

	/**
	 * An agent that has produced nothing for `hangMs` is reported once.
	 *
	 * Once, not on a repeat, because the honest fact is "it is taking a while" and
	 * saying it every twenty seconds turns a slow turn into a nagging one. The
	 * clock is re-armed on every byte of output, so a working agent never trips it.
	 */
	private armHangTimer(entry: WatchEntry): void {
		if (entry.hangTimer) this.clearTimeoutFn(entry.hangTimer);
		if (entry.hangAnnounced) return;
		entry.hangTimer = this.setTimeoutFn(() => {
			entry.hangTimer = null;
			// Checked inside the callback as well as before arming: a timer that has
			// already fired can still be held by whoever scheduled it.
			if (entry.hangAnnounced) return;
			entry.hangAnnounced = true;
			this.emit(entry, 'status', 'It is still working on that one.');
		}, this.hangMs);
	}

	private stopEntry(entry: WatchEntry | undefined): void {
		if (!entry) return;
		if (entry.hangTimer) this.clearTimeoutFn(entry.hangTimer);
		entry.hangTimer = null;
	}

	private listen<T extends unknown[]>(event: string, handler: (...args: T) => void): void {
		// The emitter is a bare `EventEmitter`, so its handlers are untyped by
		// construction; the cast is where the typed handlers above meet it.
		const bound = handler as unknown as ProcessEventHandler;
		this.options.source.on(event, bound);
		this.registered.push([event, bound]);
	}
}

export function createAgentOutputTap(options: AgentOutputTapOptions): AgentOutputTap {
	return new AgentOutputTap(options);
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Raw process output as plain text.
 *
 * Stream-json agents go through the parser the group chat already uses, so tool
 * calls and usage records never reach the filter as text at all. A PTY agent
 * (Terminal, and any agent running in its own TUI) produces no JSON, so the raw
 * bytes are used - with ANSI stripped by `stripAnsiCodes()` rather than by a
 * second regex that would drift from it.
 */
function toPlainText(raw: string, agentType?: string): string {
	const stripped = stripAnsiCodes(raw);
	if (!looksLikeStreamJson(stripped)) return stripped;

	const extracted = extractTextFromStreamJson(stripped, agentType);
	// An empty extraction means the chunk held only tool calls or bookkeeping,
	// which is exactly what should not be spoken. Falling back to the raw JSON
	// here would read a tool_use payload aloud.
	return extracted ? `${extracted}\n` : '';
}

function looksLikeStreamJson(text: string): boolean {
	return /^\s*\{/m.test(text);
}

// ---------------------------------------------------------------------------
// Line filters
// ---------------------------------------------------------------------------

/** ``` or ~~~, with or without a language tag. */
function isFenceDelimiter(line: string): boolean {
	return /^(?:```|~~~)/.test(line);
}

/** Unified-diff furniture, from `git diff` and from an agent narrating an edit. */
const DIFF_LINE = /^(?:diff --git |index [0-9a-f]{7,}|@@ |\+\+\+ |--- |[+-](?=\S))/;

/** Braille and block spinners, progress bars, and box drawing. */
const SPINNER_OR_RULE = /^[\s─-╿▀-▟⠀-⣿|+=_.*#[\]()<>/\\-]+$/u;

/**
 * TUI gutter markers for a tool call or its result.
 *
 * Deliberately not `•` or `●`: those are list bullets in most agents' output,
 * and a bullet line is content the translator should be allowed to summarise
 * rather than furniture to drop. They are handled as list markers in
 * {@link toProse} instead.
 */
const TOOL_GUTTER = /^[⏺✦✻·⎿└├⠀-⣿]\s/u;

/** A bare path, with or without a line number. Nothing else on the line. */
const BARE_PATH = /^[~.]?[\w@.-]*(?:\/[\w@.-]+)+(?::\d+(?::\d+)?)?$/;

/** A progress readout leading with its own percentage. */
const PROGRESS_READOUT = /^\d{1,3}(?:\.\d+)?%/;

/** True for a line that must never reach a speaker. */
function isUnspeakableLine(line: string): boolean {
	if (DIFF_LINE.test(line)) return true;
	if (TOOL_GUTTER.test(line)) return true;
	if (BARE_PATH.test(line)) return true;
	if (PROGRESS_READOUT.test(line)) return true;
	// Ordered last: it is the broadest, and a line made only of punctuation and box
	// characters has no words in it by construction.
	return SPINNER_OR_RULE.test(line);
}

/**
 * A surviving line, with the markdown furniture removed.
 *
 * Only the leading markers, and only the ones that are pure decoration: the
 * translator prompt handles voice, and stripping inline emphasis here would
 * fight `stripMarkdown()` downstream over the same text.
 */
function toProse(line: string): string {
	return line
		.replace(/^#{1,6}\s+/, '')
		.replace(/^>\s+/, '')
		.replace(/^[-*+•●]\s+/u, '')
		.replace(/^\d+[.)]\s+/, '')
		.trim();
}

/** Index just past the last sentence-ending punctuation, or -1. */
function lastSentenceBoundary(text: string): number {
	const match = /[.!?](?=\s)(?![\s\S]*[.!?]\s)/.exec(text);
	return match ? match.index + 1 : -1;
}

/** Collapse to one line: a newline in spoken text is read as a pause that is not there. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}
