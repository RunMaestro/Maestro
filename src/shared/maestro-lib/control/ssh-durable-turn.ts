/**
 * SSH turns that survive a lost link ("Keep turns running when the connection
 * drops", a per-remote switch that is off by default).
 *
 * ## Why
 *
 * A normal SSH turn `exec`s the agent at the end of its stdin script, so the
 * agent's stdout and stderr ARE the ssh channel. When the link drops, the turn
 * settles with exit 255 and the remote agent is reaped: a live agent nobody
 * reads is a second writer on the session.
 *
 * ## How
 *
 * The durable launch does not rewrite today's script. It wraps it. The
 * envelope saves the rest of its stdin (today's whole script and prompt,
 * byte for byte) to `<dir>/in`, runs it under a second bash with stdout and
 * stderr in `<dir>/out` and `<dir>/err`, and streams both files back to the
 * channel. Today's pid record runs inside that bash, so it still names the
 * agent and today's Stop, interrupt and reap reach it unchanged. `set -m`
 * puts the agent in its own process group, as sshd did before.
 *
 * The agent's parent is a supervisor that holds no channel descriptor. It
 * survives the link and a group kill, and writes the agent's exit code to
 * `<dir>/exit`. When the link drops, this machine runs a reattach script that
 * streams the files from the byte offsets it has already received, so the
 * output parsers see one continuous stream. A stream ends only after a full
 * pass that began with `<dir>/exit` present, so every byte is drained, and the
 * script then exits with the recorded code.
 *
 * The remote never deletes `<dir>` itself: only this machine knows when the
 * last bytes arrived. `buildRemoteTurnCleanupScript()` removes it after
 * the turn settles, and each durable launch sweeps finished dirs older than a
 * day that a crash left behind.
 *
 * Only POSIX tools are used (`cat`, `wc -c`, `tail -c`, `head -c`, `ps`,
 * `kill -0`, `sleep`), and bash, which every SSH spawn already requires.
 */

import type { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { shellEscape } from '../launch/shell-escape';
import type { TurnExit } from '../run/start-turn';
import {
	assertRemoteTurnDir,
	REMOTE_REAP_RETRY_DELAYS_MS,
	SSH_STDIN_REMOTE_SHELL,
} from './ssh-remote-signal';

/**
 * What a reattach exits with when the remote proves the turn is gone: no
 * turn dir, or no exit file while neither the agent nor its supervisor lives.
 */
export const DURABLE_TURN_GONE_EXIT_CODE = 249;

/** How long the stream loop waits when neither file grew. */
const STREAM_POLL_SECONDS = '0.2';

/** Finished turn dirs older than this are swept by the next durable launch. */
const TURN_DIR_MAX_AGE_MIN = 24 * 60;

const PID_FILE_PATTERN = /^\/tmp\/maestro-agent-[0-9a-f-]{36}\.pid$/;

/*
 * The remote side frames everything it writes to stderr, so this machine can
 * tell the agent's stderr from ssh's own messages (a host-key warning at
 * connect, "Broken pipe" at a drop) and count the agent's bytes exactly.
 * stdout is never framed: it is the agent's stdout, byte for byte.
 *
 *   RS 'S' LF                 the agent runs (launch) or still runs (reattach)
 *   RS 'D' <len> LF <len bytes> US   that many bytes of the agent's stderr
 *   RS 'E' <code> LF          the agent ended with <code>; every byte was sent
 *   RS 'G' LF                 the turn is gone (reattach only)
 *
 * A data frame cut by a drop is discarded whole and sent again by the
 * reattach, which starts from the last complete frame.
 */
const RS = 0x1e;
const US = 0x1f;
const LF = 0x0a;

function assertOffset(offset: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid remote turn offset.');
}

/**
 * The loop that copies `<dir>/out` to stdout and `<dir>/err` (framed) to
 * stderr from byte offsets `outOffset` and `errOffset`, then sends the end
 * frame and exits with the recorded code. Each pass notes whether the exit
 * file exists BEFORE it copies, so the pass that ends the loop copied
 * everything the agent wrote.
 */
function streamLoop(outOffset: number, errOffset: number): string[] {
	assertOffset(outOffset);
	assertOffset(errOffset);
	return [
		`o=${outOffset}; e=${errOffset}`,
		'while :; do',
		'  f=0; [ -e "$d/exit" ] && f=1',
		'  m=0',
		'  n=$(wc -c < "$d/out" 2>/dev/null) || n=$o; n=$((n+0))',
		// A copy that cannot write means the channel is gone: a stale loop
		// must not outlive its link.
		'  if [ "$n" -gt "$o" ]; then tail -c +$((o+1)) "$d/out" | head -c $((n-o)) || exit 1; o=$n; m=1; fi',
		'  n=$(wc -c < "$d/err" 2>/dev/null) || n=$e; n=$((n+0))',
		'  if [ "$n" -gt "$e" ]; then',
		"    printf '\\036D%d\\n' $((n-e)) >&2",
		'    tail -c +$((e+1)) "$d/err" | head -c $((n-e)) >&2 || exit 1',
		"    printf '\\037' >&2; e=$n; m=1",
		'  fi',
		'  [ "$f" = 1 ] && break',
		// Removed by a cleanup or a reap: nobody reads this turn any more.
		`  [ -d "$d" ] || exit ${DURABLE_TURN_GONE_EXIT_CODE}`,
		`  [ "$m" = 1 ] || sleep ${STREAM_POLL_SECONDS}`,
		'done',
		'c=1; read -r c < "$d/exit" 2>/dev/null',
		'case "$c" in ""|*[!0-9]*) c=1 ;; esac',
		'printf \'\\036E%d\\n\' "$c" >&2',
		'exit "$c"',
	];
}

/**
 * The durable launch script. `innerStdin` is exactly what a normal launch
 * would send (pid record, script, prompt); the envelope must come first on
 * stdin, and the caller closes stdin behind `innerStdin` as it does today.
 *
 * bash parses the whole `{ ... }` before running it and reads a pipe one
 * byte at a time, so `cat` receives exactly the bytes after the envelope.
 */
export function buildDurableLaunchScript(innerStdin: string, dir: string): string {
	assertRemoteTurnDir(dir);
	const shell = SSH_STDIN_REMOTE_SHELL.join(' ');
	const sweep =
		`find /tmp -maxdepth 2 -path '/tmp/maestro-turn-*/exit' -mmin +${TURN_DIR_MAX_AGE_MIN} 2>/dev/null` +
		` | while read -r x; do rm -rf -- "\${x%/exit}"; done`;
	const lines = [
		'{',
		sweep,
		`d=${shellEscape(dir)}`,
		'(umask 077; mkdir "$d") || exit 1',
		'cat > "$d/in" || exit 1',
		': > "$d/out"; : > "$d/err"',
		'set -m',
		'(',
		'  set -m',
		// From a pipe, not the file: bash reads a seekable script in blocks and
		// would swallow the prompt that today's `exec`ed agent reads after it.
		// The subshell leads the job's process group and `exec`s that bash, so
		// the pid record inside it still names the group.
		`  ( exec ${shell} < <(cat "$d/in") > "$d/out" 2> "$d/err" ) &`,
		'  wait $!; c=$?',
		'  printf \'%s\\n\' "$c" > "$d/exit.tmp" && mv -f "$d/exit.tmp" "$d/exit"',
		') < /dev/null > /dev/null 2>&1 &',
		'printf \'%s %s\\n\' "$!" "$(ps -o lstart= -p $! 2>/dev/null)" > "$d/sup"',
		"printf '\\036S\\n' >&2",
		...streamLoop(0, 0),
		'}',
	];
	return lines.join('\n') + '\n' + innerStdin;
}

/**
 * The script that resumes a durable turn's stream after a lost link. It sends
 * the gone frame and exits {@link DURABLE_TURN_GONE_EXIT_CODE} when the
 * remote proves the turn is gone; otherwise it streams from the given offsets
 * and ends as the launch does.
 */
export function buildDurableReattachScript(
	dir: string,
	pidFile: string,
	outOffset: number,
	errOffset: number
): string {
	assertRemoteTurnDir(dir);
	if (!PID_FILE_PATTERN.test(pidFile)) throw new Error('Invalid remote pid file.');
	const gone = `{ printf '\\036G\\n' >&2; exit ${DURABLE_TURN_GONE_EXIT_CODE}; }`;
	const lines = [
		'{',
		`d=${shellEscape(dir)}; pf=${shellEscape(pidFile)}`,
		`[ -d "$d" ] || ${gone}`,
		// A record names a live process only while its start time still matches,
		// so a recycled pid never counts as the agent or its supervisor.
		'_alive() {',
		'  [ -r "$1" ] || return 1',
		'  read -r p started < "$1" || return 1',
		'  case "$p" in ""|*[!0-9]*) return 1 ;; esac',
		'  kill -0 "$p" 2>/dev/null || return 1',
		'  [ "$(echo $(ps -o lstart= -p "$p" 2>/dev/null))" = "$(echo $started)" ]',
		'}',
		'if [ ! -e "$d/exit" ] && ! _alive "$d/sup" && ! _alive "$pf"; then',
		// The supervisor may have finished between the first check and the probe.
		`  [ -e "$d/exit" ] || ${gone}`,
		'fi',
		"printf '\\036S\\n' >&2",
		...streamLoop(outOffset, errOffset),
		'}',
	];
	return lines.join('\n') + '\n';
}

/**
 * Reads a durable turn's framed stderr across every ssh attempt of the turn.
 *
 * {@link push} takes raw stderr bytes and returns the text to pass on: ssh's
 * own lines as they complete, and the agent's stderr, decoded with one decoder
 * for the whole turn so a character split by a drop still decodes whole.
 * {@link errOffset} counts the agent's stderr bytes received in complete
 * frames: the offset the next reattach resumes from.
 */
export class DurableStderrReader {
	private buf: Buffer = Buffer.alloc(0);
	private payloadLen = -1;
	private readonly payloadDecoder = new StringDecoder('utf8');
	private offset = 0;
	private startedNow = false;
	private everStarted = false;
	private ended: number | null = null;
	private goneNow = false;

	/**
	 * `resumeFrom`: a turn picked up again after this app restarted. Its agent
	 * was already running, and its stderr was received up to that offset.
	 */
	constructor(resumeFrom?: number) {
		if (resumeFrom !== undefined) {
			assertOffset(resumeFrom);
			this.offset = resumeFrom;
			this.everStarted = true;
		}
	}

	/** The agent's stderr bytes received so far. */
	get errOffset(): number {
		return this.offset;
	}

	/** True once any attempt reported the agent running. */
	get launched(): boolean {
		return this.everStarted;
	}

	/** True once THIS attempt reported the agent running (it reached the host). */
	get attached(): boolean {
		return this.startedNow;
	}

	/** The agent's exit code, once the end frame arrived. */
	get endCode(): number | null {
		return this.ended;
	}

	/** True when a reattach reported the turn gone. */
	get gone(): boolean {
		return this.goneNow;
	}

	push(chunk: Uint8Array): string {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
		let out = '';
		for (;;) {
			if (this.payloadLen >= 0) {
				if (this.buf.length < this.payloadLen + 1) return out;
				const payload = this.buf.subarray(0, this.payloadLen);
				if (this.buf[this.payloadLen] === US) {
					out += this.payloadDecoder.write(payload);
					this.offset += this.payloadLen;
					this.buf = this.buf.subarray(this.payloadLen + 1);
				} else {
					// ssh wrote into a frame the drop cut: drop it, the reattach resends it.
					const next = this.buf.indexOf(RS, 1);
					this.buf = next < 0 ? Buffer.alloc(0) : this.buf.subarray(next);
				}
				this.payloadLen = -1;
				continue;
			}
			if (this.buf.length === 0) return out;
			const nl = this.buf.indexOf(LF);
			if (nl < 0) return out;
			const line = this.buf.subarray(0, nl);
			this.buf = this.buf.subarray(nl + 1);
			if (line[0] !== RS) {
				out += line.toString('utf8') + '\n';
				continue;
			}
			const header = line.subarray(1).toString('latin1');
			if (header === 'S') {
				this.startedNow = true;
				this.everStarted = true;
			} else if (header === 'G') {
				this.goneNow = true;
			} else if (/^E\d+$/.test(header)) {
				this.ended = Number(header.slice(1));
			} else if (/^D\d+$/.test(header)) {
				this.payloadLen = Number(header.slice(1));
			}
			// Any other header is not ours: drop it.
		}
	}

	/**
	 * The end of one ssh attempt: ssh's last partial line is passed on, a cut
	 * frame is dropped, and the next attempt starts unattached.
	 */
	endAttempt(): string {
		const rest = this.payloadLen < 0 && this.buf[0] !== RS ? this.buf.toString('utf8') : '';
		this.buf = Buffer.alloc(0);
		this.payloadLen = -1;
		this.startedNow = false;
		return rest;
	}
}

/**
 * Waits before each reattach while the host does not answer. The first is
 * short, for a blip; the rest are the reap's pacing, about 25 minutes in all,
 * which outlasts an OpenSSH PerSourcePenalties refusal. A reattach that
 * reaches the host starts the count again. After the last one the turn is
 * given up as a lost link, and the reap takes over.
 */
export const DURABLE_REATTACH_DELAYS_MS: readonly number[] = [
	2_000,
	...REMOTE_REAP_RETRY_DELAYS_MS,
];

/** How often a wait between attempts checks for a Stop. */
const STOP_POLL_MS = 250;

/** One ssh process of a durable turn. */
export interface DurableAttempt {
	readonly child: ChildProcess;
	readonly done: Promise<TurnExit>;
}

/** The raw byte handlers an attempt must be started with. */
export interface DurableAttemptHandlers {
	onStdoutBytes(chunk: Uint8Array): void;
	onStderrBytes(chunk: Uint8Array): void;
}

export interface DurableSshTurnOptions {
	/** The turn dir and pid file the launch script names. */
	dir: string;
	pidFile: string;
	/** Start one ssh process with this stdin (closed behind it) and these handlers. */
	startAttempt(stdin: string, handlers: DurableAttemptHandlers): DurableAttempt;
	/** The agent's stdout and stderr, decoded, as one stream across every attempt. */
	onStdout(text: string): void;
	onStderr(text: string): void;
	/** A reattach took over the turn; `child` is now the process to stop. */
	onAttempt?(child: ChildProcess): void;
	/** The link dropped under a running agent (the ssh exit, for reachability). */
	onLinkLost?(exit: TurnExit): void;
	/** A reattach could not even start its ssh process. */
	onAttemptError?(error: unknown): void;
	/** `'interrupt'` after a Stop, `'kill'` once nobody owns the turn, else null. */
	stopReason(): 'interrupt' | 'kill' | null;
	delaysMs?: readonly number[];
	/**
	 * Pick up a turn this app started before it restarted: the first attempt
	 * is a reattach from these offsets instead of the launch, and the turn
	 * counts as started (a host that does not answer is a lost link, not a
	 * launch that never ran).
	 */
	resume?: DurableTurnOffsets;
}

/** Where a durable turn's streams stand, in the agent's own bytes. */
export interface DurableTurnOffsets {
	outOffset: number;
	errOffset: number;
}

/**
 * How a durable turn ended. `ended`: the agent ended, with its own code.
 * `stopped`: the user stopped it. `gone`: the remote proved the agent gone
 * with no exit code. `unreachable`: the host never answered again.
 * `not-started`: the launch never reached the agent; settle as today.
 */
export type DurableTurnOutcome = 'ended' | 'stopped' | 'gone' | 'unreachable' | 'not-started';

export interface DurableTurnExit extends TurnExit {
	outcome: DurableTurnOutcome;
}

/** What a lost link reports when the turn cannot be recovered: today's ssh failure. */
const LOST_LINK_EXIT_CODE = 255;

/**
 * Run a durable SSH turn: the launch, then a reattach after every lost link,
 * until the agent ends, the user stops it, or the remote cannot recover it.
 * Every byte reaches `onStdout` / `onStderr` exactly once and in order.
 */
export function runDurableSshTurn(
	launchStdin: string,
	options: DurableSshTurnOptions
): {
	first: DurableAttempt;
	done: Promise<DurableTurnExit>;
	/**
	 * Where to pick the turn up after this app restarts. stdout resumes at
	 * its last line end, not at the last byte: a new process starts with
	 * empty line buffers, so the line in progress is sent again whole.
	 */
	restartOffsets(): DurableTurnOffsets;
} {
	const delays = options.delaysMs ?? DURABLE_REATTACH_DELAYS_MS;
	const resume = options.resume;
	if (resume) assertOffset(resume.outOffset);
	const stderr = new DurableStderrReader(resume?.errOffset);
	const stdoutDecoder = new StringDecoder('utf8');
	let outOffset = resume?.outOffset ?? 0;
	let outLineOffset = outOffset;
	const handlers: DurableAttemptHandlers = {
		onStdoutBytes: (chunk) => {
			const nl = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).lastIndexOf(LF);
			if (nl >= 0) outLineOffset = outOffset + nl + 1;
			outOffset += chunk.length;
			const text = stdoutDecoder.write(Buffer.from(chunk));
			if (text) options.onStdout(text);
		},
		onStderrBytes: (chunk) => {
			const text = stderr.push(chunk);
			if (text) options.onStderr(text);
		},
	};

	const stopped = (exit: TurnExit, reason: 'interrupt' | 'kill'): DurableTurnExit => ({
		...exit,
		interrupted: true,
		exitCode: null,
		signal: reason === 'interrupt' ? 'SIGINT' : 'SIGTERM',
		outcome: 'stopped',
	});

	const waitOrStop = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			const started = Date.now();
			const tick = () => {
				if (options.stopReason() !== null || Date.now() - started >= ms) resolve();
				else setTimeout(tick, Math.min(STOP_POLL_MS, ms - (Date.now() - started)));
			};
			tick();
		});

	const first = options.startAttempt(
		resume
			? buildDurableReattachScript(options.dir, options.pidFile, resume.outOffset, resume.errOffset)
			: launchStdin,
		handlers
	);
	const done = (async (): Promise<DurableTurnExit> => {
		let attempt = first;
		let failures = 0;
		for (;;) {
			const exit = await attempt.done;
			const attached = stderr.attached;
			const rest = stderr.endAttempt();
			if (rest) options.onStderr(rest);
			// A character a drop split stays in the decoder until the turn ends.
			const finish = (result: DurableTurnExit): DurableTurnExit => {
				const tail = stdoutDecoder.end();
				if (tail) options.onStdout(tail);
				return result;
			};
			if (stderr.endCode !== null)
				return finish({ ...exit, exitCode: stderr.endCode, signal: null, outcome: 'ended' });
			if (!stderr.launched || exit.spawnError) return finish({ ...exit, outcome: 'not-started' });
			const reason = options.stopReason();
			if (reason) return finish(stopped(exit, reason));
			if (stderr.gone)
				return finish({ ...exit, exitCode: LOST_LINK_EXIT_CODE, signal: null, outcome: 'gone' });
			if (attached) failures = 0;
			options.onLinkLost?.(exit);
			if (failures >= delays.length)
				return finish({
					...exit,
					exitCode: LOST_LINK_EXIT_CODE,
					signal: null,
					outcome: 'unreachable',
				});
			await waitOrStop(delays[failures++]);
			const during = options.stopReason();
			if (during) return finish(stopped(exit, during));
			try {
				attempt = options.startAttempt(
					buildDurableReattachScript(options.dir, options.pidFile, outOffset, stderr.errOffset),
					handlers
				);
			} catch (error) {
				// ssh itself could not be started: no later attempt would do better.
				options.onAttemptError?.(error);
				return finish({
					...exit,
					exitCode: LOST_LINK_EXIT_CODE,
					signal: null,
					outcome: 'unreachable',
				});
			}
			options.onAttempt?.(attempt.child);
		}
	})();
	return {
		first,
		done,
		restartOffsets: () => ({ outOffset: outLineOffset, errOffset: stderr.errOffset }),
	};
}
