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
 * week that a crash left behind.
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

/**
 * Idle passes of the stream loop between two checks that the agent or its
 * supervisor still lives (25 x 0.2 s, about 5 s). An agent and supervisor
 * killed together (out of memory, a reboot) never write `exit`, and the loop
 * must not wait for it forever on a link that stays up.
 */
const STREAM_LIVENESS_EVERY_PASSES = 25;

/**
 * The most agent stderr one frame carries. A reattach after a long outage
 * sends the backlog as many frames, so this machine never holds more than
 * one frame of it at a time.
 */
export const MAX_STDERR_FRAME_BYTES = 64 * 1024;

/**
 * Finished turn dirs older than this are swept by the next durable launch.
 * As long as this app keeps a turn's restart record (a week), so a turn that
 * ended while the app was closed is still there to be read.
 */
const TURN_DIR_MAX_AGE_MIN = 7 * 24 * 60;

const PID_FILE_PATTERN = /^\/tmp\/maestro-agent-[0-9a-f-]{36}\.pid$/;

/*
 * The remote side frames everything it writes to stderr, so this machine can
 * tell the agent's stderr from ssh's own messages (a host-key warning at
 * connect, "Broken pipe" at a drop) and count the agent's bytes exactly.
 * stdout is never framed: it is the agent's stdout, byte for byte.
 *
 *   RS 'S' LF                 the agent runs (launch) or still runs (reattach)
 *   RS 'D' <len> LF <len bytes> US   that many bytes of the agent's stderr
 *   RS 'E' <code> <out> LF    the agent ended with <code>; every stderr byte was
 *                             sent, and <out> stdout bytes in all
 *   RS 'G' LF                 the turn is gone (reattach only)
 *
 * A data frame cut by a drop is discarded whole and sent again by the
 * reattach, which starts from the last complete frame.
 */
const RS = 0x1e;
const US = 0x1f;
const LF = 0x0a;

/*
 * stdout carries one marker per attempt, before the agent's first byte: a
 * login shell's startup files can print to stdout before the script runs,
 * and those bytes are not the agent's. This machine counts and parses only
 * what follows the marker.
 */
const DURABLE_STDOUT_START_SHELL = '\\036MAESTRO-TURN-STDOUT\\036\\n';
/** The stdout marker that starts the agent's bytes in each attempt. */
export const DURABLE_STDOUT_START = Buffer.from('\x1eMAESTRO-TURN-STDOUT\x1e\n', 'latin1');

function assertOffset(offset: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid remote turn offset.');
}

/** The gone frame and exit: the remote proved the turn has no agent and no exit code. */
const GONE = `{ printf '\\036G\\n' >&2; exit ${DURABLE_TURN_GONE_EXIT_CODE}; }`;

/**
 * `_alive <record>`: true while the process a `<pid> <lstart>` record names
 * still runs. A record names a live process only while its start time still
 * matches, so a recycled pid never counts as the agent or its supervisor.
 */
const ALIVE_FUNCTION = [
	'_alive() {',
	'  [ -r "$1" ] || return 1',
	'  read -r p started < "$1" || return 1',
	'  case "$p" in ""|*[!0-9]*) return 1 ;; esac',
	'  kill -0 "$p" 2>/dev/null || return 1',
	// A `ps` that prints nothing proves nothing: the process answers, so it lives.
	'  now=$(ps -o lstart= -p "$p" 2>/dev/null)',
	'  [ -z "$now" ] || [ "$(echo $now)" = "$(echo $started)" ]',
	'}',
];

/**
 * The loop that copies `<dir>/out` to stdout and `<dir>/err` (framed) to
 * stderr from byte offsets `outOffset` and `errOffset`, then sends the end
 * frame and exits with the recorded code. Each pass notes whether the exit
 * file exists BEFORE it copies, so the pass that ends the loop copied
 * everything the agent wrote.
 *
 * Every few idle seconds it checks that the agent (its record in the dir, or
 * `$pf`) or its supervisor (`$d/sup`) still lives. When neither does and no exit file exists, one more
 * pass copies what they wrote last, and the loop sends the gone frame.
 */
function streamLoop(outOffset: number, errOffset: number): string[] {
	assertOffset(outOffset);
	assertOffset(errOffset);
	return [
		`printf '${DURABLE_STDOUT_START_SHELL}'`,
		`o=${outOffset}; e=${errOffset}; k=0; g=0`,
		'while :; do',
		'  f=0; [ -e "$d/exit" ] && f=1',
		'  m=0',
		'  n=$(wc -c < "$d/out" 2>/dev/null) || n=$o; n=$((n+0))',
		// A copy that cannot write means the channel is gone: a stale loop
		// must not outlive its link.
		'  if [ "$n" -gt "$o" ]; then tail -c +$((o+1)) "$d/out" | head -c $((n-o)) || exit 1; o=$n; m=1; fi',
		'  n=$(wc -c < "$d/err" 2>/dev/null) || n=$e; n=$((n+0))',
		'  if [ "$n" -gt "$e" ]; then',
		`    z=$((n-e)); [ "$z" -gt ${MAX_STDERR_FRAME_BYTES} ] && z=${MAX_STDERR_FRAME_BYTES}`,
		"    printf '\\036D%d\\n' $z >&2",
		'    tail -c +$((e+1)) "$d/err" | head -c $z >&2 || exit 1',
		"    printf '\\037' >&2; e=$((e+z)); m=1",
		'  fi',
		// A frame cap left stderr behind: copy the rest before the exit counts.
		'  [ "$e" -lt "$n" ] && continue',
		'  [ "$f" = 1 ] && break',
		`  [ "$g" = 1 ] && ${GONE}`,
		// Removed by a cleanup or a reap: nobody reads this turn any more.
		`  [ -d "$d" ] || exit ${DURABLE_TURN_GONE_EXIT_CODE}`,
		'  if [ "$m" = 0 ]; then',
		'    k=$((k+1))',
		`    if [ "$k" -ge ${STREAM_LIVENESS_EVERY_PASSES} ]; then k=0; _alive "$d/sup" || _alive "$d/agent" || _alive "$pf" || g=1; fi`,
		`    [ "$g" = 1 ] || sleep ${STREAM_POLL_SECONDS}`,
		'  fi',
		'done',
		'c=1; read -r c < "$d/exit" 2>/dev/null',
		'case "$c" in ""|*[!0-9]*) c=1 ;; esac',
		// With the stdout bytes the agent wrote: stdout and stderr reach this
		// machine on separate streams, so the end frame can overtake stdout's last bytes.
		'printf \'\\036E%d %d\\n\' "$c" "$o" >&2',
		'exit "$c"',
	];
}

const HEX = '[0-9a-f]';
/** The `find -name` glob of a turn dir's name: `maestro-turn-` and a UUID. */
const TURN_DIR_NAME_GLOB = 'maestro-turn-' + [8, 4, 4, 4, 12].map((n) => HEX.repeat(n)).join('-');

const SWEEP_ROOT_PATTERN = /^\/[A-Za-z0-9._/-]*$/;

/**
 * The script that removes finished turn dirs a crash left behind: dirs this
 * user owns, named exactly as Maestro names them, whose `exit` file is older
 * than a week. A shared `/tmp` is hostile ground, so nothing here splits on
 * newlines or follows a link: `find` hands each path to `rm` as one argument,
 * the name glob admits only hex and dashes, `-type d` and `-type f` refuse a
 * symlink, and `rm` gets only an absolute path under `<root>/maestro-turn-`.
 * `-H` because `/tmp` is itself a link on macOS.
 *
 * `root` is for tests; the launch sweeps `/tmp`.
 */
export function buildTurnDirSweepScript(root = '/tmp'): string {
	if (!SWEEP_ROOT_PATTERN.test(root)) throw new Error('Invalid turn dir sweep root.');
	const each =
		'r=$1; shift; for x do' +
		' case "$x" in "$r"/maestro-turn-*) ;; *) continue ;; esac;' +
		` [ -n "$(find "$x/exit" -type f -mmin +${TURN_DIR_MAX_AGE_MIN} 2>/dev/null)" ] || continue;` +
		' rm -rf -- "$x"; done';
	return (
		`find -H ${shellEscape(root)} -maxdepth 1 -type d -user "$(id -u)" -name '${TURN_DIR_NAME_GLOB}'` +
		` -exec sh -c '${each}' sh ${shellEscape(root)} {} + 2>/dev/null`
	);
}

/**
 * The durable launch script. `innerStdin` is exactly what a normal launch
 * would send (pid record, script, prompt); the envelope must come first on
 * stdin, and the caller closes stdin behind `innerStdin` as it does today.
 *
 * bash parses the whole `{ ... }` before running it and reads a pipe one
 * byte at a time, so `cat` receives exactly the bytes after the envelope.
 */
export function buildDurableLaunchScript(innerStdin: string, dir: string, pidFile: string): string {
	assertRemoteTurnDir(dir);
	if (!PID_FILE_PATTERN.test(pidFile)) throw new Error('Invalid remote pid file.');
	const shell = SSH_STDIN_REMOTE_SHELL.join(' ');
	const lines = [
		'{',
		buildTurnDirSweepScript(),
		`d=${shellEscape(dir)}; pf=${shellEscape(pidFile)}`,
		...ALIVE_FUNCTION,
		// The files hold the launch script (env values, keys) and the agent's
		// output: only this user reads them. The umask stays in this subshell,
		// so the agent runs with the user's own, as today.
		// A staging that fails (a full disk) or receives less than was sent (the
		// link closed mid-prompt) removes what it made and never starts the agent.
		'(umask 077; mkdir "$d") || exit 1',
		`(umask 077; : > "$d/out" && : > "$d/err" && cat > "$d/in") && [ "$(wc -c < "$d/in" | tr -d ' ')" = ${Buffer.byteLength(innerStdin)} ] || { rm -rf -- "$d"; exit 1; }`,
		// Held open on fd 3 and unlinked at once: the script and its secrets
		// leave the disk before the agent starts.
		'exec 3< "$d/in" || { rm -rf -- "$d"; exit 1; }',
		'rm -f -- "$d/in"',
		'set -m',
		'(',
		'  set -m',
		// From a pipe, not the file: bash reads a seekable script in blocks and
		// would swallow the prompt that today's `exec`ed agent reads after it.
		// The subshell leads the job's process group and `exec`s that bash, so
		// the pid record inside it still names the group. Only the `cat` keeps
		// fd 3; the agent never sees it.
		`  ( exec ${shell} < <(exec cat <&3) 3<&- > "$d/out" 2> "$d/err" ) &`,
		'  exec 3<&-',
		// A copy of the agent's pid record inside the turn dir, which the day-old
		// pid record sweep does not touch: a cleanup can still find and confirm
		// the agent of a turn that runs longer than that.
		'  printf \'%s %s\\n\' "$!" "$(ps -o lstart= -p $! 2>/dev/null)" > "$d/agent"',
		'  wait $!; c=$?',
		'  printf \'%s\\n\' "$c" > "$d/exit.tmp" && mv -f "$d/exit.tmp" "$d/exit"',
		') < /dev/null > /dev/null 2>&1 &',
		'exec 3<&-',
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
	const lines = [
		'{',
		`d=${shellEscape(dir)}; pf=${shellEscape(pidFile)}`,
		`[ -d "$d" ] || ${GONE}`,
		...ALIVE_FUNCTION,
		'if [ ! -e "$d/exit" ] && ! _alive "$d/sup" && ! _alive "$d/agent" && ! _alive "$pf"; then',
		// The supervisor may have finished between the first check and the probe.
		`  [ -e "$d/exit" ] || ${GONE}`,
		'fi',
		"printf '\\036S\\n' >&2",
		...streamLoop(outOffset, errOffset),
		'}',
	];
	return lines.join('\n') + '\n';
}

/**
 * How many trailing bytes of `buf` start a UTF-8 character that is not
 * complete yet (0 to 3). Bytes that cannot start one count as complete: they
 * decode to U+FFFD now, as a decoder would.
 */
export function incompleteUtf8TailLength(buf: Uint8Array): number {
	for (let back = 1; back <= Math.min(3, buf.length); back += 1) {
		const byte = buf[buf.length - back];
		if ((byte & 0xc0) === 0x80) continue; // a continuation byte: look further back
		const need = byte >= 0xf0 && byte < 0xf8 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return need > back ? back : 0;
	}
	return 0;
}

/** The most of ssh's own stderr a durable turn keeps for a turn that is given up. */
const SSH_DIAGNOSTICS_MAX_CHARS = 8 * 1024;

/**
 * Reads a durable turn's framed stderr across every ssh attempt of the turn.
 *
 * {@link push} takes raw stderr bytes and returns the agent's stderr, decoded
 * across every attempt so a character split by a drop still decodes whole.
 * ssh's own lines (a host-key warning, "client_loop: send disconnect", a login
 * shell's noise) are returned too until the agent first runs, exactly as a
 * normal launch passes them on; after that they are agent-free diagnostics,
 * kept in {@link sshDiagnostics}, so a link that drops and recovers is never
 * read as an agent error. {@link errOffset} counts the agent's stderr bytes
 * received in complete frames: the offset the next reattach resumes from.
 */
export class DurableStderrReader {
	private buf: Buffer = Buffer.alloc(0);
	private payloadLen = -1;
	/** The start of a character the last frame cut, waiting for its other bytes. */
	private pending: Buffer = Buffer.alloc(0);
	private offset = 0;
	private startedNow = false;
	private everStarted = false;
	private ended: number | null = null;
	private endedOut: number | null = null;
	private goneNow = false;
	private diagnostics = '';

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

	/**
	 * Where a new process (after this app restarts) resumes stderr: before a
	 * character the last frame cut, so a fresh decoder receives it whole.
	 */
	get restartErrOffset(): number {
		return this.offset - this.pending.length;
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

	/** How many stdout bytes the agent wrote in all, per the end frame (null: not said). */
	get endOutBytes(): number | null {
		return this.endedOut;
	}

	/** Forget an end frame whose stdout has not all arrived: the next attempt sends it again. */
	dropEnd(): void {
		this.ended = null;
		this.endedOut = null;
	}

	/** True when a reattach reported the turn gone. */
	get gone(): boolean {
		return this.goneNow;
	}

	/** ssh's own stderr since the agent first ran (the last few KB). */
	get sshDiagnostics(): string {
		return this.diagnostics;
	}

	private sshText(text: string): string {
		if (!this.everStarted) return text;
		this.diagnostics = (this.diagnostics + text).slice(-SSH_DIAGNOSTICS_MAX_CHARS);
		return '';
	}

	private decodePayload(payload: Buffer): string {
		const bytes = this.pending.length ? Buffer.concat([this.pending, payload]) : payload;
		const cut = incompleteUtf8TailLength(bytes);
		this.pending = Buffer.from(bytes.subarray(bytes.length - cut));
		return bytes.subarray(0, bytes.length - cut).toString('utf8');
	}

	push(chunk: Uint8Array): string {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
		let out = '';
		for (;;) {
			if (this.payloadLen >= 0) {
				if (this.buf.length < this.payloadLen + 1) return out;
				const payload = this.buf.subarray(0, this.payloadLen);
				if (this.buf[this.payloadLen] === US) {
					out += this.decodePayload(payload);
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
			const rs = line.indexOf(RS);
			if (rs > 0) {
				// ssh's own text with no line end, and a frame right behind it.
				out += this.sshText(line.subarray(0, rs).toString('utf8') + '\n');
				this.buf = this.buf.subarray(rs);
				continue;
			}
			this.buf = this.buf.subarray(nl + 1);
			if (rs < 0) {
				out += this.sshText(line.toString('utf8') + '\n');
				continue;
			}
			const header = line.subarray(1).toString('latin1');
			if (header === 'S') {
				this.startedNow = true;
				this.everStarted = true;
			} else if (header === 'G') {
				this.goneNow = true;
			} else if (/^E\d+(?: \d+)?$/.test(header)) {
				const [code, out] = header.slice(1).split(' ');
				this.ended = Number(code);
				this.endedOut = out === undefined ? null : Number(out);
			} else if (/^D\d+$/.test(header)) {
				this.payloadLen = Number(header.slice(1));
			}
			// Any other header is not ours: drop it.
		}
	}

	/**
	 * The end of one ssh attempt: ssh's last partial line is passed on (or
	 * kept as a diagnostic), a cut frame is dropped, and the next attempt
	 * starts unattached.
	 */
	endAttempt(): string {
		const rest = this.payloadLen < 0 && this.buf[0] !== RS ? this.buf.toString('utf8') : '';
		this.buf = Buffer.alloc(0);
		this.payloadLen = -1;
		this.startedNow = false;
		return rest ? this.sshText(rest) : '';
	}

	/** The turn ended: a character no frame completed decodes as U+FFFD. */
	end(): string {
		const rest = this.pending.length ? this.pending.toString('utf8') : '';
		this.pending = Buffer.alloc(0);
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
	/**
	 * With {@link resume}: stream stdout from the turn's first byte, and hand
	 * the bytes before `resume.outOffset` (the ones this app received before
	 * it restarted) here instead of to `onStdout`. A new process starts with
	 * an empty output parser; replaying the earlier output into one that emits
	 * nothing gives it back the state a reply needs (text a Stop hook held, a
	 * result's earlier parts), and the tab still receives each byte once.
	 */
	onReplayStdout?(text: string): void;
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
 * What a gone turn settles with: the host answered, and proved the agent
 * ended without an exit code (killed with its supervisor: out of memory, a
 * reboot). It is the agent's failure, not the link's, so it is not 255.
 */
export const DURABLE_TURN_GONE_SETTLE_CODE = 1;

/** The stderr line a gone turn settles with, so the tab says why it failed. */
export const DURABLE_TURN_GONE_MESSAGE =
	'The agent on the remote ended without an exit code: its process is gone (killed, out of memory, or the host restarted).\n';

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
	 * stderr resumes before a character its last frame cut.
	 */
	restartOffsets(): DurableTurnOffsets;
} {
	const delays = options.delaysMs ?? DURABLE_REATTACH_DELAYS_MS;
	const resume = options.resume;
	if (resume) assertOffset(resume.outOffset);
	const stderr = new DurableStderrReader(resume?.errOffset);
	const stdoutDecoder = new StringDecoder('utf8');
	const replay = resume && options.onReplayStdout ? options.onReplayStdout : undefined;
	// A restart offset is a line end, so the replay ends on a character
	// boundary and the one decoder carries nothing across it.
	const replayEnd = replay ? resume!.outOffset : 0;
	let outOffset = replay ? 0 : (resume?.outOffset ?? 0);
	let outLineOffset = outOffset;
	// What this attempt's stdout sent before its start marker (null once it
	// came): a login shell's startup output. The first launch passes it on as
	// a normal launch does; a reattach drops it. Neither counts it as the agent's.
	let outHead: Buffer | null = Buffer.alloc(0);
	let passStartupOutput = !resume;
	const startupDecoder = new StringDecoder('utf8');
	const startupOutput = (bytes: Buffer, last = false) => {
		if (!passStartupOutput) return;
		const text = startupDecoder.write(bytes) + (last ? startupDecoder.end() : '');
		if (text) options.onStdout(text);
	};
	const handlers: DurableAttemptHandlers = {
		onStdoutBytes: (chunk) => {
			let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			if (outHead !== null) {
				const seen = outHead.length ? Buffer.concat([outHead, bytes]) : bytes;
				const mark = seen.indexOf(DURABLE_STDOUT_START);
				if (mark < 0) {
					// Keep what may be the marker's first bytes for the next chunk.
					const keep = Math.min(seen.length, DURABLE_STDOUT_START.length - 1);
					startupOutput(seen.subarray(0, seen.length - keep));
					outHead = Buffer.from(seen.subarray(seen.length - keep));
					return;
				}
				startupOutput(seen.subarray(0, mark), true);
				outHead = null;
				bytes = seen.subarray(mark + DURABLE_STDOUT_START.length);
				if (bytes.length === 0) return;
			}
			const nl = bytes.lastIndexOf(LF);
			if (nl >= 0) outLineOffset = outOffset + nl + 1;
			const at = outOffset;
			outOffset += bytes.length;
			if (replay && at < replayEnd) {
				const head = bytes.subarray(0, Math.min(replayEnd - at, bytes.length));
				const replayed = stdoutDecoder.write(Buffer.from(head));
				if (replayed) replay(replayed);
				bytes = bytes.subarray(head.length);
				if (bytes.length === 0) return;
			}
			const text = stdoutDecoder.write(Buffer.from(bytes));
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
			? buildDurableReattachScript(options.dir, options.pidFile, outOffset, resume.errOffset)
			: launchStdin,
		handlers
	);
	const done = (async (): Promise<DurableTurnExit> => {
		let attempt = first;
		let failures = 0;
		for (;;) {
			const exit = await attempt.done;
			if (outHead) startupOutput(outHead, true);
			outHead = Buffer.alloc(0);
			passStartupOutput = false;
			const attached = stderr.attached;
			const rest = stderr.endAttempt();
			if (rest) options.onStderr(rest);
			// A character a drop split stays in the decoder until the turn ends.
			const finish = (result: DurableTurnExit): DurableTurnExit => {
				const tail = stdoutDecoder.end();
				if (tail) options.onStdout(tail);
				const errTail = stderr.end();
				if (errTail) options.onStderr(errTail);
				// Given up: ssh's own last words reach the error parsers now, as a
				// normal launch's would have at its drop. A turn that recovered never
				// shows them.
				if (result.outcome === 'unreachable' && stderr.sshDiagnostics)
					options.onStderr(stderr.sshDiagnostics);
				if (result.outcome === 'gone') options.onStderr(DURABLE_TURN_GONE_MESSAGE);
				return result;
			};
			// The end frame counts only once stdout's last byte is here too; a link
			// that dropped between them is read again from the offsets.
			if (stderr.endCode !== null && (stderr.endOutBytes ?? outOffset) <= outOffset)
				return finish({ ...exit, exitCode: stderr.endCode, signal: null, outcome: 'ended' });
			stderr.dropEnd();
			if (!stderr.launched || exit.spawnError) return finish({ ...exit, outcome: 'not-started' });
			const reason = options.stopReason();
			if (reason) return finish(stopped(exit, reason));
			if (stderr.gone)
				return finish({
					...exit,
					exitCode: DURABLE_TURN_GONE_SETTLE_CODE,
					signal: null,
					outcome: 'gone',
				});
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
		// A crash mid-replay must not move the record back to bytes the tab
		// already has.
		restartOffsets: () => ({
			outOffset: Math.max(outLineOffset, replayEnd),
			errOffset: stderr.restartErrOffset,
		}),
	};
}
