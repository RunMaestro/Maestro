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
//
// Explicitly NOT implemented: spinner regexes, completion-via-spinner-stop,
// 'ready' re-firing after each response. Completion in run mode is the
// JSONL tailer's responsibility (stop_reason === 'end_turn').

import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { IDisposable, IPty } from 'node-pty';

import { stripAnsiCodes } from '../shared/stringUtils';

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
// window banners ("5-hour"/"weekly" limit reached/exceeded) and Claude's exact
// "Claude [AI] usage limit reached" string.
const LIMIT_REGEX =
	/\b(?:5-hour|weekly)\s+limit\s+(?:reached|exceeded)\b|\bClaude(?:\s+AI)?\s+usage\s+limit\s+reached\b/i;

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
// of spinning forever.
export const READY_TAP_INTERVAL_MS = 1500;
export const READY_MAX_TAPS = 3;
export const READY_TIMEOUT_MS = 8000;

export type TuiDriverEvent =
	| 'ready'
	| 'ready-timeout'
	| 'limit-hit'
	| 'line'
	| 'exit'
	| 'trust-accepted'
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
	private readyEmitted = false;
	private limitEmitted = false;
	private trustHandled = false;
	private bypassHandled = false;
	private exited = false;
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
		}, READY_TIMEOUT_MS);
	}

	// Shared budget for both the trust-regex fast-path and the periodic
	// tap loop. Returns true when a tap was actually written. Any path
	// that dispatches Enter as part of ready unblocking goes through here
	// so READY_MAX_TAPS is a single global cap, not per-source.
	private tryUnblockTap(): boolean {
		if (this.exited) return false;
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

	send(text: string): void {
		if (!this.ptyProcess) {
			throw new Error('TuiDriver.send() called before start()');
		}
		if (this.exited) return;
		// Writes are split, never one chunk. See SEND_ENTER_DELAY_MS for why the
		// Enter cannot ride in the same write as the text body. See
		// SUBMIT_ENTER_RETRIES for why a single Enter is not enough on a cold
		// TUI: the first tap may land before claude's editor can accept a
		// submit, so we re-tap a few times spaced out until the turn starts.
		// Extra taps on an already-submitted (empty) input are no-ops.
		this.ptyProcess.write(text);
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
			setTimeout(sendEnter, SEND_ENTER_DELAY_MS + tap * SUBMIT_ENTER_RETRY_INTERVAL_MS);
		}
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
	// run-mode flow to dump what was on screen at a first_byte_timeout (an
	// MCP-connecting banner, a modal, or un-submitted prompt text) so the
	// failure is diagnosable from stderr alone.
	getScreenTail(maxBytes = 2048): string {
		return this.rollingBuffer.slice(-maxBytes);
	}

	// Full raw PTY stream captured since start(). Empty unless options.captureScreen
	// was set. statusMode parses the /usage panel from this so cursor-addressed
	// (newline-free) panels are not lost to the `\n`-delimited 'line' stream.
	getScreenCapture(): string {
		return this.screenCapture;
	}

	async quit(): Promise<void> {
		if (!this.ptyProcess || this.exited) return;
		try {
			this.ptyProcess.write('/quit\r');
		} catch {
			// PTY may already be tearing down - fall through to the grace timer.
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
					this.ptyProcess?.kill('SIGTERM');
				} catch {
					// PTY may already be gone; nothing to escalate against.
				}
				resolve();
			}, QUIT_GRACE_MS);
			this.once('exit', onExit);
		});
	}

	kill(): void {
		if (!this.ptyProcess || this.exited) return;
		try {
			this.ptyProcess.kill('SIGKILL');
		} catch {
			// Already gone - nothing to do.
		}
	}

	private handleData(data: string): void {
		if (this.exited) return;
		// --status capture: keep the full raw stream so statusMode can parse the
		// /usage panel from the complete screen. Cursor-addressed panels carry no
		// line feeds, so the 'line' events below never fire and only this buffer
		// holds the panel content. Run mode leaves captureScreen unset.
		if (this.options.captureScreen) {
			this.screenCapture += data;
		}
		const stripped = stripAnsiCodes(data);
		if (stripped.length === 0) return;

		this.rollingBuffer += stripped;
		if (this.rollingBuffer.length > ROLLING_BUFFER_CAP) {
			this.rollingBuffer = this.rollingBuffer.slice(-ROLLING_BUFFER_CAP);
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
		if (!this.trustHandled && TRUST_PROMPT_REGEX.test(this.rollingBuffer)) {
			this.trustHandled = true;
			this.tryUnblockTap();
			this.emit('trust-accepted');
		}
		if (!this.readyEmitted && READY_REGEX.test(this.rollingBuffer)) {
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
		this.clearReadyTimers();
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
