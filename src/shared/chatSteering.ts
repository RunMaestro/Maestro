// Chat steering: the wire protocol for maestro-p's control channel.
//
// Lives in shared/ because BOTH processes need it - maestro-p serves the channel
// and the main process is the client - and the dependency direction here is
// one-way: maestro-p imports from shared (stringUtils, ptyKill), nothing imports
// from maestro-p. The screen predicates that decide whether the TUI can accept an
// injection are NOT here; they are maestro-p's own business and live in
// src/maestro-p/steering-screen.ts.
//
// Distinct from src/shared/autorunSteering.ts, which is the Auto Run feature of
// the same name and shares no mechanism with this one: that rides a note in front
// of the NEXT task's prompt, because an Auto Run spawns a fresh agent per task and
// has no live process to interrupt. This one types into a PTY that is mid-turn.
//
// What steering IS
// ----------------
// Claude's TUI accepts input while a turn is streaming and, when the turn still
// has agentic iterations left, folds that input into the RUNNING loop. It is not
// a Maestro invention: claude records the act in its own transcript as a
// `queue-operation` row and names the outcome itself.
//
//   {"type":"queue-operation","operation":"enqueue","content":"<text>"}
//   {"type":"queue-operation","operation":"remove","content":"<text>",
//    "reason":"absorbed_mid_turn"}
//
// Measured against claude 2.1.261: a twelve-file Read turn, steered after three
// tool calls, abandoned files 5-12 and answered the injected instruction inside
// the SAME `end_turn`, reporting mid-turn state (480 lines read) it could only
// have had from the in-flight work. That is steering.
//
// What steering IS NOT
// -------------------
// The same injection into a turn with no tool calls left to run is NOT absorbed:
// claude logs a bare `dequeue` AFTER `end_turn` and starts a second turn, which
// is the execution queue with extra steps. So absorption is a property of the
// TURN SHAPE, not of the channel, and it cannot be promised up front. Every
// verdict here is OBSERVED from the transcript, never assumed - see
// `classifyQueueOperation`.
//
// Why a screen gate exists at all
// -------------------------------
// The dangerous case is a blocking dialog. With a permission prompt on screen
// ("Do you want to create x.txt?  ❯ 1. Yes ... 3. No"), typing steering text and
// pressing ONE Enter selected option 1: the file was written, and the user's
// message was destroyed - it never reached the transcript at all, not even as a
// queue-operation row. So an injection is gated on the INPUT EDITOR being drawn
// (see `editorIsAcceptingInput`) and refuses otherwise.
//
// Typing itself is inert, which is what makes the second gate safe: the same
// trial typed "option 2 or 3 would be wrong, use 1" into a live permission
// dialog with no Enter, and the selector did not move and no file was written.
// Only the Enter acts. That is why `inject()` may type first and verify the echo
// before deciding to submit.

/**
 * Env var naming the unix socket (Windows: named pipe) maestro-p listens on for
 * control frames. Absent means steering is unavailable for that run, which is
 * the default: a turn nobody can steer must not open a channel.
 *
 * Stdin is deliberately NOT the channel. maestro-p reads a piped prompt with a
 * synchronous read-to-EOF (`fs.readFileSync(0)` in args.ts), and that is the
 * path Maestro uses for every image turn (`--input-format stream-json`), so
 * stdin is consumed before a control frame could ever arrive on it.
 */
export const STEERING_SOCKET_ENV_VAR = 'MAESTRO_P_STEERING_SOCKET';

/**
 * What became of one steering attempt.
 *
 * Two of these answer different questions, and the split is forced by timing
 * rather than chosen for tidiness. "Was it delivered?" is known the moment the
 * Enter goes in. "What did claude do with it?" is only knowable from the
 * transcript, and the two outcomes resolve on wildly different clocks: an absorb
 * was measured at 1.7s after the keystrokes, while a queued message produces no
 * row at all until `end_turn`, which can be minutes away. So one blocking reply
 * cannot describe both without either lying or hanging.
 *
 * `delivered` is therefore the socket's answer, and `absorbed` / `queued` arrive
 * later as a refinement on stdout.
 *
 * - `delivered` typed into the editor and submitted. Claude has it; what it does
 *               with it is not yet known.
 * - `absorbed`  claude folded it into the turn in flight (`absorbed_mid_turn`).
 *               The only verdict that means the running turn changed course.
 * - `queued`    claude parked it and was observed draining it. It ran as a
 *               FOLLOW-UP turn, and maestro-p captured that turn too - see below.
 * - `dropped`   delivered, never resolved, and the run ended anyway. The text is
 *               gone and the caller has to re-send it.
 * - `refused`   maestro-p declined to type it, or typed it and would not submit.
 *               NOT delivered, and the caller still owns the message - keep it
 *               queued rather than reporting it sent.
 * - `unknown`   an internal failure. Nobody knows where the text went; never
 *               report it as success.
 *
 * What `queued` costs, measured
 * ----------------------------
 * maestro-p is nominally one process per TURN - it finalizes a short grace after
 * `end_turn` and quits. A parked steer looks like it should therefore be
 * destroyed by the quit, and it is not, because claude writes the dequeued
 * message as an ordinary `user` entry and THAT invalidates the end_turn grace (the
 * same clear that keeps trailing tool_result rows from truncating a turn). So the
 * process stays alive and reads the follow-up turn as well.
 *
 * Observed on a text-only turn steered at 8s: `end_turn`, then `dequeue`, then the
 * steer as its own `user` entry, then a second `end_turn`. The run took 59s
 * instead of ~40s and the single `result` envelope carried BOTH turns' text
 * concatenated (7,061 chars, the second half in French as instructed).
 *
 * That is the right trade - the user's words are answered rather than discarded -
 * but it means a `queued` verdict tells the caller that `duration_ms`, `usage` and
 * `result` for this run span two turns with no boundary marker in them. Do not
 * present a `queued` steer as having changed the turn in flight; it did not.
 */
export type SteeringVerdict =
	| 'delivered'
	| 'absorbed'
	| 'queued'
	| 'dropped'
	| 'refused'
	| 'unknown';

/**
 * What a steered message's transcript bubble knows about its own steer.
 *
 * `pending` is the gap between the two answers: the text is typed and the
 * transcript has not yet said what the agent did with it. The other two are the
 * verdicts that leave the bubble in the transcript; `dropped`, `refused` and
 * `unknown` all take the bubble back out and return the message to the queue, so
 * they never need drawing.
 */
export type SteerBubbleState = 'pending' | Extract<SteeringVerdict, 'absorbed' | 'queued'>;

/** Why an injection was refused. Each maps to a different thing to tell the user. */
export type SteeringRefusal =
	| 'not-running' // no turn in flight; this is an ordinary message, not a steer
	| 'blocking-dialog' // a permission/plan/trust dialog owns the keyboard
	| 'editor-unavailable' // editor not drawn and no dialog named it; unknown screen
	| 'echo-missing' // typed, but the text never appeared; NOT submitted
	| 'tui-exited' // the PTY went away mid-injection
	| 'too-long'; // over STEERING_MAX_TEXT_BYTES; never typed

/** Control frame in: a request to steer the running turn. */
export interface SteeringRequestFrame {
	type: 'steer';
	/** Caller-minted id, echoed back on the result so a caller can match them up. */
	id: string;
	text: string;
}

/** Control frame out, and the stdout event: what happened to one request. */
export interface SteeringResultFrame {
	type: 'steering';
	id: string;
	verdict: SteeringVerdict;
	/** Present only on `refused`. */
	refusal?: SteeringRefusal;
	/** Human-readable detail for the UI. Never a terminal command. */
	detail?: string;
}

/**
 * How long the main process waits for maestro-p's socket reply before giving up.
 *
 * Bounded by what the SERVER does, not by how long claude takes to think: the
 * reply comes back as soon as the text is typed and submitted (or refused), and
 * the absorbed/queued refinement arrives later on stdout instead. The typing
 * itself is the slow part - paced at 256 bytes per repaint with a 250ms drain cap,
 * so a full 8 KB frame can take a few seconds on a busy machine.
 */
export const STEERING_REPLY_TIMEOUT_MS = 20_000;

/**
 * Waits for a `maestro-cli queue steer` round trip. Each hop outward must outlast
 * the one it waits on, or an outer timeout reports a steer as failed while the
 * inner one is still about to answer: the renderer waits on the socket
 * ({@link STEERING_REPLY_TIMEOUT_MS}), main waits on the renderer, and the CLI
 * waits on main.
 */
export const QUEUE_STEER_RENDERER_TIMEOUT_MS = STEERING_REPLY_TIMEOUT_MS + 2_500;
export const QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS = STEERING_REPLY_TIMEOUT_MS + 5_000;

/**
 * What became of one request to steer a QUEUED message (the Steer button on a
 * queued card, or `maestro-cli queue steer`). One shape for both callers, so the
 * CLI reports exactly what the click did.
 *
 * - `delivered`     typed and submitted; the item left the queue and returns if
 *                   the transcript later shows claude never took it.
 * - `settled`       claude already took it (absorbed or queued); nothing pending.
 * - `refused`       nothing was typed; the item is still queued where it was.
 * - `unconfirmed`   it may have been typed; the item is still queued, PAUSED.
 * - `not-found`     no queued item with that id for that agent.
 * - `not-steerable` the item cannot be steered right now; see `blockedReason`.
 * - `unavailable`   this client has no steering bridge (a web renderer).
 */
export type QueueSteerOutcome =
	| 'delivered'
	| 'settled'
	| 'refused'
	| 'unconfirmed'
	| 'not-found'
	| 'not-steerable'
	| 'unavailable';

export interface QueueSteerResult {
	outcome: QueueSteerOutcome;
	/** The socket's verdict, when a steer was actually attempted. */
	verdict?: SteeringVerdict;
	refusal?: SteeringRefusal;
	/** Why an item is not steerable (`not-steerable` only). */
	blockedReason?: string;
	/** Human-readable detail for the caller. */
	detail?: string;
}

/** Every queue-steer outcome, for runtime validation (typed so a new case must be listed). */
export const QUEUE_STEER_OUTCOMES: readonly QueueSteerOutcome[] = [
	'delivered',
	'settled',
	'refused',
	'unconfirmed',
	'not-found',
	'not-steerable',
	'unavailable',
];

/**
 * Validate a queue-steer result that crossed a process boundary. Returns null
 * for anything that is not one, so a caller reports a transport failure rather
 * than a fabricated outcome.
 */
export function parseQueueSteerResult(raw: unknown): QueueSteerResult | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const outcome = QUEUE_STEER_OUTCOMES.find((o) => o === r.outcome);
	if (!outcome) return null;
	const result: QueueSteerResult = { outcome };
	const verdict = STEERING_VERDICTS.find((v) => v === r.verdict);
	if (verdict) result.verdict = verdict;
	if (typeof r.refusal === 'string') result.refusal = r.refusal as SteeringRefusal;
	if (typeof r.blockedReason === 'string') result.blockedReason = r.blockedReason;
	if (typeof r.detail === 'string') result.detail = r.detail;
	return result;
}

/**
 * Longest text accepted in one frame. Generous (a steer is a sentence or two,
 * not a document) but bounded, because every byte is TYPED into a live PTY at
 * 256 bytes per repaint: a megabyte would hold the turn's keyboard for minutes.
 */
export const STEERING_MAX_TEXT_BYTES = 8192;

/**
 * UTF-8 byte length of steering text.
 *
 * `TextEncoder` rather than `Buffer.byteLength` on purpose: this module is
 * imported by the RENDERER for its verdict types, and the renderer has no Node
 * Buffer. Measured in bytes rather than characters because the text is typed into
 * the PTY as bytes and queued by the kernel as bytes, so a character-counted cap
 * would let through several times the intended size for non-ASCII text.
 */
export function steeringTextBytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Whether `text` is over the per-frame cap and so can never be typed as a steer. */
export function steeringTextTooLong(text: string): boolean {
	return steeringTextBytes(text) > STEERING_MAX_TEXT_BYTES;
}

/**
 * Whether `text` would be read as a command by Claude's TUI rather than typed as
 * a message: a leading `/` opens the slash-command menu (Enter would run `/clear`
 * or `/compact` mid-turn) and a leading `!` switches the editor to bash mode.
 * Such a message is never steered into a Claude turn; it waits and sends normally.
 */
export function startsWithTuiCommandPrefix(text: string): boolean {
	return /^[/!]/.test(text.trimStart());
}

/** The detail every layer reports for an over-cap steer, so the wording cannot drift. */
export const STEERING_TOO_LONG_DETAIL = `the message is over the ${STEERING_MAX_TEXT_BYTES / 1024} KB steering limit`;

/**
 * The detail for a `not-running` refusal: the turn ended before the steer could
 * land. Actionable (send it normally), unlike "not steerable", which invites the
 * user to go looking for a setting. Shared so every transport says it the same way.
 */
export const STEERING_TURN_FINISHED_DETAIL =
	'that turn has already finished, so there is nothing to steer';

/**
 * The id of a well-formed steer frame whose ONLY fault is its size, else null.
 *
 * Exists so the server can answer an oversize frame with `refused` instead of
 * ignoring it. Silence left the caller waiting out its own timeout and then
 * reporting `unknown`, which the UI treats as "maybe typed" and pauses - for text
 * that provably never reached the PTY.
 */
export function oversizeSteeringRequestId(line: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.trim());
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const frame = parsed as Partial<SteeringRequestFrame>;
	if (frame.type !== 'steer' || typeof frame.id !== 'string' || frame.id.length === 0) return null;
	if (typeof frame.text !== 'string' || !steeringTextTooLong(frame.text)) return null;
	return frame.id;
}

/** Parse one NDJSON control line. Returns null for anything unrecognized. */
export function parseSteeringRequest(line: string): SteeringRequestFrame | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const frame = parsed as Partial<SteeringRequestFrame>;
	if (frame.type !== 'steer') return null;
	if (typeof frame.id !== 'string' || frame.id.length === 0) return null;
	if (typeof frame.text !== 'string' || frame.text.length === 0) return null;
	if (steeringTextTooLong(frame.text)) return null;
	return { type: 'steer', id: frame.id, text: frame.text };
}

/**
 * Whether text claude recorded is the text we injected. Whitespace-insensitive,
 * like the echo check (screenShowsTypedText): claude rewrites whitespace on the
 * way in (a tab is recorded as four spaces), and a strict compare misses the row,
 * which reports an absorbed steer as `dropped`.
 */
export function steeringTextMatches(recorded: string, injected: string): boolean {
	const squash = (s: string) => s.replace(/\s+/g, '');
	return squash(recorded) === squash(injected);
}

/**
 * Classify one `queue-operation` transcript row against the text we injected.
 * Returns null when the row is about something else (another client's message,
 * a different steer), so a caller can keep waiting rather than resolve on it.
 *
 * `remove` + `absorbed_mid_turn` is claude's own statement that the running turn
 * took the message. A bare `dequeue` carries no content, so it can only be
 * attributed positionally by the caller; it means the message became its own
 * turn, which is `queued`.
 */
export function classifyQueueOperation(
	row: unknown,
	injectedText: string
): { verdict: SteeringVerdict; matchedContent: boolean } | null {
	if (!row || typeof row !== 'object') return null;
	const r = row as { type?: unknown; operation?: unknown; content?: unknown; reason?: unknown };
	if (r.type !== 'queue-operation') return null;
	const sameText = typeof r.content === 'string' && steeringTextMatches(r.content, injectedText);
	if (r.operation === 'remove') {
		if (!sameText) return null;
		return {
			verdict: r.reason === 'absorbed_mid_turn' ? 'absorbed' : 'queued',
			matchedContent: true,
		};
	}
	if (r.operation === 'dequeue') {
		// No content on this row; the caller decides whether it is ours.
		return { verdict: 'queued', matchedContent: false };
	}
	// `enqueue` only proves claude accepted the keystrokes. Not a verdict.
	return null;
}

/**
 * Every verdict, for runtime validation. Typed as the verdict union so adding a
 * case to `SteeringVerdict` without listing it here fails to compile, rather than
 * silently becoming unparseable on the wire.
 */
export const STEERING_VERDICTS: readonly SteeringVerdict[] = [
	'delivered',
	'absorbed',
	'queued',
	'dropped',
	'refused',
	'unknown',
];

/**
 * Parse one NDJSON verdict line. Returns null for anything unrecognized.
 *
 * The client's mirror of `parseSteeringRequest`, and it VALIDATES rather than
 * casting for the same reason: a frame carrying a verdict this build does not know
 * would otherwise reach the UI, which has no branch for it and would show a steer
 * as neither delivered nor refused. Unknown fields are dropped rather than passed
 * through, so a newer maestro-p cannot smuggle state into an older desktop.
 */
export function parseSteeringResult(line: string): SteeringResultFrame | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const frame = parsed as Partial<SteeringResultFrame>;
	if (frame.type !== 'steering') return null;
	if (typeof frame.id !== 'string' || frame.id.length === 0) return null;
	if (typeof frame.verdict !== 'string') return null;
	if (!STEERING_VERDICTS.includes(frame.verdict)) return null;
	const result: SteeringResultFrame = { type: 'steering', id: frame.id, verdict: frame.verdict };
	if (typeof frame.refusal === 'string') result.refusal = frame.refusal as SteeringRefusal;
	if (typeof frame.detail === 'string') result.detail = frame.detail;
	return result;
}
