// Slim TUI driver for maestro-p.
//
// Spawns the Claude CLI under a PTY and exposes a minimal event stream the
// run-mode flow can consume. By design this module is NOT the source of
// truth for assistant output — that comes from the structured JSONL
// transcript Claude writes alongside its TUI. The driver's only jobs
// post-startup are:
//
//   1. Signal startup readiness once the input prompt indicator (› or ❯)
//      first appears in the ANSI-stripped rolling buffer. The indicator is
//      detected with an UNANCHORED regex because PTY output routinely
//      prepends \r cursor returns, so ^-anchored line matching misses it.
//   2. Detect quota-limit messages on the screen. This is the one signal
//      the JSONL doesn't carry — Claude emits the limit text only to its
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

// Rolling buffer cap for unanchored pattern matching. Large enough that a
// prompt indicator arriving across many chunks still matches; small enough
// that we don't grow without bound on long-running sessions.
const ROLLING_BUFFER_CAP = 16 * 1024;

// Unanchored: PTY data routinely arrives prefixed with \r (cursor return),
// so a ^-anchored "[›❯]\s" misses the indicator. The whitespace class also
// covers \r itself, which is what real captures look like.
const READY_REGEX = /[›❯]\s/;

// Matches both "5-hour limit reached/exceeded" and "weekly limit reached/exceeded".
const LIMIT_REGEX = /(5-hour|weekly)\s+limit\s+(reached|exceeded)/i;

// Claude TUI v2.1.143+ shows a "Quick safety check: Is this a project you
// created or one you trust?" prompt on first launch in any folder, with
// `❯ 1. Yes, I trust this folder` as the highlighted default. The trust
// prompt is NOT bypassed by `--dangerously-skip-permissions` (that flag
// only governs tool-permission prompts later). The text regex below is a
// best-effort fast-path that catches the current wording; the blind-tap
// fallback (see READY_TAP_INTERVAL_MS) is what actually keeps us robust
// to text changes — Anthropic can reword the prompt or add another gate
// (terms-of-service, model picker, …) and the tap loop still unsticks us.
//
// `\s*` between words tolerates both raw output ("trust this folder")
// and ANSI-stripped output ("trustthisfolder") where cursor-positioning
// escapes have been removed without padding.
const TRUST_PROMPT_REGEX = /trust\s*this\s*folder|Yes,?\s*I\s*trust/i;

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
	| 'trust-accepted';

export class TuiDriver extends EventEmitter {
	private readonly options: TuiDriverOptions;
	private ptyProcess: IPty | null = null;
	private onDataDisposable: IDisposable | null = null;
	private onExitDisposable: IDisposable | null = null;

	private rollingBuffer = '';
	private lineBuffer = '';
	private readyEmitted = false;
	private limitEmitted = false;
	private trustHandled = false;
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
		if (this.tapsSent >= READY_MAX_TAPS) return false;
		try {
			this.ptyProcess?.write('\r');
		} catch {
			// PTY may already be tearing down; ready timeout will surface it.
			return false;
		}
		this.tapsSent += 1;
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
		// Two writes, not one. See SEND_ENTER_DELAY_MS for the full reason —
		// claude's multi-line input editor swallows a trailing \r as a literal
		// newline when it arrives in the same chunk as the text body, leaving
		// the prompt parked unsubmitted and the watchdog timing out 5 minutes
		// later with the unsent prompt + any subsequent /quit concatenated in
		// the input field.
		this.ptyProcess.write(text);
		setTimeout(() => {
			if (this.exited) return;
			try {
				this.ptyProcess?.write('\r');
			} catch {
				// PTY may have torn down between writes; the exit/quit path will
				// surface it.
			}
		}, SEND_ENTER_DELAY_MS);
	}

	async quit(): Promise<void> {
		if (!this.ptyProcess || this.exited) return;
		try {
			this.ptyProcess.write('/quit\r');
		} catch {
			// PTY may already be tearing down — fall through to the grace timer.
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
			// Already gone — nothing to do.
		}
	}

	private handleData(data: string): void {
		if (this.exited) return;
		const stripped = stripAnsiCodes(data);
		if (stripped.length === 0) return;

		this.rollingBuffer += stripped;
		if (this.rollingBuffer.length > ROLLING_BUFFER_CAP) {
			this.rollingBuffer = this.rollingBuffer.slice(-ROLLING_BUFFER_CAP);
		}
		// Trust-prompt auto-accept is a fast-path optimization: when the
		// current wording matches, we send Enter immediately rather than
		// waiting up to READY_TAP_INTERVAL_MS for the periodic tap. The
		// blind-tap loop in start() is the actual contract — this regex
		// can go stale the moment Anthropic rewords the prompt.
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
