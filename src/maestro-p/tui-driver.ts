// TUI driver core — spawns `claude` in a pseudoterminal and exposes the
// minimum lifecycle events the maestro-p wrapper still needs after the
// jsonl-tail rewrite: a `line` stream (used by run-status's quiescence
// detection), a one-shot `ready` signal when the input prompt indicator
// first appears (so we know claude is accepting input), `limit-hit` for
// quota messages, and `exit`.
//
// Previously the driver also tracked claude's spinner pattern to emit
// `spinner-start` / `spinner-stop` as completion markers. That path is
// gone — run mode now finalizes based on `stop_reason: end_turn` in the
// session jsonl, which is robust against the TUI rendering changes that
// kept invalidating the spinner regex.
//
// Why a class with EventEmitter: the wiring code in index.ts cares about
// a small set of lifecycle events plus one streaming event. Listeners
// compose more cleanly than callback soup, and EventEmitter's once()
// makes the quit/exit race trivial to express.

import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

import { stripAnsiCodes } from '../shared/stringUtils';

// Both 5-hour and weekly quota messages — wording varies ("reached" vs.
// "exceeded"). index.ts maps this event to wrapper exit code 2, which
// Maestro uses to auto-fall-back to api mode.
const LIMIT_HIT_PATTERN = /(5-hour|weekly)\s+limit\s+(reached|exceeded)/i;

// Claude's interactive input prompt sits at column 0 as a Unicode chevron
// followed by a space. claude 2.1.141 uses `❯ ` (U+276F HEAVY RIGHT-
// POINTING ANGLE-BRACKET ORNAMENT). The original playbook documented `› `
// (U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK) — accept either so
// a future claude reverting wouldn't break us. Used only for startup
// readiness; the post-response prompt-indicator detection that the
// previous design relied on was unreliable (lines arrived with leading
// `\r`) and is no longer load-bearing.
const PROMPT_INDICATOR_PATTERN = /^[›❯]\s/;

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
//   'line'      (line: string)     — ANSI-stripped completed text line
//   'limit-hit' (line: string)     — line matched the 5-hour/weekly quota pattern
//   'ready'     ()                 — input prompt indicator first observed; fires once
//   'exit'      (exitCode: number) — underlying pty process exited
export class TuiDriver extends EventEmitter {
	private readonly config: TuiDriverConfig;
	private process: IPty | null = null;
	// Holds the partial line at the tail of the last chunk — emitted only when
	// terminated by a newline. Without this, a chunk split mid-line would
	// fragment into two false "line" events.
	private residual = '';
	private rollingBuffer: string[] = [];
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
		this.rollingBuffer.push(line);
		if (this.rollingBuffer.length > ROLLING_BUFFER_SIZE) {
			this.rollingBuffer.shift();
		}

		if (LIMIT_HIT_PATTERN.test(line)) {
			this.emit('limit-hit', line);
		}

		this.emit('line', line);

		// Fire `ready` once when the input prompt indicator first appears in
		// the rolling buffer. Used by callers to know claude is up and
		// accepting input. Deduped via readyEmitted so subsequent prompt
		// lines (which arrive on every redraw) don't spam the event.
		if (!this.readyEmitted && this.rollingBuffer.some((l) => PROMPT_INDICATOR_PATTERN.test(l))) {
			this.readyEmitted = true;
			this.emit('ready');
		}
	}
}
