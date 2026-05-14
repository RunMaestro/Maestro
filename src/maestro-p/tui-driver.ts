// TUI driver core — spawns `claude` in a pseudoterminal and translates the
// interactive screen-redraw stream into discrete lifecycle events that the
// maestro-p wrapper turns into stream-json upstream.
//
// Phase 1 task 3 responsibilities:
//   - Spawn claude via node-pty with a generous viewport so terminal wrapping
//     does not fragment the lines we want to scrape.
//   - ANSI-strip every chunk, split on newlines, classify each completed line
//     as spinner / limit-hit / regular content.
//   - Maintain a rolling buffer of the last 16 non-spinner lines so we can
//     detect the `›` input-prompt indicator at completion time.
//   - When the spinner pattern has been silent for SPINNER_IDLE_MS *and* the
//     prompt indicator is visible, emit `spinner-stop` then `ready`. That pair
//     is the completion signal the wrapper hands off as `result`.
//
// Why a class with EventEmitter (rather than a callback config or async
// iterator): the wiring task in index.ts cares about a small set of lifecycle
// events plus one streaming event (`line`). Listeners compose more cleanly
// than callback soup, and EventEmitter's once() makes the quit/exit race in
// quit() trivial to express.

import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

import { stripAnsiCodes } from '../shared/stringUtils';

// The verb in front of claude's spinner changes per release ("Pouncing…",
// "Crunching…", "Pondering…", etc.), so we anchor on the durable parenthesized
// status fragment instead. Direction arrow is ↑ or ↓ (input vs. output flow).
const SPINNER_PATTERN = /\(\d+s\s*·\s*[↑↓]\s*\d+\s*tokens\s*·\s*\w+\)/;

// Both 5-hour and weekly quota messages — wording varies ("reached" vs.
// "exceeded"). index.ts maps this event to wrapper exit code 2 in a later task.
const LIMIT_HIT_PATTERN = /(5-hour|weekly)\s+limit\s+(reached|exceeded)/i;

// Claude's interactive input prompt sits at column 0 as a Unicode chevron
// followed by a space. claude 2.1.141 (captured 2026-05-13 from both
// .claude-gmail and .claude-smash via scripts/capture-usage-fixture.mjs) uses
// `❯ ` (U+276F HEAVY RIGHT-POINTING ANGLE-BRACKET ORNAMENT). The original
// playbook documented `› ` (U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION
// MARK) — accept either so a future claude reverting wouldn't break us.
const PROMPT_INDICATOR_PATTERN = /^[›❯]\s/;

const SPINNER_IDLE_MS = 800;
const QUIT_GRACE_MS = 2000;
const ROLLING_BUFFER_SIZE = 16;
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;

export interface TuiDriverConfig {
	binPath: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
}

// Emitted events (untyped on EventEmitter, documented here):
//   'line'          (line: string)        — ANSI-stripped completed text line, excludes spinner status
//   'spinner-start' ()                    — spinner pattern first observed in the current cycle
//   'spinner-stop'  ()                    — spinner has been idle SPINNER_IDLE_MS AND prompt is visible
//   'limit-hit'     (line: string)        — line matched the 5-hour/weekly quota pattern
//   'ready'         ()                    — input prompt indicator is visible (paired with spinner-stop
//                                            after a generation cycle, or solo on fresh startup)
//   'exit'          (exitCode: number)    — underlying pty process exited
export class TuiDriver extends EventEmitter {
	private readonly config: TuiDriverConfig;
	private process: IPty | null = null;
	// Holds the partial line at the tail of the last chunk — emitted only when
	// terminated by a newline. Without this, a chunk split mid-line would
	// fragment into two false "line" events.
	private residual = '';
	private rollingBuffer: string[] = [];
	private spinnerStarted = false;
	private spinnerIdle = false;
	private spinnerIdleTimer: NodeJS.Timeout | null = null;
	private readyEmitted = false;
	private exited = false;

	constructor(config: TuiDriverConfig) {
		super();
		this.config = config;
	}

	async start(): Promise<void> {
		const env: NodeJS.ProcessEnv = { ...this.config.env, TERM: 'xterm-256color' };
		this.process = pty.spawn(this.config.binPath, this.config.args, {
			name: 'xterm-256color',
			cols: this.config.cols ?? DEFAULT_COLS,
			rows: this.config.rows ?? DEFAULT_ROWS,
			cwd: this.config.cwd,
			env: env as Record<string, string>,
		});

		this.process.onData((chunk) => this.handleChunk(chunk));
		this.process.onExit(({ exitCode }) => this.handleExit(exitCode));
	}

	send(text: string): void {
		if (!this.process) {
			throw new Error('TuiDriver: cannot send() before start()');
		}
		this.process.write(`${text}\r`);
	}

	async quit(): Promise<void> {
		if (!this.process || this.exited) {
			return;
		}
		this.process.write('/quit\r');

		return new Promise<void>((resolve) => {
			let resolved = false;
			let timer: NodeJS.Timeout | null = null;

			const finish = () => {
				if (resolved) return;
				resolved = true;
				if (timer) clearTimeout(timer);
				this.off('exit', onExit);
				resolve();
			};

			const onExit = () => finish();

			timer = setTimeout(() => {
				if (!this.exited && this.process) {
					try {
						this.process.kill('SIGTERM');
					} catch {
						// Race: process exited between our exited-check and the
						// kill call. Falling through to resolve is correct.
					}
				}
				finish();
			}, QUIT_GRACE_MS);

			this.once('exit', onExit);
		});
	}

	kill(): void {
		if (!this.process || this.exited) {
			return;
		}
		try {
			this.process.kill('SIGKILL');
		} catch {
			// Already exited — nothing to do.
		}
	}

	private handleExit(exitCode: number): void {
		this.exited = true;
		if (this.spinnerIdleTimer) {
			clearTimeout(this.spinnerIdleTimer);
			this.spinnerIdleTimer = null;
		}
		this.emit('exit', exitCode);
	}

	private handleChunk(chunk: string): void {
		const stripped = stripAnsiCodes(chunk);
		this.residual += stripped;

		const segments = this.residual.split('\n');
		this.residual = segments.pop() ?? '';

		for (const rawLine of segments) {
			// Carriage returns can survive ANSI-stripping when the TUI writes
			// `\r\n` line endings. Drop a trailing \r so downstream regexes
			// don't see a phantom character.
			const line = rawLine.replace(/\r$/, '');
			this.processLine(line);
		}
	}

	private processLine(line: string): void {
		if (SPINNER_PATTERN.test(line)) {
			if (!this.spinnerStarted) {
				this.spinnerStarted = true;
				this.spinnerIdle = false;
				// A new generation cycle starts — un-latch readyEmitted so the
				// paired spinner-stop / ready transition can fire again when
				// this cycle completes.
				this.readyEmitted = false;
				this.emit('spinner-start');
			}
			this.refreshSpinnerIdleTimer();
			// Spinner lines are status, not content — do not emit as 'line'
			// and do not pollute the rolling buffer (they would push the
			// prompt-indicator line out of the 16-line window).
			return;
		}

		this.rollingBuffer.push(line);
		if (this.rollingBuffer.length > ROLLING_BUFFER_SIZE) {
			this.rollingBuffer.shift();
		}

		if (LIMIT_HIT_PATTERN.test(line)) {
			this.emit('limit-hit', line);
		}

		this.emit('line', line);

		this.maybeEmitReady();
	}

	private refreshSpinnerIdleTimer(): void {
		if (this.spinnerIdleTimer) {
			clearTimeout(this.spinnerIdleTimer);
		}
		this.spinnerIdleTimer = setTimeout(() => {
			this.spinnerIdleTimer = null;
			this.spinnerIdle = true;
			this.maybeEmitReady();
		}, SPINNER_IDLE_MS);
	}

	private maybeEmitReady(): void {
		const promptVisible = this.rollingBuffer.some((line) => PROMPT_INDICATOR_PATTERN.test(line));
		if (!promptVisible) {
			return;
		}

		if (this.spinnerStarted && this.spinnerIdle) {
			// Generation cycle finished AND prompt is back — the completion
			// transition. Pair the two events so callers can treat them as
			// one atomic state change.
			this.spinnerStarted = false;
			this.spinnerIdle = false;
			this.emit('spinner-stop');
			this.emit('ready');
			this.readyEmitted = true;
			return;
		}

		if (!this.spinnerStarted && !this.readyEmitted) {
			// Fresh TUI startup: prompt visible before any spinner has fired.
			// Emit ready once; subsequent prompt-indicator lines in the same
			// idle window are deduped by readyEmitted.
			this.emit('ready');
			this.readyEmitted = true;
		}
	}
}
