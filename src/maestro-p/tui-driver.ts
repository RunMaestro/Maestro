// Slim TUI driver for maestro-p.
//
// Spawns the Claude CLI under a PTY and exposes a minimal event stream the
// run-mode flow can consume. By design this module is NOT the source of
// truth for assistant output - that comes from the structured JSONL
// transcript Claude writes alongside its TUI. The driver's only jobs
// post-startup are:
//
//   1. Signal startup readiness once the input prompt indicator (› or ❯)
//      first appears in the ANSI-stripped rolling buffer. The indicator is
//      detected with an UNANCHORED regex because PTY output routinely
//      prepends \r cursor returns, so ^-anchored line matching misses it.
//   2. Detect quota-limit messages on the screen. This is the one signal
//      the JSONL doesn't carry - Claude emits the limit text only to its
//      terminal panel.
//   3. Surface every ANSI-stripped completed line via 'line' for the
//      --status mode /usage panel capture. Run mode ignores 'line' events
//      entirely.
//   4. Report 'api-billing' when the startup header says claude came up on
//      API Usage Billing instead of a subscription plan (see billing-mode.ts).
//
// Explicitly NOT implemented: spinner regexes, completion-via-spinner-stop,
// 'ready' re-firing after each response. Completion in run mode is the
// JSONL tailer's responsibility (stop_reason === 'end_turn').

import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { IDisposable, IPty } from 'node-pty';

import { stripAnsiCodes } from '../shared/stringUtils';
import { killPty } from '../shared/ptyKill';
import { showsApiUsageBilling } from './billing-mode';
import { replayTerminalScreen } from './screen-replay';
import {
	describeBlockingDialog,
	editorIsAcceptingInput,
	editorShowsTypedText,
} from './steering-screen';
import type { SteeringRefusal } from '../shared/chatSteering';

export interface TuiDriverOptions {
	binPath: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
	// --status only: accumulate the full raw PTY stream so the /usage panel can
	// be parsed from the complete screen rather than the `\n`-delimited 'line'
	// events. Claude paints heavier /usage panels (Team/Enterprise accounts, or
	// any account with a long "what's contributing" breakdown) entirely via
	// cursor-addressing with NO line feeds, so the 'line' stream stays empty and
	// the content sits unflushed in lineBuffer until exit. Off by default: run
	// mode never reads the screen and must not pay the unbounded-buffer cost.
	captureScreen?: boolean;
	// Answer claude's folder-trust prompt with "Yes, I trust this folder" even
	// when it highlights "No, exit" (claude 2.1.26x does in the home and temp
	// dirs, and the blind unblock Enter would quit). Trusting grants claude read,
	// edit, and execute rights in `cwd`, and claude remembers it, so this is only
	// for a cwd the caller owns and keeps empty - Maestro's usage probe folder -
	// or one the user explicitly opted into via MAESTRO_P_ACCEPT_WORKSPACE_TRUST.
	// Without it, a dialog that defaults to "No, exit" is never answered: the
	// driver emits 'workspace-untrusted' instead of pressing Enter on it.
	acceptWorkspaceTrust?: boolean;
	// Ceiling on the startup handshake before 'ready-timeout' fires. Defaults to
	// READY_TIMEOUT_MS. Run mode raises it (`--ready-timeout`) because a loaded
	// host can take well past 8s to boot claude with its MCP servers and plugins.
	readyTimeoutMs?: number;
}

export const DEFAULT_COLS = 200;
export const DEFAULT_ROWS = 50;
export const QUIT_GRACE_MS = 2000;
// Gap between writing the prompt body and the terminating Enter. Claude's
// TUI uses a multi-line input editor: when text and the trailing `\r` arrive
// in a single PTY write (or back-to-back within the same input tick), the
// input box treats the `\r` as a *literal* newline keeping the prompt parked
// in the editor instead of submitting it. Splitting the writes with a small
// delay forces the TUI to flush the text buffer before the Enter keystroke
// is interpreted on its own. 80ms is comfortably above one input-poll tick
// without being user-perceptible. See _interactive-mode-input-race.md and
// the JSONL evidence in session 3f7b37dd… where the unsubmitted prompt got
// flushed to disk as "<prompt>\r/quit".
export const SEND_ENTER_DELAY_MS = 80;

// A single Enter SEND_ENTER_DELAY_MS after the text is not reliable on a cold
// TUI. maestro-p emits 'ready' as soon as the `[›❯]` input indicator paints,
// but on claude 2.1.x that indicator shows (as a dimmed placeholder) before
// the editor can actually accept a *submit*: hooks/MCP servers are still
// initialising ("running sp hooks 0/2"). An Enter that lands in that window is
// dropped, leaving the prompt typed-but-parked. Since claude never starts a
// turn, no session JSONL is ever written and the fresh-session watcher times
// out - the observed "tab naming / synopsis returns null in TUI mode" bug.
// Re-tap Enter a few times, spaced out, so a later tap lands once the editor
// has settled. Pressing Enter on an already-submitted (empty) input is a
// no-op (see READY_TAP comment), so the extra taps are harmless once the turn
// has started. Verified against claude 2.1.162: a single Enter ~7s after a
// cold spawn submits, while an 80ms-only Enter does not.
export const SUBMIT_ENTER_RETRIES = 4;
export const SUBMIT_ENTER_RETRY_INTERVAL_MS = 750;

// How many unread input bytes a macOS PTY holds. Every prompt loss seen in the
// field has been an exact multiple of it. Named so the chunk budget below can
// be checked against it rather than against a number in a comment.
export const MACOS_PTY_INPUT_QUEUE_BYTES = 1022;

// The prompt body is typed in small, paced chunks, never one write. A macOS PTY
// queues at most 1,022 unread input bytes, and claude discards whatever is
// sitting in that queue at certain moments (a terminal input flush), so every
// loss is a multiple of 1,022 bytes. One big write keeps the queue full for as
// long as claude takes to read the prompt: Cue runs lost 1,022 bytes from the
// middle of their prompts, and in live trials against claude 2.1.261 a single
// 4 KB write lost 2-4 KB every time, even 1.5s after startup. Chunks well under
// the queue size, spaced so claude has read each one before the next lands,
// keep the queue near-empty. Run mode's prompt-echo check (prompt-echo.ts)
// still fails the turn loudly if a prompt ever arrives damaged.
//
// The SIZE has to leave room for more than one chunk in flight. 512 bytes does
// not: two undrained chunks are 1,024 bytes against a 1,022-byte queue, so a
// single chunk claude has not read yet is enough to overflow the next one.
// claude re-renders its whole input editor on every keystroke batch, and that
// render grows with the text already typed, so a multi-KB prompt reliably
// pushes one render past the 20ms interval - which is why 3.4 KB prompts still
// lost exactly one queue (issue #1598) with the 512-byte pacing in place.
// 256 bytes keeps three chunks in flight (768 B) inside the queue.
export const PROMPT_CHUNK_MAX_BYTES = 256;
// Floor between writes. This is a FLOOR, not the pacing: see
// PROMPT_CHUNK_DRAIN_TIMEOUT_MS for why a fixed interval cannot be the whole
// answer.
export const PROMPT_CHUNK_INTERVAL_MS = 20;

// Pacing is DRAIN-AWARE, not clock-driven. A fixed interval is a guess about
// how fast claude reads, and it is wrong exactly when it matters: the slower
// claude gets (a big editor, a contended machine), the more chunks pile up
// unread and the closer the queue gets to overflowing. claude repaints the
// editor when it consumes typed input, so PTY output arriving after a write is
// the one piece of evidence we have that the bytes were read, and send() waits
// for that paint before the next chunk instead of assuming 20ms was enough.
// The wait is capped so a screen that stops painting (claude busy elsewhere,
// output suppressed) cannot stall the turn - past the cap we fall through and
// keep typing, which is no worse than the fixed interval was.
// 256 bytes per paint types a 4 KB prompt in ~320ms and 100 KB in ~8s.
export const PROMPT_CHUNK_DRAIN_TIMEOUT_MS = 250;

// Falling through after the short wait is only safe for a few chunks. claude
// treats any single read of more than 800 characters as a paste
// (`key.length > 800` in its input handler, read from claude 2.1.296) and since
// 2.1.294 logs that span inside `<pasted_content>` tags, which tell the model
// the text may not be the user's own. When claude stalled for about a second
// (a contended machine, a big session resume) the short wait timed out four
// times, the queue filled, and claude read all 1,022 bytes at once: every
// wrapped span seen in the field (21 of 21) was exactly one full queue. Typing
// into a full queue is also how input gets lost: with claude frozen mid-prompt
// (SIGSTOP), the short wait alone lost 1,022 or 2,044 bytes in 3 of 3 live
// runs, and the hold below lost none in 7 of 7.
//
// So once this many chunks are written with no paint since, send() holds the
// next one until claude paints, for up to PROMPT_STALL_DRAIN_TIMEOUT_MS. A paint
// that was already in flight can pass for one chunk's drain signal, so the
// queue can hold one chunk more than this count: three chunks, 768 bytes, which
// is under both the paste limit and the queue size.
export const PROMPT_MAX_UNDRAINED_CHUNKS = 2;
export const CLAUDE_PASTE_THRESHOLD_CHARS = 800;
// Long enough to outlast a stalled claude, short enough to sit well inside the
// first-byte budget. A screen that never paints costs this once per prompt:
// after one long wait runs out, send() goes back to the short wait.
export const PROMPT_STALL_DRAIN_TIMEOUT_MS = 30_000;

// claude also discards input for a moment right after its input prompt first
// paints, while the rest of its UI is still mounting: paced typing that started
// the instant `ready` fired lost the first 1,022 bytes in 2 of 2 trials, while
// starting 500ms later lost nothing. Instead of a fixed sleep that a slow,
// contended startup could outlast, send() waits until the screen has been quiet
// (no PTY output) for PROMPT_SETTLE_QUIET_MS, capped at PROMPT_SETTLE_MAX_MS so
// a screen that never stops animating cannot stall the turn.
export const PROMPT_SETTLE_QUIET_MS = 300;
export const PROMPT_SETTLE_MAX_MS = 3000;

// claude's input editor cannot hold a literal tab, so a tab in the prompt can
// never reach the transcript as a tab. What it becomes depends on how claude
// classifies the write: input it treats as a paste gets each `\t` replaced by
// four spaces, while input it treats as typing reads `\t` as the Tab KEY - it
// is dropped (`a\tb` arrives as `ab`) or, after an `@` mention, fires path
// autocomplete and inserts text nobody wrote. Verified against claude 2.1.294
// with raw and bracketed-paste writes (issue #1755). We expand tabs ourselves
// to the same four spaces claude's paste path produces, so the outcome is one
// predictable thing and no Tab keystroke is ever sent. Byte-identical delivery
// of a tab is not possible through the TUI; run mode warns when this applies.
export const PROMPT_TAB_SPACES = 4;

export function expandPromptTabs(text: string): string {
	return text.replace(/\t/g, ' '.repeat(PROMPT_TAB_SPACES));
}

/** What became of one inject() call. */
export interface InjectOutcome {
	submitted: boolean;
	/** The text as typed (see normalizeInjectedText); what claude's transcript records. */
	typed?: string;
	refusal?: SteeringRefusal;
	detail?: string;
}

// What inject() actually types for a steer. A `\r` is the Enter key in a PTY, so
// a CR or CRLF left in the text submits the first half of the message mid-type
// and leaves the rest in the editor; LF is claude's in-editor newline. Tabs are
// expanded for the same reason send() expands them (see PROMPT_TAB_SPACES).
//
// Every other control byte is a KEYSTROKE to the TUI, not text, so it is removed
// rather than typed: an ESC (alone or opening a sequence) interrupts the running
// turn, DEL is Backspace, Ctrl+C/Ctrl+D quit, Ctrl+U clears the composer. Escape
// sequences go first, through the shared stripper, so a pasted `ESC[31m` vanishes
// whole instead of leaving `[31m` behind once its ESC is dropped; then the
// remaining C0 controls (all but LF), DEL, and the C1 range go. The result is
// what gets typed AND what the verdict is matched against, so a steer carrying
// controls still recognizes its own transcript row.
const INJECT_CONTROL_CHARS_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

export function normalizeInjectedText(text: string): string {
	const withoutCr = text.replace(/\r\n?/g, '\n');
	return expandPromptTabs(stripAnsiCodes(withoutCr)).replace(INJECT_CONTROL_CHARS_RE, '');
}

// Ctrl+U: claude's editor clears the current line on it. quit() uses it to empty
// a composer an aborted injection left text in, before typing `/quit`.
const CLEAR_LINE_KEY = '\u0015';

// After a steering injection is typed, how long to let the composer repaint
// before reading it back (see inject()). A turn in flight repaints constantly for
// its own reasons, so a paint wait can resolve on the spinner instead of on our
// keystrokes; this fixed settle is what makes the echo check about our text.
export const INJECT_ECHO_SETTLE_MS = 150;

// Runaway guard on the raw screen capture. Run-mode steering needs the FULL
// stream retained (a differential renderer leaves nothing readable in a tail), and
// a turn measured at ~420 B/s reaches this only after several hours.
//
// Overflow TRIMS FROM THE FRONT rather than freezing the buffer, and that
// direction is the safe one, not the tidy one: a frozen buffer keeps replaying an
// OLD screen, which can still show the editor box while a permission dialog is
// really up - and that is an Enter on an approval prompt. A trimmed buffer
// replays to something with no box at all, so `editorIsAcceptingInput` returns
// false and steering refuses. Losing steering on a marathon turn is an acceptable
// degradation; granting an approval is not.
const SCREEN_CAPTURE_CAP = 8 * 1024 * 1024;
const SCREEN_CAPTURE_TRIM_TO = 4 * 1024 * 1024;

// Split `text` into pieces of at most `maxBytes` UTF-8 bytes without cutting a
// multi-byte character or surrogate pair in half.
export function chunkPromptForPty(text: string, maxBytes = PROMPT_CHUNK_MAX_BYTES): string[] {
	const chunks: string[] = [];
	let current = '';
	let currentBytes = 0;
	for (const char of text) {
		const bytes = Buffer.byteLength(char, 'utf8');
		if (currentBytes + bytes > maxBytes && current.length > 0) {
			chunks.push(current);
			current = '';
			currentBytes = 0;
		}
		current += char;
		currentBytes += bytes;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

// Rolling buffer cap for unanchored pattern matching. Large enough that a
// prompt indicator arriving across many chunks still matches; small enough
// that we don't grow without bound on long-running sessions.
const ROLLING_BUFFER_CAP = 16 * 1024;

// Unanchored: PTY data routinely arrives prefixed with \r (cursor return),
// so a ^-anchored "[›❯]\s" misses the indicator. The whitespace class also
// covers \r itself, which is what real captures look like.
const READY_REGEX = /[›❯]\s/;

// Plan-quota exhaustion banner Claude's TUI paints when the Max subscription's
// rolling 5-hour / weekly window is spent. A match makes maestro-p exit 2, which
// fires the desktop's interactive->API replay so the user's prompt is re-sent
// under `claude --print`.
//
// MUST stay tightly ANCHORED to Claude's literal banner wording. This regex is
// tested against EVERY line of rendered TUI output (see handleData), which
// includes the assistant's own prose and tool results - so any broad
// "limit + reached/hit/exceeded" match false-positives the moment the agent
// merely *discusses* limits (e.g. building Maestro's own token-mode feature copy:
// "we hit the limit of 4 cards", "when your usage limit is reached…"). A false
// positive aborts a perfectly good interactive turn and silently swaps it for an
// API replay, surfacing to the user as a no-response "dead in the water" turn.
// Robustness against Anthropic rewording is NOT worth buying with broad matching
// here; if the banner text changes, the maestro-p first-byte/idle timeouts still
// fail the turn loudly rather than dropping it. Match only the two real Max-plan
// window banners ("5-hour"/"weekly" limit reached/exceeded), Claude's exact
// "Claude [AI] usage limit reached" string, and the current banner wording
// ("You've hit your session limit - resets 11:40am (America/Chicago)").
//
// That last one is LINE-ANCHORED rather than free-floating for the same reason:
// the TUI paints the banner as its own line (box-drawing chars and padding
// allowed before it), whereas an agent discussing limits says it mid-sentence.
const LIMIT_REGEX =
	/\b(?:5-hour|weekly)\s+limit\s+(?:reached|exceeded)\b|\bClaude(?:\s+AI)?\s+usage\s+limit\s+reached\b|^[^\w]*you\s*(?:'|’)?\s*ve\s+hit\s+your\s+(?:session|weekly|5[\s-]?hour|opus|usage)\s+limit\b/i;

// Claude TUI v2.1.143+ shows a "Quick safety check: Is this a project you
// created or one you trust?" prompt on first launch in any folder, with
// `❯ 1. Yes, I trust this folder` as the highlighted default. The trust
// prompt is NOT bypassed by `--dangerously-skip-permissions` (that flag
// only governs tool-permission prompts later). The text regex below is a
// best-effort fast-path that catches the current wording; the blind-tap
// fallback (see READY_TAP_INTERVAL_MS) is what actually keeps us robust
// to text changes - Anthropic can reword the prompt or add another gate
// (terms-of-service, model picker, …) and the tap loop still unsticks us.
//
// `\s*` between words tolerates both raw output ("trust this folder")
// and ANSI-stripped output ("trustthisfolder") where cursor-positioning
// escapes have been removed without padding.
const TRUST_PROMPT_REGEX = /trust\s*this\s*folder|Yes,?\s*I\s*trust/i;

// Where the trust prompt's selector sits, for `acceptWorkspaceTrust`. claude
// 2.1.26x defaults to "No, exit" in risky locations (the home dir, the system
// temp dir) AND re-renders the dialog ~150ms after first painting it, which
// snaps a Down already sent back onto "No". A fixed Down-then-Enter either
// lands its Enter in that re-render (swallowed) or on "No" (claude quits), so
// the driver reads the selector off every repaint instead: Down while it shows
// "No", and Enter only once "Yes" has held for TRUST_CONFIRM_QUIET_MS.
const TRUST_SELECTOR_NO_REGEX = /❯\s*(?:\d+\.\s*)?No,?\s*exit/gi;
const TRUST_SELECTOR_YES_REGEX = /❯\s*(?:\d+\.\s*)?Yes,?\s*I\s*trust/gi;
export const TRUST_CONFIRM_QUIET_MS = 250;
// A Down that draws no repaint within this window is assumed lost and retried.
export const TRUST_REPAINT_WAIT_MS = 400;
// Past this many Downs the driver stops and never confirms: a dialog it cannot
// read fails the run through 'ready-timeout' instead of guessing at Enter.
export const TRUST_MAX_DOWNS = 4;

function lastMatchIndex(re: RegExp, text: string): number {
	re.lastIndex = 0;
	let at = -1;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) at = match.index;
	return at;
}

/** Which trust option the most recent paint in `text` left the selector on. */
function latestTrustSelection(text: string): 'yes' | 'no' | null {
	const no = lastMatchIndex(TRUST_SELECTOR_NO_REGEX, text);
	const yes = lastMatchIndex(TRUST_SELECTOR_YES_REGEX, text);
	if (yes > no) return 'yes';
	return no >= 0 ? 'no' : null;
}

interface TrustSelection {
	/** Stripped output since the trust prompt appeared. */
	text: string;
	downs: number;
	/** A Down went out and its repaint has not arrived yet. */
	awaitingRepaint: boolean;
	repaintTimer: ReturnType<typeof setTimeout> | null;
	confirmTimer: ReturnType<typeof setTimeout> | null;
	confirmed: boolean;
}

// Claude shows a one-time "Bypass Permissions mode" acceptance screen the first
// time the INTERACTIVE TUI is launched with `--dangerously-skip-permissions`
// (the headless `-p` path never shows it). Unlike the trust prompt, its
// highlighted default is the SAFE option - `❯ 1. No, exit` - with `2. Yes, I
// accept` below it. The text-agnostic blind-Enter fallback that unsticks every
// other startup modal therefore BACKFIRES here: pressing Enter accepts "No,
// exit" and claude quits, surfacing as `tui_exited` on the very first turn for
// any remote/config that hasn't already accepted bypass mode. So this gate
// needs the opposite of a blind Enter: move the selection DOWN to "Yes, I
// accept" first, THEN confirm. The `\s*` tolerance mirrors TRUST_PROMPT_REGEX
// (raw vs ANSI-stripped-without-padding output).
const BYPASS_PROMPT_REGEX = /Bypass\s*Permissions\s*mode|Yes,?\s*I\s*accept/i;

// Down-arrow escape sequence: moves the menu selection from the default
// `1. No, exit` to `2. Yes, I accept` before we confirm with Enter.
const ARROW_DOWN = '\x1b[B';

// Periodic blind-Enter taps that accept the highlighted default of any
// startup-blocking modal Claude renders. Text-agnostic: works for the
// trust prompt today, and for whatever Anthropic ships next without code
// changes. Pressing Enter on an empty Claude input is a no-op, so wasted
// taps in a healthy session are harmless. The budget is small and the
// total tap window (READY_MAX_TAPS × READY_TAP_INTERVAL_MS) fits inside
// READY_TIMEOUT_MS so a hung TUI fails loudly via 'ready-timeout' instead
// of spinning forever. READY_TIMEOUT_MS is only the driver's default
// ceiling; callers pass `readyTimeoutMs` to raise it.
export const READY_TAP_INTERVAL_MS = 1500;
export const READY_MAX_TAPS = 3;
export const READY_TIMEOUT_MS = 8000;

export type TuiDriverEvent =
	| 'ready'
	| 'ready-timeout'
	| 'limit-hit'
	| 'api-billing'
	| 'line'
	| 'exit'
	| 'trust-accepted'
	| 'workspace-untrusted'
	| 'bypass-accepted';

export class TuiDriver extends EventEmitter {
	private readonly options: TuiDriverOptions;
	private ptyProcess: IPty | null = null;
	private onDataDisposable: IDisposable | null = null;
	private onExitDisposable: IDisposable | null = null;

	private rollingBuffer = '';
	private lineBuffer = '';
	/** Full raw PTY accumulator for --status parsing. Populated only when options.captureScreen is set. */
	private screenCapture = '';
	/** Date.now() of the last PTY output chunk; send() waits for it to go stale. */
	private lastDataAt = 0;
	/** Resolvers waiting on the next PTY paint. See waitForPaint(). */
	private paintWaiters: Array<() => void> = [];
	private readyEmitted = false;
	private limitEmitted = false;
	private apiBillingEmitted = false;
	/** Set once send() starts typing; the billing check reads the screen only before that. */
	private inputTyped = false;
	private trustHandled = false;
	/**
	 * The trust dialog defaulted to "No, exit" and acceptWorkspaceTrust is off.
	 * Terminal: no Enter is ever written after this, since any Enter would
	 * confirm "No, exit" and claude would quit with nothing to say why.
	 */
	private workspaceUntrusted = false;
	private bypassHandled = false;
	/** Trust-prompt selection in progress (acceptWorkspaceTrust only). */
	private trustSelection: TrustSelection | null = null;
	private exited = false;
	/** Tail of the inject() chain; see inject(). */
	private injectQueue: Promise<void> = Promise.resolve();
	/**
	 * Set by beginShutdown(): the run is ending, so no new injection may start and
	 * one in flight stops before its Enter. Without it, quit()'s `/quit\r` could
	 * land in the middle of a half-typed steer and submit the two as one message.
	 */
	private shuttingDown = false;
	/**
	 * Text an injection typed into the composer and did NOT submit (aborted by a
	 * shutdown, or refused at the pre-Enter check). quit() clears it before typing
	 * `/quit`, which would otherwise be appended to it. Null when the composer
	 * holds nothing of ours.
	 */
	private unsubmittedInjection: string | null = null;
	/** inject() calls not yet settled; quit() waits only when this is non-zero. */
	private injectionsInFlight = 0;
	/** send()'s pending submit taps; see cancelSubmitRetries(). */
	private submitTapTimers: Array<ReturnType<typeof setTimeout>> = [];
	private tapsSent = 0;
	private tapTimer: ReturnType<typeof setInterval> | null = null;
	private readyTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: TuiDriverOptions) {
		super();
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.ptyProcess) {
			throw new Error('TuiDriver.start() called twice');
		}
		const { binPath, args, cwd, env, cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = this.options;
		const ptyEnv: NodeJS.ProcessEnv = {
			...env,
			TERM: 'xterm-256color',
		};
		this.ptyProcess = pty.spawn(binPath, args, {
			name: 'xterm-256color',
			cols,
			rows,
			cwd,
			env: ptyEnv as Record<string, string>,
		});
		this.onDataDisposable = this.ptyProcess.onData((data) => this.handleData(data));
		this.onExitDisposable = this.ptyProcess.onExit(({ exitCode }) => this.handleExit(exitCode));

		// Blind-tap fallback: every READY_TAP_INTERVAL_MS, if ready hasn't
		// matched yet, dispatch an Enter to accept whatever modal Claude is
		// blocking on. Capped at READY_MAX_TAPS so a TUI that ignores Enter
		// can't loop forever. Stopped on ready / exit / ready-timeout.
		this.tapTimer = setInterval(() => {
			if (this.readyEmitted || this.exited) {
				this.clearReadyTimers();
				return;
			}
			this.tryUnblockTap();
			if (this.tapsSent >= READY_MAX_TAPS && this.tapTimer) {
				clearInterval(this.tapTimer);
				this.tapTimer = null;
			}
		}, READY_TAP_INTERVAL_MS);

		// Hard ceiling. If neither READY_REGEX nor any number of blind taps
		// gets us to ready, fail loudly via 'ready-timeout' so the runner
		// finalizes with a distinguishable error instead of hanging silently.
		this.readyTimeoutTimer = setTimeout(() => {
			if (this.readyEmitted || this.exited) return;
			this.clearReadyTimers();
			this.emit('ready-timeout');
		}, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
	}

	// Shared budget for both the trust-regex fast-path and the periodic
	// tap loop. Returns true when a tap was actually written. Any path
	// that dispatches Enter as part of ready unblocking goes through here
	// so READY_MAX_TAPS is a single global cap, not per-source.
	private tryUnblockTap(): boolean {
		if (this.exited) return false;
		// Mid trust selection an Enter confirms whichever option the dialog shows
		// at that instant, and after a re-render that is "No, exit".
		if (this.isSelectingTrust()) return false;
		// The dialog is parked on "No, exit" and we are not allowed to move it.
		if (this.workspaceUntrusted) return false;
		// The bypass-permissions gate defaults to "No, exit", so a bare Enter here
		// would quit claude. Handle it with Down+Enter first; if it fired this
		// tick, that IS the unblock action - don't also send a plain Enter (which
		// would land on the now-revealed editor or, worse, re-trigger the menu).
		if (this.handleBypassPrompt()) return true;
		if (this.tapsSent >= READY_MAX_TAPS) return false;
		try {
			this.ptyProcess?.write('\r');
		} catch {
			// PTY may already be tearing down; ready timeout will surface it.
			return false;
		}
		this.tapsSent += 1;
		// Drop everything painted up to and including the modal we just
		// dismissed, so the unanchored READY_REGEX can't match the modal's own
		// selector glyph (the trust prompt renders `❯ 1. Yes, I trust this
		// folder`, whose `❯ ` satisfies `[›❯]\s`). Without this, `ready` fires
		// on the SAME data chunk that paints the modal, the runner sends the
		// prompt into the still-open modal where it's consumed as menu
		// keystrokes, the turn never starts, and the run burns its entire
		// budget waiting for JSONL that never comes. After the tap dismisses
		// the modal the genuine editor prompt re-paints `❯` into a now-empty
		// buffer, so `ready` only fires once we're actually at the input box.
		this.rollingBuffer = '';
		return true;
	}

	// Accept the one-time "Bypass Permissions mode" gate by moving the selection
	// to "2. Yes, I accept" and confirming, instead of the blind Enter that would
	// accept its "1. No, exit" default and quit claude. One-shot (bypassHandled);
	// returns true once it has driven the menu so the caller treats it as the
	// unblock action for this tick. Like the trust handler it clears the rolling
	// buffer afterward so the unanchored READY_REGEX can't match the menu's own
	// `❯ ` selector glyph and fire `ready` into the still-open dialog.
	private handleBypassPrompt(): boolean {
		if (this.exited || this.bypassHandled) return false;
		if (!BYPASS_PROMPT_REGEX.test(this.rollingBuffer)) return false;
		this.bypassHandled = true;
		try {
			this.ptyProcess?.write(ARROW_DOWN);
			// Split the confirming Enter from the Down keystroke for the same
			// reason send() splits text from its Enter (SEND_ENTER_DELAY_MS): a
			// combined write can land before the TUI registers the selection move.
			setTimeout(() => {
				if (this.exited) return;
				try {
					this.ptyProcess?.write('\r');
				} catch {
					// PTY tearing down; ready-timeout / exit will surface it.
				}
			}, SEND_ENTER_DELAY_MS);
		} catch {
			// PTY may already be tearing down; ready timeout will surface it.
			return false;
		}
		this.rollingBuffer = '';
		this.emit('bypass-accepted');
		return true;
	}

	// The trust dialog without acceptWorkspaceTrust. Enter accepts whatever the
	// selector is on, which is "Yes, I trust this folder" in an ordinary folder
	// and "No, exit" in the home and temp dirs (claude 2.1.26x+). Pressing Enter
	// on "No" quits claude and the caller only ever sees `tui_exited`, so name
	// the failure instead and leave the dialog alone: trusting a folder is the
	// user's call. Until a paint shows where the selector sits, wait - the
	// blind-tap loop is still the fallback for a reworded dialog.
	private answerTrustWithoutOptIn(): void {
		const selected = latestTrustSelection(this.rollingBuffer);
		if (selected === null) return;
		this.trustHandled = true;
		if (selected === 'no') {
			this.workspaceUntrusted = true;
			// Nothing left to unblock: the caller ends the run on this event, and a
			// later blind tap or ready-timeout would only muddy the reason.
			this.clearReadyTimers();
			this.emit('workspace-untrusted');
			return;
		}
		this.tryUnblockTap();
		this.emit('trust-accepted');
	}

	private isSelectingTrust(): boolean {
		return this.trustSelection !== null && !this.trustSelection.confirmed;
	}

	// Feed trust-dialog output to the selection (acceptWorkspaceTrust only). A
	// chunk carrying the `❯` selector is the repaint a pending Down waited for.
	private observeTrustSelection(text: string): void {
		const selection = this.trustSelection;
		if (!selection || selection.confirmed) return;
		selection.text = (selection.text + text).slice(-ROLLING_BUFFER_CAP);
		if (selection.awaitingRepaint && text.includes('❯')) {
			selection.awaitingRepaint = false;
			if (selection.repaintTimer) clearTimeout(selection.repaintTimer);
			selection.repaintTimer = null;
		}
		this.advanceTrustSelection();
	}

	// Move the selector toward "Yes, I trust this folder" and confirm it once it
	// has held. Never writes Enter while the latest paint shows "No, exit".
	private advanceTrustSelection(): void {
		const selection = this.trustSelection;
		if (!selection || selection.confirmed || selection.awaitingRepaint || this.exited) return;
		const selected = latestTrustSelection(selection.text);
		if (selected === 'no') {
			if (selection.confirmTimer) clearTimeout(selection.confirmTimer);
			selection.confirmTimer = null;
			if (selection.downs >= TRUST_MAX_DOWNS) return;
			try {
				this.ptyProcess?.write(ARROW_DOWN);
			} catch {
				return; // PTY tearing down; exit / ready-timeout will surface it.
			}
			selection.downs += 1;
			selection.awaitingRepaint = true;
			selection.repaintTimer = setTimeout(() => {
				selection.repaintTimer = null;
				selection.awaitingRepaint = false;
				this.advanceTrustSelection();
			}, TRUST_REPAINT_WAIT_MS);
		} else if (selected === 'yes') {
			// Re-armed on every chunk, so the Enter waits out a quiet window and a
			// re-render that snaps back to "No" cancels it above.
			if (selection.confirmTimer) clearTimeout(selection.confirmTimer);
			selection.confirmTimer = setTimeout(() => {
				selection.confirmTimer = null;
				if (this.exited || selection.confirmed) return;
				if (latestTrustSelection(selection.text) !== 'yes') return;
				try {
					this.ptyProcess?.write('\r');
				} catch {
					return;
				}
				selection.confirmed = true;
				// The dialog's own `❯` must not satisfy READY_REGEX afterward.
				this.rollingBuffer = '';
				this.emit('trust-accepted');
			}, TRUST_CONFIRM_QUIET_MS);
		}
	}

	private clearTrustSelectionTimers(): void {
		const selection = this.trustSelection;
		if (!selection) return;
		if (selection.repaintTimer) clearTimeout(selection.repaintTimer);
		if (selection.confirmTimer) clearTimeout(selection.confirmTimer);
		selection.repaintTimer = null;
		selection.confirmTimer = null;
	}

	private clearReadyTimers(): void {
		if (this.tapTimer) {
			clearInterval(this.tapTimer);
			this.tapTimer = null;
		}
		if (this.readyTimeoutTimer) {
			clearTimeout(this.readyTimeoutTimer);
			this.readyTimeoutTimer = null;
		}
	}

	// Wake everything waiting on evidence that claude read what we typed.
	private notifyPaint(): void {
		if (this.paintWaiters.length === 0) return;
		const waiters = this.paintWaiters;
		this.paintWaiters = [];
		for (const resolve of waiters) resolve();
	}

	// Resolves on the next PTY output chunk, or after `timeoutMs`, or at once if
	// the PTY is already gone. claude repaints its input editor as it consumes
	// typed input, so a paint after a write is our only proof the bytes left the
	// PTY input queue - which is what send() paces on. The timeout is what keeps
	// a screen that goes silent from stalling the prompt forever. Resolves true
	// for a paint (or an exit), false when the timeout ran out first.
	private waitForPaint(timeoutMs: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const done = (painted: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				// A waiter that timed out would otherwise sit in the list until
				// the next paint drains it. notifyPaint() has already swapped the
				// array out by the time it calls us, so this only ever fires on
				// the timeout path.
				const at = this.paintWaiters.indexOf(onPaint);
				if (at >= 0) this.paintWaiters.splice(at, 1);
				resolve(painted);
			};
			const onPaint = (): void => done(true);
			const timer = setTimeout(() => done(false), timeoutMs);
			this.paintWaiters.push(onPaint);
		});
	}

	// Resolves once the screen has been quiet for PROMPT_SETTLE_QUIET_MS, once
	// PROMPT_SETTLE_MAX_MS has passed, or once the PTY exits.
	private async waitForQuietScreen(): Promise<void> {
		const deadline = Date.now() + PROMPT_SETTLE_MAX_MS;
		for (;;) {
			const now = Date.now();
			const quietFor = now - this.lastDataAt;
			if (this.exited || quietFor >= PROMPT_SETTLE_QUIET_MS || now >= deadline) return;
			await new Promise<void>((resolve) =>
				setTimeout(resolve, Math.min(PROMPT_SETTLE_QUIET_MS - quietFor, deadline - now))
			);
		}
	}

	// Resolves once the whole prompt body has been typed and the Enter taps are
	// scheduled. Callers must await it before pressing Enter themselves, or a
	// tap could submit a half-typed prompt.
	async send(text: string): Promise<void> {
		const ptyProcess = this.ptyProcess;
		if (!ptyProcess) {
			throw new Error('TuiDriver.send() called before start()');
		}
		if (this.exited) return;
		// See PROMPT_SETTLE_QUIET_MS: input typed while claude is still mounting
		// its UI right after `ready` gets discarded.
		await this.waitForQuietScreen();
		if (this.exited) return;
		this.inputTyped = true;
		// Writes are split, never one chunk. See PROMPT_CHUNK_MAX_BYTES for why
		// the body is typed in paced pieces. See SEND_ENTER_DELAY_MS for why the
		// Enter cannot ride in the same write as the text body. See
		// SUBMIT_ENTER_RETRIES for why a single Enter is not enough on a cold
		// TUI: the first tap may land before claude's editor can accept a
		// submit, so we re-tap a few times spaced out until the turn starts.
		// Extra taps on an already-submitted (empty) input are no-ops.
		// See PROMPT_TAB_SPACES: a raw `\t` would be read as the Tab key.
		const chunks = chunkPromptForPty(expandPromptTabs(text));
		// Chunks written since claude last painted, i.e. possibly still unread.
		let undrained = 0;
		let stallWaitSpent = false;
		for (let i = 0; i < chunks.length; i += 1) {
			ptyProcess.write(chunks[i]);
			if (i === chunks.length - 1) break;
			undrained += 1;
			// Drain-aware pacing: hold the next chunk until claude paints (proof
			// it read this one), then honour the floor. See
			// PROMPT_CHUNK_DRAIN_TIMEOUT_MS. Ordering matters - the paint wait is
			// armed AFTER the write, so a paint still in flight from before the
			// write cannot be mistaken for this chunk's drain signal for more than
			// one chunk, and the size budget covers that one.
			// With PROMPT_MAX_UNDRAINED_CHUNKS unread, one more would let claude
			// read a paste-sized batch, so the wait becomes the long one.
			const holdForStall = undrained >= PROMPT_MAX_UNDRAINED_CHUNKS && !stallWaitSpent;
			const painted = await this.waitForPaint(
				holdForStall ? PROMPT_STALL_DRAIN_TIMEOUT_MS : PROMPT_CHUNK_DRAIN_TIMEOUT_MS
			);
			if (this.exited) return;
			if (painted) undrained = 0;
			else if (holdForStall) stallWaitSpent = true;
			await new Promise<void>((resolve) => setTimeout(resolve, PROMPT_CHUNK_INTERVAL_MS));
			if (this.exited) return;
		}
		const sendEnter = () => {
			if (this.exited) return;
			try {
				this.ptyProcess?.write('\r');
			} catch {
				// PTY may have torn down between writes; the exit/quit path will
				// surface it.
			}
		};
		for (let tap = 0; tap <= SUBMIT_ENTER_RETRIES; tap += 1) {
			this.submitTapTimers.push(
				setTimeout(sendEnter, SEND_ENTER_DELAY_MS + tap * SUBMIT_ENTER_RETRY_INTERVAL_MS)
			);
		}
	}

	/**
	 * Cancel send()'s submit taps that have not fired yet. The run-mode flow calls
	 * this the moment the turn is proven to have started (its first transcript
	 * entry), and inject() calls it before typing.
	 *
	 * The taps are harmless only while the composer is empty, and steering is
	 * exactly what makes it not empty: the steer gate opens on the first transcript
	 * entry, which on a warm TUI lands about a second in, while the taps run out to
	 * ~3s. A stray tap landing between two of a steer's paced chunks submits the
	 * first half on its own and leaves the rest in the editor.
	 */
	cancelSubmitRetries(): void {
		for (const timer of this.submitTapTimers) clearTimeout(timer);
		this.submitTapTimers = [];
	}

	/**
	 * Type `text` into a turn that is ALREADY RUNNING and submit it, so claude can
	 * fold it into the loop in flight (chat steering). Resolves with whether the
	 * text was submitted, and why not when it was not.
	 *
	 * This is deliberately NOT `send()`, and the three differences are each a
	 * hazard that `send()`'s behaviour would turn into a bug here:
	 *
	 * 1. NO `waitForQuietScreen()`. It waits for PROMPT_SETTLE_QUIET_MS of silence,
	 *    and mid-response the screen is never quiet - so it would burn the whole
	 *    PROMPT_SETTLE_MAX_MS budget and then type anyway. The settle exists to
	 *    dodge claude discarding input while its UI mounts, which is a STARTUP
	 *    problem; a turn that is streaming has long since mounted.
	 *
	 * 2. Exactly ONE Enter, never SUBMIT_ENTER_RETRIES. Extra taps are harmless on
	 *    a cold start because they land on an empty input, and dangerous here
	 *    because a dialog may be on screen: one Enter on a live permission prompt
	 *    selected "1. Yes" and wrote the file. The retry burst exists to beat a
	 *    settling editor at startup, which cannot be the situation mid-turn.
	 *
	 * 3. The screen is CHECKED, twice. Before typing, the input editor must be
	 *    drawn (`editorIsAcceptingInput`); after typing, on one fresh read, the
	 *    editor must STILL be drawn and the text must be visible inside it
	 *    (`editorShowsTypedText`) before any Enter is sent. Typing alone is inert -
	 *    measured: a live permission dialog fed "option 2 or 3 would be wrong, use
	 *    1" did not move its selector and wrote nothing - so typing first and
	 *    deciding afterwards is safe, and it catches a dialog that appeared in the
	 *    gap between the gate and the keystrokes.
	 *
	 * The paced chunking IS kept. It is not about startup: a macOS PTY holds 1,022
	 * unread input bytes and claude discards what is queued at a flush, so a
	 * multi-KB write loses whole queues whenever it happens. See
	 * PROMPT_CHUNK_MAX_BYTES.
	 *
	 * Requires `captureScreen` - without the raw stream there is no grid to check
	 * and the honest answer is to refuse rather than type blind.
	 *
	 * Injections are SERIALIZED. Two steers arriving together (two quick Steer
	 * clicks) were otherwise typed into the same editor before either Enter, and
	 * claude received one merged message - measured live, and longer texts are
	 * typed in paced chunks, so they could interleave mid-sentence. Each one waits
	 * for the previous to submit and the composer to repaint empty.
	 */
	inject(text: string): Promise<InjectOutcome> {
		this.injectionsInFlight += 1;
		const run = this.injectQueue.then(() => this.injectNow(text));
		this.injectQueue = run
			.then(
				async (outcome) => {
					if (!outcome.submitted || this.exited || this.shuttingDown) return;
					await this.waitForPaint(PROMPT_CHUNK_DRAIN_TIMEOUT_MS);
					await new Promise<void>((resolve) => setTimeout(resolve, INJECT_ECHO_SETTLE_MS));
				},
				() => undefined
			)
			.then(() => {
				this.injectionsInFlight -= 1;
			});
		return run;
	}

	/**
	 * The run is ending. From here no injection starts, and one in flight stops at
	 * its next checkpoint without pressing Enter. quit() calls this itself; the
	 * run-mode flow calls it earlier, the moment it decides to finalize, so a steer
	 * cannot be typed into a turn whose result is already being written.
	 */
	beginShutdown(): void {
		this.shuttingDown = true;
	}

	/** Resolves once every queued or in-flight injection has finished. */
	injectionsSettled(): Promise<void> {
		return this.injectQueue;
	}

	private async injectNow(text: string): Promise<InjectOutcome> {
		if (!this.ptyProcess) {
			throw new Error('TuiDriver.inject() called before start()');
		}
		if (this.exited) return { submitted: false, refusal: 'tui-exited' };
		if (this.shuttingDown) return this.shutdownRefusal();
		if (!this.options.captureScreen) {
			return {
				submitted: false,
				refusal: 'editor-unavailable',
				detail: 'the screen is not being captured, so the editor state cannot be verified',
			};
		}

		// An earlier steer that was refused after typing leaves its text in the
		// editor. Typing behind it would submit both as one message, so clear it
		// first, and refuse rather than guess if the screen says it is still there.
		if (this.unsubmittedInjection !== null && !(await this.clearUnsubmittedInjection())) {
			return {
				submitted: false,
				refusal: 'editor-unavailable',
				detail: 'text from an earlier steer is still in the editor and could not be cleared',
			};
		}

		const gate = this.readScreen();
		if (!editorIsAcceptingInput(gate)) return this.editorRefusal(gate);

		const typed = normalizeInjectedText(text);
		if (typed.replace(/\s+/g, '').length === 0) {
			// Nothing printable survived normalization (a steer of only control
			// characters or whitespace). Pressing Enter on it would report a delivery
			// of nothing, and the empty text would then match any transcript row.
			return {
				submitted: false,
				refusal: 'echo-missing',
				detail: 'the message has no printable text once control characters are removed',
			};
		}

		// The turn is running (that is what made it steerable), so a submit tap
		// send() still has pending can only land in the middle of this steer.
		this.cancelSubmitRetries();

		const chunks = chunkPromptForPty(typed);
		for (let i = 0; i < chunks.length; i += 1) {
			try {
				this.ptyProcess.write(chunks[i]);
			} catch {
				return { submitted: false, refusal: 'tui-exited' };
			}
			this.unsubmittedInjection = typed;
			if (i === chunks.length - 1) break;
			await this.waitForPaint(PROMPT_CHUNK_DRAIN_TIMEOUT_MS);
			if (this.exited) return { submitted: false, refusal: 'tui-exited' };
			await new Promise<void>((resolve) => setTimeout(resolve, PROMPT_CHUNK_INTERVAL_MS));
			if (this.exited) return { submitted: false, refusal: 'tui-exited' };
			if (this.shuttingDown) return this.shutdownRefusal();
		}

		// Let the composer repaint before reading it back. A turn in flight paints
		// constantly, so waitForPaint alone can return on the SPINNER rather than on
		// our keystrokes; the fixed settle after it is what makes the echo check
		// about the text we typed.
		await this.waitForPaint(PROMPT_CHUNK_DRAIN_TIMEOUT_MS);
		await new Promise<void>((resolve) => setTimeout(resolve, INJECT_ECHO_SETTLE_MS));
		if (this.exited) return { submitted: false, refusal: 'tui-exited' };
		if (this.shuttingDown) return this.shutdownRefusal();

		// The pre-Enter check, on ONE fresh read: the editor must STILL own the
		// keyboard, and our text must be visible INSIDE it. Both, because typing
		// takes time and the screen can change under it: a permission dialog that
		// opened mid-type replaces the editor box, and the Enter below would then
		// select its highlighted "1. Yes". The echo half is scoped to the editor
		// rows for the same reason - a short steer is usually somewhere in the
		// transcript already, which a whole-screen search would take as proof.
		//
		// Deliberately no cleanup keystroke on refusal. Ctrl+U / Escape would be a
		// guess at this point, and Escape mid-turn INTERRUPTS the turn - the one
		// outcome worse than a stray draft. The caller still owns the message.
		const beforeEnter = this.readScreen();
		if (!editorIsAcceptingInput(beforeEnter)) return this.editorRefusal(beforeEnter);
		if (!editorShowsTypedText(beforeEnter, typed)) {
			return {
				submitted: false,
				refusal: 'echo-missing',
				detail: 'the text never appeared in the editor, so it was not submitted',
			};
		}

		try {
			this.ptyProcess.write('\r');
		} catch {
			return { submitted: false, refusal: 'tui-exited' };
		}
		this.unsubmittedInjection = null;
		return { submitted: true, typed };
	}

	private editorRefusal(screen: string): InjectOutcome {
		const dialog = describeBlockingDialog(screen);
		return dialog
			? { submitted: false, refusal: 'blocking-dialog', detail: dialog }
			: {
					submitted: false,
					refusal: 'editor-unavailable',
					detail: 'the input editor is not on screen',
				};
	}

	private shutdownRefusal(): InjectOutcome {
		return {
			submitted: false,
			refusal: 'not-running',
			detail: 'the turn is ending, so the message was not submitted',
		};
	}

	/**
	 * The screen as a terminal would show it, replayed from the FULL captured
	 * stream.
	 *
	 * Replaying a tail is not an option and the measurement is unambiguous: for an
	 * 18,955-byte turn, the editor box was found in the full stream and in NO tail
	 * slice, including the last 16 KB. claude's renderer is differential - it draws
	 * the box once at startup and afterwards patches only the cells that change -
	 * so standing content exists nowhere in a recent window. This is also why the
	 * capture cannot be cleared between reads (see getScreenCapture).
	 */
	private readScreen(): string {
		return replayTerminalScreen(this.getScreenCapture());
	}

	/**
	 * Text to check for a blocking dialog, usable on EVERY run rather than only on
	 * a steering one.
	 *
	 * `describeBlockingDialog` matches dialog wording, not layout, so unlike
	 * `editorIsAcceptingInput` it does not need a replayed grid and can read the
	 * ANSI-stripped rolling buffer when no raw capture exists. That buffer is an
	 * accumulator, so a dialog dismissed long ago still matches - which
	 * OVER-detects, and that is the direction to err in for the one caller that
	 * needs this (quit(), where a miss approves something and a false alarm costs a
	 * graceful exit nobody was relying on). Never use it to decide that typing is
	 * SAFE; only that it is not.
	 */
	private dialogScreen(): string {
		return this.options.captureScreen ? this.readScreen() : this.rollingBuffer;
	}

	// Re-press Enter only (never re-type the prompt body). send()'s burst of
	// taps all land within the first ~3s; if claude's editor was still settling
	// MCP/plugin init then (morning cue contention can push that to 10-40s),
	// the parked prompt is never submitted and no turn ever starts. The run-mode
	// flow drives this on an interval until the first transcript byte lands,
	// spreading submit attempts across the whole first-byte budget. Pressing
	// Enter on an already-submitted (empty) input is a no-op, so a resubmit that
	// races a successful turn is harmless. Re-typing the text is deliberately
	// NOT done here: it would risk a double prompt if the original DID submit.
	resubmit(): void {
		if (!this.ptyProcess || this.exited) return;
		try {
			this.ptyProcess.write('\r');
		} catch {
			// PTY may already be tearing down; exit/quit path will surface it.
		}
	}

	// Last `maxBytes` of the ANSI-stripped rolling screen buffer. Used by the
	// run-mode flow to dump what was on screen at a first_byte_timeout or an
	// idle timeout (an MCP-connecting banner, a permission prompt, a modal, or
	// un-submitted prompt text) so the failure is diagnosable from stderr alone.
	getScreenTail(maxBytes = 2048): string {
		return this.rollingBuffer.slice(-maxBytes);
	}

	// Full raw PTY stream captured since start(). Empty unless options.captureScreen
	// was set. statusMode parses the /usage panel from this so cursor-addressed
	// (newline-free) panels are not lost to the `\n`-delimited 'line' stream.
	//
	// Deliberately an ACCUMULATOR with no reset, and statusMode's /usage retry
	// depends on that. A re-sent /usage appends a second panel rather than
	// replacing the first, and parseUsage anchors on the LAST `Current session`
	// header (see sliceToFinalPanel), so the newest panel is what gets read.
	// Clearing between attempts would look tidier and would break the case where
	// claude repaints differentially - only the changed cells arrive, carrying no
	// fresh section header, so a cleared buffer holds anchorless fragments that
	// parse to null. Keep the history; let the parser pick the end.
	getScreenCapture(): string {
		return this.screenCapture;
	}

	// `discardTypedInput`: the caller knows the typed prompt was never submitted.
	// `/quit` would append to it in the editor and the Enter would send
	// "<prompt>/quit" to the model, so the TUI is terminated instead.
	async quit(options: { discardTypedInput?: boolean } = {}): Promise<void> {
		if (!this.ptyProcess || this.exited) return;
		// An injection still typing must stop BEFORE `/quit` is typed, or the two
		// share one composer and claude receives "<half a steer>/quit" as a message.
		// beginShutdown() makes it bail at its next checkpoint, so the wait is short;
		// it is capped anyway, because a quit that never happens is worse.
		this.beginShutdown();
		if (this.injectionsInFlight > 0) {
			await this.waitForInjectionsToSettle(QUIT_GRACE_MS);
			if (this.exited) return;
		}
		// `/quit\r` is only safe when the input editor owns the keyboard. With a
		// permission dialog on screen the text is inert but the Enter CONFIRMS the
		// highlighted option, which is "1. Yes" - so the way out of a turn grants the
		// action the user never approved.
		//
		// Measured: a run parked on "Do you want to create probe-steer-perm.txt?" hit
		// its idle timeout at 301s; the file's mtime and the tool_result row both land
		// at the timeout instant, five minutes after the Write was requested and with
		// nobody having answered. The timeout path is the WORST place for this,
		// because it is the likeliest to have a dialog up - maestro-p's own timeout
		// message already says "likely parked on a permission prompt".
		//
		// So skip the graceful quit and let the SIGTERM below do it. Biased on
		// purpose: a false positive costs a graceful `/quit` we were abandoning the
		// turn without anyway, while a false negative approves a filesystem write, a
		// command, or a push.
		let skipQuit =
			this.dialogBlockingQuit() || (options.discardTypedInput === true && this.inputTyped);
		if (!skipQuit && this.unsubmittedInjection !== null) {
			// An injection was cut off (by this shutdown, or refused before its Enter)
			// and its text is still in the composer, where `/quit` would be appended to
			// it and submitted as one message. Clear it first; if it will not clear,
			// terminate instead - the same trade as the dialog case. Clearing takes a
			// repaint, so the dialog check is made again on the screen after it.
			if (!(await this.clearUnsubmittedInjection())) {
				process.stderr.write(
					'maestro-p: not sending /quit - an unsent steer is still in the composer. Terminating the TUI instead.\n'
				);
				skipQuit = true;
			} else {
				skipQuit = this.exited || this.dialogBlockingQuit();
			}
		}
		if (!skipQuit) {
			try {
				this.ptyProcess.write('/quit\r');
			} catch {
				// PTY may already be tearing down - fall through to the grace timer.
			}
		}
		await new Promise<void>((resolve) => {
			if (this.exited) {
				resolve();
				return;
			}
			let settled = false;
			const onExit = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.off('exit', onExit);
				try {
					// killPty, not ptyProcess.kill('SIGTERM'): node-pty's Windows
					// backend throws for ANY signal, and it throws from a deferred
					// flushed on a socket event, so this catch would not contain it.
					if (this.ptyProcess) killPty(this.ptyProcess, 'SIGTERM');
				} catch {
					// PTY may already be gone; nothing to escalate against.
				}
				resolve();
			}, QUIT_GRACE_MS);
			this.once('exit', onExit);
		});
	}

	/** True (and says why on stderr) when a dialog on screen makes `/quit\r` unsafe. */
	private dialogBlockingQuit(): boolean {
		const dialog = describeBlockingDialog(this.dialogScreen());
		if (!dialog) return false;
		process.stderr.write(
			`maestro-p: not sending /quit - ${dialog} is on screen and its Enter would accept it. Terminating the TUI instead.\n`
		);
		return true;
	}

	private async waitForInjectionsToSettle(maxMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | null = null;
		await Promise.race([
			this.injectQueue,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, maxMs);
			}),
		]);
		if (timer) clearTimeout(timer);
	}

	/**
	 * Empty a composer an aborted injection left text in. Resolves true when the
	 * composer is (now) free of our text, false when it still shows it - in which
	 * case quit() must not type `/quit`.
	 *
	 * Ctrl+U clears the current line; it is sent generously (twice per logical
	 * line, so a press that only joins a line onto the one above is covered) since
	 * a surplus press on an empty composer does nothing. Whether it worked is then
	 * READ OFF THE SCREEN rather than assumed: an injection only ever types with
	 * the raw capture on, so the grid is always there to check.
	 */
	private async clearUnsubmittedInjection(): Promise<boolean> {
		const leftover = this.unsubmittedInjection;
		if (leftover === null) return true;
		const presses = leftover.split('\n').length * 2;
		try {
			this.ptyProcess?.write(CLEAR_LINE_KEY.repeat(presses));
		} catch {
			return false;
		}
		await this.waitForPaint(PROMPT_CHUNK_DRAIN_TIMEOUT_MS);
		await new Promise<void>((resolve) => setTimeout(resolve, INJECT_ECHO_SETTLE_MS));
		if (this.exited) return false;
		if (this.options.captureScreen && editorShowsTypedText(this.readScreen(), leftover)) {
			return false;
		}
		this.unsubmittedInjection = null;
		return true;
	}

	// SIGTERM lets claude shut down its MCP servers; SIGKILL is the hard stop.
	kill(signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL'): void {
		if (!this.ptyProcess || this.exited) return;
		try {
			killPty(this.ptyProcess, signal);
		} catch {
			// Already gone - nothing to do.
		}
	}

	private handleData(data: string): void {
		if (this.exited) return;
		this.lastDataAt = Date.now();
		// Any output at all counts as a paint, including chunks that strip to
		// nothing (a bare cursor move is still claude redrawing after a read).
		this.notifyPaint();
		// --status capture: keep the full raw stream so statusMode can parse the
		// /usage panel from the complete screen. Cursor-addressed panels carry no
		// line feeds, so the 'line' events below never fire and only this buffer
		// holds the panel content. Run mode leaves captureScreen unset.
		if (this.options.captureScreen) {
			this.screenCapture += data;
			if (this.screenCapture.length > SCREEN_CAPTURE_CAP) {
				this.screenCapture = this.screenCapture.slice(-SCREEN_CAPTURE_TRIM_TO);
			}
		}
		const stripped = stripAnsiCodes(data);
		if (stripped.length === 0) return;

		this.rollingBuffer += stripped;
		if (this.rollingBuffer.length > ROLLING_BUFFER_CAP) {
			this.rollingBuffer = this.rollingBuffer.slice(-ROLLING_BUFFER_CAP);
		}
		// Billing mode is read off the startup header only. Once input is typed the
		// screen carries the prompt and then the reply, and either can quote the
		// header text.
		if (!this.apiBillingEmitted && !this.inputTyped && showsApiUsageBilling(this.rollingBuffer)) {
			this.apiBillingEmitted = true;
			this.emit('api-billing');
		}
		// Trust-prompt auto-accept is a fast-path optimization: when the
		// current wording matches, we send Enter immediately rather than
		// waiting up to READY_TAP_INTERVAL_MS for the periodic tap. The
		// blind-tap loop in start() is the actual contract - this regex
		// can go stale the moment Anthropic rewords the prompt.
		// Bypass-permissions gate first: it needs Down+Enter, not the blind Enter
		// the trust/ready paths use. Run it on the painting chunk so we select
		// "Yes, I accept" before the periodic blind-tap can hit the "No, exit"
		// default (which would quit claude -> tui_exited).
		this.handleBypassPrompt();
		if (this.isSelectingTrust()) {
			this.observeTrustSelection(stripped);
		} else if (!this.trustHandled && TRUST_PROMPT_REGEX.test(this.rollingBuffer)) {
			if (this.options.acceptWorkspaceTrust) {
				this.trustHandled = true;
				this.trustSelection = {
					text: '',
					downs: 0,
					awaitingRepaint: false,
					repaintTimer: null,
					confirmTimer: null,
					confirmed: false,
				};
				this.observeTrustSelection(this.rollingBuffer);
			} else {
				this.answerTrustWithoutOptIn();
			}
		}
		// While the trust dialog is still being answered, its `❯` selector is not
		// the input prompt. Nor is it once the dialog is parked on "No, exit".
		if (
			!this.readyEmitted &&
			!this.workspaceUntrusted &&
			!this.isSelectingTrust() &&
			READY_REGEX.test(this.rollingBuffer)
		) {
			this.readyEmitted = true;
			this.clearReadyTimers();
			this.emit('ready');
		}

		this.lineBuffer += stripped;
		let nlIndex = this.lineBuffer.indexOf('\n');
		while (nlIndex >= 0) {
			const line = this.lineBuffer.slice(0, nlIndex);
			this.lineBuffer = this.lineBuffer.slice(nlIndex + 1);
			this.emit('line', line);
			if (!this.limitEmitted && LIMIT_REGEX.test(line)) {
				this.limitEmitted = true;
				this.emit('limit-hit', line);
			}
			nlIndex = this.lineBuffer.indexOf('\n');
		}
	}

	private handleExit(exitCode: number): void {
		if (this.exited) return;
		this.exited = true;
		// Release a send() parked on a paint that will never come, so it unwinds
		// on the exit rather than sitting out its drain timeout.
		this.notifyPaint();
		this.clearReadyTimers();
		this.clearTrustSelectionTimers();
		this.cancelSubmitRetries();
		// Flush any trailing partial line so consumers (notably the /usage
		// panel parser in --status mode) don't lose the last row.
		if (this.lineBuffer.length > 0) {
			const tail = this.lineBuffer;
			this.lineBuffer = '';
			this.emit('line', tail);
		}
		this.onDataDisposable?.dispose();
		this.onExitDisposable?.dispose();
		this.onDataDisposable = null;
		this.onExitDisposable = null;
		this.emit('exit', exitCode);
	}
}
