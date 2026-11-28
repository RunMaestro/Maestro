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
 * last bytes arrived. {@link buildRemoteTurnCleanupScript} removes it after
 * the turn settles, and each durable launch sweeps finished dirs older than a
 * day that a crash left behind.
 *
 * Only POSIX tools are used (`cat`, `wc -c`, `tail -c`, `head -c`, `ps`,
 * `kill -0`, `sleep`), and bash, which every SSH spawn already requires.
 */

import { randomUUID } from 'crypto';
import { shellEscape } from '../launch/shell-escape';
import { SSH_STDIN_REMOTE_SHELL } from './ssh-remote-signal';

/** The line the envelope writes to stderr once the agent is started. */
export const DURABLE_TURN_STARTED_MARKER = '__maestro_durable_turn_started__';

/**
 * What a reattach exits with when the remote proves the turn is gone: no
 * turn dir, or no exit file while neither the agent nor its supervisor lives.
 */
export const DURABLE_TURN_GONE_EXIT_CODE = 249;

/** How long the stream loop waits when neither file grew. */
const STREAM_POLL_SECONDS = '0.2';

/** Finished turn dirs older than this are swept by the next durable launch. */
const TURN_DIR_MAX_AGE_MIN = 24 * 60;

const TURN_DIR_PATTERN = /^\/tmp\/maestro-turn-[0-9a-f-]{36}$/;
const PID_FILE_PATTERN = /^\/tmp\/maestro-agent-[0-9a-f-]{36}\.pid$/;

/** A fresh remote turn dir for one durable SSH turn. */
export function newRemoteTurnDir(): string {
	return `/tmp/maestro-turn-${randomUUID()}`;
}

function assertTurnDir(dir: string): void {
	if (!TURN_DIR_PATTERN.test(dir)) throw new Error('Invalid remote turn directory.');
}

function assertOffset(offset: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid remote turn offset.');
}

/**
 * The loop that copies `<dir>/out` to stdout and `<dir>/err` to stderr from
 * byte offsets `outOffset` and `errOffset`, then exits with the recorded code.
 * Each pass notes whether the exit file exists BEFORE it copies, so the pass
 * that ends the loop copied everything the agent wrote.
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
		'  if [ "$n" -gt "$o" ]; then tail -c +$((o+1)) "$d/out" | head -c $((n-o)); o=$n; m=1; fi',
		'  n=$(wc -c < "$d/err" 2>/dev/null) || n=$e; n=$((n+0))',
		'  if [ "$n" -gt "$e" ]; then tail -c +$((e+1)) "$d/err" | head -c $((n-e)) >&2; e=$n; m=1; fi',
		'  [ "$f" = 1 ] && break',
		`  [ "$m" = 1 ] || sleep ${STREAM_POLL_SECONDS}`,
		'done',
		'c=1; read -r c < "$d/exit" 2>/dev/null',
		'case "$c" in ""|*[!0-9]*) c=1 ;; esac',
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
	assertTurnDir(dir);
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
		`printf '%s\\n' ${shellEscape(DURABLE_TURN_STARTED_MARKER)} >&2`,
		...streamLoop(0, 0),
		'}',
	];
	return lines.join('\n') + '\n' + innerStdin;
}

/**
 * The script that resumes a durable turn's stream after a lost link. It exits
 * {@link DURABLE_TURN_GONE_EXIT_CODE} when the remote proves the turn is
 * gone; otherwise it streams from the given offsets and exits with the
 * agent's code once the agent has ended and the files are drained.
 */
export function buildDurableReattachScript(
	dir: string,
	pidFile: string,
	outOffset: number,
	errOffset: number
): string {
	assertTurnDir(dir);
	if (!PID_FILE_PATTERN.test(pidFile)) throw new Error('Invalid remote pid file.');
	const gone = DURABLE_TURN_GONE_EXIT_CODE;
	const lines = [
		'{',
		`d=${shellEscape(dir)}; pf=${shellEscape(pidFile)}`,
		`[ -d "$d" ] || exit ${gone}`,
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
		`  [ -e "$d/exit" ] || exit ${gone}`,
		'fi',
		...streamLoop(outOffset, errOffset),
		'}',
	];
	return lines.join('\n') + '\n';
}

/** The script that removes a settled durable turn's dir. */
export function buildRemoteTurnCleanupScript(dir: string): string {
	assertTurnDir(dir);
	return `rm -rf -- ${shellEscape(dir)}\n`;
}

/**
 * Removes the launch marker from a durable turn's stderr, passing every other
 * byte through. Text before the marker is held only until its line ends, so
 * ssh's own warnings still reach the stderr handler in order.
 */
export class DurableStartMarkerFilter {
	private pending = '';
	private seen = false;

	/** True once the envelope reported the agent started. */
	get started(): boolean {
		return this.seen;
	}

	/** The text to pass on for one decoded stderr chunk. */
	push(text: string): string {
		if (this.seen) return text;
		this.pending += text;
		let out = '';
		for (;;) {
			const nl = this.pending.indexOf('\n');
			if (nl < 0) return out;
			const line = this.pending.slice(0, nl);
			this.pending = this.pending.slice(nl + 1);
			if (line === DURABLE_TURN_STARTED_MARKER) {
				this.seen = true;
				out += this.pending;
				this.pending = '';
				return out;
			}
			out += line + '\n';
		}
	}

	/** Whatever is still held, at the end of a stream. */
	flush(): string {
		const rest = this.pending;
		this.pending = '';
		return rest;
	}
}
