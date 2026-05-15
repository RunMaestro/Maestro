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

export type TuiDriverEvent = 'ready' | 'limit-hit' | 'line' | 'exit';

export class TuiDriver extends EventEmitter {
	private readonly options: TuiDriverOptions;
	private ptyProcess: IPty | null = null;
	private onDataDisposable: IDisposable | null = null;
	private onExitDisposable: IDisposable | null = null;

	private rollingBuffer = '';
	private lineBuffer = '';
	private readyEmitted = false;
	private limitEmitted = false;
	private exited = false;

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
	}

	send(text: string): void {
		if (!this.ptyProcess) {
			throw new Error('TuiDriver.send() called before start()');
		}
		if (this.exited) return;
		this.ptyProcess.write(`${text}\r`);
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
		if (!this.readyEmitted && READY_REGEX.test(this.rollingBuffer)) {
			this.readyEmitted = true;
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
