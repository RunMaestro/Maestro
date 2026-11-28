/**
 * Stopping an agent that runs on an SSH remote.
 *
 * ## Why signalling the local ssh client is not enough
 *
 * An SSH agent spawn is a LOCAL `ssh ... /bin/bash -s` process whose script
 * `exec`s the agent on the remote host. Stop and kill used to signal only that
 * local client. With `RequestTTY=no` (required for the stream-json pipe) no
 * signal is forwarded, and the remote agent has no terminal to lose, so it
 * keeps working: on 2026-10-12 a stopped Claude turn ran for 48 more minutes,
 * editing files and committing, while the tab showed it as stopped.
 *
 * With a ControlMaster in the remote's ssh options it is worse. The master
 * holds the dead client's stdio until the remote channel closes, so the local
 * process never emits `close`, its ProcessManager entry never clears, and every
 * later turn on that tab is refused as "already running".
 *
 * ## How it works
 *
 * The launch script records the agent's pid (and its start time, so a recycled
 * pid is never signalled) in a file named by Maestro before it `exec`s the
 * agent. `exec` keeps the pid, so the file names the agent itself. Stop then
 * runs a one-shot ssh with the SAME connection arguments (so it reuses the
 * mux when there is one) that signals that pid's process group: the agent is
 * the session leader under sshd, so its group also holds the tool commands it
 * started.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { logger } from '../host';
import { shellEscape } from '../launch/shell-escape';
import { redactedErrorFields } from '../../processErrors';
import { isSshConnectionFailure } from '../../sshConnection';

const LOG_CONTEXT = '[ssh-remote-signal]';

/** The trailing remote command every stdin-script SSH spawn ends with. */
export const SSH_STDIN_REMOTE_SHELL = ['/bin/bash', '--norc', '--noprofile', '-s'] as const;

/** How long a one-shot signal ssh may run before it is killed. */
const SIGNAL_SSH_TIMEOUT_MS = 30_000;

/** Pid records older than this are swept by the next launch on that host. */
const PID_FILE_MAX_AGE_MIN = 24 * 60;

/** A fresh remote pid-file path for one SSH agent spawn. */
export function newRemotePidFilePath(promptArtifact = false): string {
	return `/tmp/maestro-${promptArtifact ? 'prompt-owner' : 'agent'}-${randomUUID()}.pid`;
}

const TURN_DIR_PATTERN = /^\/tmp\/maestro-turn-[0-9a-f-]{36}$/;

/**
 * A fresh remote dir for one durable SSH turn (see `ssh-durable-turn.ts`):
 * the agent's output, its exit code, and its supervisor's pid live there.
 */
export function newRemoteTurnDir(): string {
	return `/tmp/maestro-turn-${randomUUID()}`;
}

/** Refuse a turn dir Maestro did not name: it goes into `rm -rf`. */
export function assertRemoteTurnDir(dir: string): void {
	if (!TURN_DIR_PATTERN.test(dir)) throw new Error('Invalid remote turn directory.');
}

/** The script that removes a settled durable turn's dir. */
export function buildRemoteTurnCleanupScript(dir: string): string {
	assertRemoteTurnDir(dir);
	return `rm -rf -- ${shellEscape(dir)}\n`;
}

/**
 * What a durable turn's terminate exits with when it cannot prove the agent
 * gone: the dir names no agent yet (a Stop that reached the host before the
 * supervisor recorded it), or the agent outlived SIGKILL's wait. The dir and
 * the agent's record stay, and the reap tries again.
 */
export const DURABLE_TERMINATE_UNCONFIRMED_EXIT_CODE = 75;

/**
 * What a durable turn's terminate exits with when the agent is gone but its
 * dir could not be removed: the reap tries the removal again.
 */
export const DURABLE_CLEANUP_FAILED_EXIT_CODE = 74;

/**
 * What a launch exits with, before its own agent starts, when an earlier
 * turn's agent it had to stop first could not be proven gone. The new agent
 * never runs beside it on the same session.
 */
export const PRE_LAUNCH_REAP_REFUSED_EXIT_CODE = 248;

/** The stderr line of a launch refused by {@link PRE_LAUNCH_REAP_REFUSED_EXIT_CODE}. */
export const PRE_LAUNCH_REAP_REFUSED_MESSAGE =
	'An earlier turn of this tab is still running on the remote and could not be stopped yet. Maestro keeps trying; send again in a moment.';

/**
 * Lines that find a durable turn's agent: `ap` / `as` from the copy of its
 * record in the turn dir (which the day-old pid sweep never touches), else
 * from the pid file; `_same` while that process still runs with the recorded
 * start time; `t` the target to signal (its group when it leads one).
 */
function durableAgentLines(dir: string, pidFile: string): string[] {
	assertRemoteTurnDir(dir);
	const pf = shellEscape(pidFile);
	return [
		`d=${shellEscape(dir)}; ap=; as=`,
		'[ -r "$d/agent" ] && read -r ap as < "$d/agent"',
		`[ -n "$ap" ] || { [ -r ${pf} ] && read -r ap as < ${pf}; }`,
		'case "$ap" in ""|*[!0-9]*) ap= ;; esac',
		// A `ps` that prints nothing proves nothing: the process still answers, so it counts as the agent.
		'_same() { [ -n "$ap" ] && kill -0 "$ap" 2>/dev/null || return 1; n=$(ps -o lstart= -p "$ap" 2>/dev/null); [ -z "$n" ] || [ "$(echo $n)" = "$(echo $as)" ]; }',
		't="$ap"; [ -n "$ap" ] && [ "$(ps -o pgid= -p "$ap" 2>/dev/null | tr -d " ")" = "$ap" ] && t="-$ap"',
	];
}

/**
 * The terminate script for `target`. A durable turn's dir goes with it, but
 * only once the agent is proven gone: the agent wrote its exit, or its record
 * names no live process after the terminate. Without that proof the dir and
 * the record stay and the script exits
 * {@link DURABLE_TERMINATE_UNCONFIRMED_EXIT_CODE}, so the reap tries again: a
 * dir removed under a live agent leaves a writer nobody can find again.
 */
function terminateScriptFor(target: RemoteSignalTarget): string {
	if (target.turnDir === undefined)
		return buildRemoteSignalScript(target.pidFile, 'terminate', target.promptArtifactPath);
	if (target.promptArtifactPath !== undefined)
		throw new Error('A durable turn has no prompt artifact.');
	return [
		...durableAgentLines(target.turnDir, target.pidFile),
		'if _same; then',
		'  kill -TERM -- "$t" 2>/dev/null',
		'  i=0; while [ "$i" -lt 6 ] && _same; do sleep 0.5; i=$((i+1)); done',
		'  _same && kill -KILL -- "$t" 2>/dev/null',
		// Its supervisor reaps it: give the zombie a moment to go.
		'  i=0; while [ "$i" -lt 10 ] && _same; do sleep 0.1; i=$((i+1)); done',
		'fi',
		'if [ -d "$d" ] && [ ! -e "$d/exit" ]; then',
		`  { [ -z "$ap" ] || _same; } && exit ${DURABLE_TERMINATE_UNCONFIRMED_EXIT_CODE}`,
		'fi',
		`rm -f -- ${shellEscape(target.pidFile)}`,
		'if [ -d "$d" ]; then',
		`  rm -rf -- "$d" 2>/dev/null; [ -d "$d" ] && exit ${DURABLE_CLEANUP_FAILED_EXIT_CODE}`,
		'  exit 0',
		'fi',
		// No dir: the launch never staged, or an earlier reap removed it. Leave
		// a finished one in its place, so a launch still on its way (its script
		// already on the host, running an earlier reap) cannot start its agent
		// after this reap reported it gone. The sweep of finished dirs removes it.
		`( umask 077; mkdir "$d" 2>/dev/null ) || exit ${DURABLE_TERMINATE_UNCONFIRMED_EXIT_CODE}`,
		'printf \'reaped\\n\' > "$d/exit"',
		'exit 0',
	]
		.join('\n')
		.concat('\n');
}

/**
 * A durable turn's interrupt: SIGINT to the agent its record names, the dir
 * copy first, so a Stop still reaches an agent whose pid file the day-old
 * sweep removed. Nothing is removed: the terminate needs the record.
 */
export function buildDurableInterruptScript(dir: string, pidFile: string): string {
	return [...durableAgentLines(dir, pidFile), '_same && kill -INT -- "$t" 2>/dev/null', 'exit 0']
		.join('\n')
		.concat('\n');
}

/**
 * Prefix a stdin launch script with the line that records the agent's pid.
 *
 * `$$` is the remote bash, which the script later `exec`s into the agent, so
 * the recorded pid is the agent's. The start time is recorded beside it so a
 * later signal can refuse a pid the OS has since handed to something else.
 */
export function withRemotePidRecord(
	script: string,
	pidFile: string,
	promptArtifactPath?: string
): string {
	const f = shellEscape(pidFile);
	if (promptArtifactPath !== undefined) {
		if (!/^\/tmp\/maestro-prompt-owner-[0-9a-f-]{36}\.pid$/.test(pidFile)) {
			throw new Error('Remote prompt preparation unavailable.');
		}
		// Bash parses the whole compound before executing it. A truncated script
		// must not create a file before receiving its lifetime/cleanup owner.
		return [
			'{',
			`readonly _maestro_prompt_path=${shellEscape(promptArtifactPath)}`,
			`readonly _maestro_prompt_pid_file=${f}`,
			'exec 8>&- 9>&-',
			'_maestro_pid_fail() { printf "%s\\n" "Remote prompt preparation unavailable." >&2; exit 1; }',
			'[ -d "/proc/$$/fd" ] || _maestro_pid_fail',
			'[ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d " ")" = "$$" ] || _maestro_pid_fail',
			'_maestro_pid_started=$(LC_ALL=C ps -o lstart= -p $$ 2>/dev/null)',
			'[ -n "$_maestro_pid_started" ] || _maestro_pid_fail',
			'[ ! -e "$_maestro_prompt_pid_file.cancel" ] && [ ! -L "$_maestro_prompt_pid_file.cancel" ] || _maestro_pid_fail',
			// The builder replaces this provisional trap before opening fd 9.
			'trap \'if [ -f "/proc/$$/fd/8" ] && [ ! -L "$_maestro_prompt_pid_file" ] && [ "$_maestro_prompt_pid_file" -ef "/proc/$$/fd/8" ]; then rm -f -- "$_maestro_prompt_pid_file" 2>/dev/null || printf "%s\\n" "Remote prompt cleanup failed." >&2; fi; exec 8>&-\' EXIT',
			"trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP",
			'[ ! -e "$_maestro_prompt_pid_file" ] && [ ! -L "$_maestro_prompt_pid_file" ] || _maestro_pid_fail',
			'_maestro_pid_umask=$(umask)',
			'if ! { umask 077; set -C; exec 8> "$_maestro_prompt_pid_file"; } 2>/dev/null; then _maestro_pid_fail; fi',
			'set +C; umask "$_maestro_pid_umask"',
			'[ -f "/proc/$$/fd/8" ] && [ "$_maestro_prompt_pid_file" -ef "/proc/$$/fd/8" ] && [ "$(stat -Lc %a "/proc/$$/fd/8" 2>/dev/null)" = 600 ] || _maestro_pid_fail',
			'printf "%s %s\\n" "$$" "$_maestro_pid_started" >&8 || _maestro_pid_fail',
			// Stop publishes this marker before reading the record. If it saw a
			// partial/missing record, this check prevents a later artifact write.
			'[ ! -e "$_maestro_prompt_pid_file.cancel" ] && [ ! -L "$_maestro_prompt_pid_file.cancel" ] || _maestro_pid_fail',
			script,
			'}\n',
		].join('\n');
	}
	// `exec` leaves nothing behind to delete the file when the agent exits, so
	// each launch sweeps records older than a day. A turn that has run that long
	// loses only its remote Stop; the local kill still works.
	const sweep = `find /tmp -maxdepth 1 -name 'maestro-agent-*.pid' -mmin +${PID_FILE_MAX_AGE_MIN} -delete 2>/dev/null`;
	return `${sweep}\nprintf '%s %s\\n' "$$" "$(ps -o lstart= -p $$ 2>/dev/null)" > ${f} 2>/dev/null\n${script}`;
}

export type RemoteSignalMode = 'interrupt' | 'terminate';

/**
 * The remote script that signals the recorded agent.
 *
 * `interrupt` sends SIGINT once, the same request a local Stop makes.
 * `terminate` sends SIGTERM, waits up to 3s, then SIGKILL. Both signal the
 * process group when the agent leads one, and exit quietly when the pid file
 * is missing, unreadable, or names a process that is gone or was recycled.
 */
export function buildRemoteSignalScript(
	pidFile: string,
	mode: RemoteSignalMode,
	promptArtifactPath?: string
): string {
	const f = shellEscape(pidFile);
	if (promptArtifactPath !== undefined) {
		if (!/^\/tmp\/maestro-prompt-owner-[0-9a-f-]{36}\.pid$/.test(pidFile)) {
			throw new Error('Remote prompt preparation unavailable.');
		}
		const lines = [
			`f=${f}; a=${shellEscape(promptArtifactPath)}`,
			'exec 5>&- 6>&- 7>&-',
			'_maestro_frozen=0',
			'_thaw() {',
			'  if [ "$_maestro_frozen" = 1 ] && _same_pid; then',
			'    if kill -CONT -- "-$p" 2>/dev/null; then _maestro_frozen=0; kill -TERM -- "-$p" 2>/dev/null; fi',
			'  fi',
			'}',
			'_finalize() {',
			'  _maestro_exit=$?',
			"  trap '' INT TERM HUP",
			'  _thaw',
			// fd 6 cannot exist until _capture runs after all helper definitions.
			// Retain its inode witness across interruption after group SIGKILL.
			'  if [ -f "/proc/$$/fd/6" ]; then',
			'    i=0; while [ "$i" -lt 10 ] && _readers; do sleep 0.1; i=$((i+1)); done',
			'    if _readers || ! _cleanup; then [ "$_maestro_exit" != 0 ] || _maestro_exit=1; fi',
			'  fi',
			'  exec 5>&- 6>&- 7>&-',
			'  exit "$_maestro_exit"',
			'}',
			"trap '_finalize' EXIT",
			"trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP",
			'[ -d "/proc/$$/fd" ] || exit 1',
			// Persist a zero-byte cancellation tombstone. Removing it on failure
			// would permit a delayed SSH launch to create its artifact afterwards.
			'if [ ! -e "$f.cancel" ] && [ ! -L "$f.cancel" ]; then',
			'  { umask 077; set -C; exec 5> "$f.cancel"; } 2>/dev/null || exit 1',
			'  set +C',
			'  [ -f "/proc/$$/fd/5" ] && [ "$(stat -Lc %a "/proc/$$/fd/5" 2>/dev/null)" = 600 ] || exit 1',
			'fi',
			// A disappeared record is not evidence of cleanup: the connection may
			// have failed before the remote launch reached its prefix.
			'[ -f "$f" ] && [ ! -L "$f" ] || exit 1',
			'{ exec 7< "$f"; } 2>/dev/null || exit 1',
			'read -r p started <&7 || exit 1',
			'case "$p" in ""|*[!0-9]*) exit 1 ;; esac',
			'[ -n "$started" ] || exit 1',
			'_same_pid() {',
			'  kill -0 "$p" 2>/dev/null &&',
			'  [ "$(LC_ALL=C ps -o lstart= -p "$p" 2>/dev/null | xargs)" = "$(printf "%s" "$started" | xargs)" ] &&',
			'  [ "$(ps -o pgid= -p "$p" 2>/dev/null | tr -d " ")" = "$p" ]',
			'}',
			'_same() { _same_pid && [ "$f" -ef "/proc/$$/fd/7" ] && [ "/proc/$p/fd/8" -ef "/proc/$$/fd/7" ]; }',
			'_readers() {',
			'  snapshot=$(ps -e -o pgid=,stat= 2>/dev/null) || return 0',
			'  [ -n "$snapshot" ] || return 0',
			'  active=$(printf "%s\\n" "$snapshot" | awk -v g="$p" \'$1 == g && $2 !~ /^[Zz]/ { print "live"; exit }\') || return 0',
			'  [ -n "$active" ]',
			'}',
			'_capture() {',
			'  [ -f "/proc/$$/fd/6" ] && return 0',
			'  [ -e "/proc/$p/fd/9" ] || return 0',
			'  [ -f "/proc/$p/fd/9" ] && { exec 6< "/proc/$p/fd/9"; } 2>/dev/null',
			'}',
			'_cleanup() {',
			'  if [ -f "/proc/$$/fd/6" ] && [ ! -L "$a" ] && [ "$a" -ef "/proc/$$/fd/6" ]; then rm -f -- "$a" 2>/dev/null || return 1; fi',
			'  if [ ! -L "$f" ] && [ "$f" -ef "/proc/$$/fd/7" ]; then rm -f -- "$f" 2>/dev/null || return 1; fi',
			'}',
			'_same || exit 1',
		];
		if (mode === 'interrupt') {
			lines.push('kill -INT -- "-$p" 2>/dev/null');
		} else {
			lines.push(
				'_capture || exit 1',
				'kill -TERM -- "-$p" 2>/dev/null',
				'i=0; while [ "$i" -lt 6 ] && _same; do sleep 0.5; i=$((i+1)); done',
				'if _same; then',
				// Freeze before the final capture so creation cannot race SIGKILL.
				'  _maestro_frozen=1',
				'  kill -STOP -- "-$p" 2>/dev/null || exit 1',
				'  i=0; frozen=0; while [ "$i" -lt 10 ] && _same_pid; do',
				'    case "$(ps -o stat= -p "$p" 2>/dev/null | tr -d " ")" in T*|t*) frozen=1; break ;; esac',
				'    sleep 0.1; i=$((i+1))',
				'  done',
				'  if [ "$frozen" != 1 ] || ! _same; then exit 1; fi',
				'  _capture || exit 1',
				'  kill -KILL -- "-$p" 2>/dev/null || exit 1',
				'  _maestro_frozen=0',
				'fi',
				// Never unlink while an owned group's reader might still run.
				'i=0; while [ "$i" -lt 10 ] && _readers; do sleep 0.1; i=$((i+1)); done',
				'_readers && exit 1',
				'_cleanup'
			);
		}
		return `{\n${lines.join('\n')}\n}\n`;
	}
	const lines = [
		`f=${f}`,
		'[ -r "$f" ] || exit 0',
		'read -r p started < "$f"',
		'case "$p" in ""|*[!0-9]*) exit 0 ;; esac',
		'kill -0 "$p" 2>/dev/null || { rm -f "$f"; exit 0; }',
		'now=$(ps -o lstart= -p "$p" 2>/dev/null)',
		'[ -n "$started" ] && [ "$(echo $now)" != "$(echo $started)" ] && { rm -f "$f"; exit 0; }',
		'g=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d " ")',
		't="$p"; [ "$g" = "$p" ] && t="-$p"',
	];
	if (mode === 'interrupt') {
		lines.push('kill -INT -- "$t" 2>/dev/null');
	} else {
		lines.push(
			'kill -TERM -- "$t" 2>/dev/null',
			'i=0; while [ $i -lt 6 ] && kill -0 "$p" 2>/dev/null; do sleep 0.5; i=$((i+1)); done',
			'kill -KILL -- "$t" 2>/dev/null',
			'rm -f "$f"'
		);
	}
	return lines.join('\n') + '\n';
}

/**
 * The ssh arguments that reach the same host the agent runs on, or null when
 * `args` is not a stdin-script SSH spawn (which is the only kind that records a
 * pid, so the only kind this can signal).
 */
export function sshConnectionArgs(args: readonly string[]): string[] | null {
	const tail = SSH_STDIN_REMOTE_SHELL.length;
	if (args.length <= tail) return null;
	const ending = args.slice(-tail);
	if (!ending.every((arg, i) => arg === SSH_STDIN_REMOTE_SHELL[i])) return null;
	return args.slice(0, -tail);
}

/** The SSH-hosted agent a signal is for, and how to reach its host. */
export interface RemoteSignalTarget {
	sshCommand: string;
	sshArgs: readonly string[];
	pidFile: string;
	sessionId: string;
	/** Remote-owned file; enables descriptor-preserving cancellation. */
	promptArtifactPath?: string;
	/**
	 * A durable turn's dir: an interrupt or terminate finds the agent through
	 * the record copy in it, and a terminate removes it once the agent is gone.
	 */
	turnDir?: string;
}

/**
 * Signal an SSH-hosted agent on its remote host. Fire-and-forget: it never
 * throws, the one-shot ssh is detached so it finishes even if the app is
 * quitting, and it is killed if it outlives {@link SIGNAL_SSH_TIMEOUT_MS}.
 *
 * `onExit` receives the signal ssh's exit code once: `null` when it could not
 * start or was killed for running too long.
 */
export function signalRemoteAgent(
	target: RemoteSignalTarget,
	mode: RemoteSignalMode,
	onExit?: (exitCode: number | null) => void
): boolean {
	const connection = sshConnectionArgs(target.sshArgs);
	if (!connection) return false;

	let settled = false;
	const settle = (exitCode: number | null) => {
		if (settled) return;
		settled = true;
		onExit?.(exitCode);
	};

	try {
		const script =
			mode === 'terminate'
				? terminateScriptFor(target)
				: target.turnDir !== undefined && target.promptArtifactPath === undefined
					? buildDurableInterruptScript(target.turnDir, target.pidFile)
					: buildRemoteSignalScript(target.pidFile, mode, target.promptArtifactPath);
		const child = spawn(target.sshCommand, [...connection, ...SSH_STDIN_REMOTE_SHELL], {
			stdio: ['pipe', 'ignore', 'ignore'],
			detached: true,
		});
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				// Already gone.
			}
		}, SIGNAL_SSH_TIMEOUT_MS);
		timer.unref?.();
		child.on('error', (error) => {
			clearTimeout(timer);
			// The class and errno only: the message can name the private prompt artifact.
			logger.warn('Remote agent signal ssh failed to start', LOG_CONTEXT, {
				sessionId: target.sessionId,
				mode,
				...redactedErrorFields(error),
			});
			settle(null);
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			settle(code);
			const log = code === 0 ? logger.info : logger.warn;
			log.call(
				logger,
				code === 0 ? 'Remote agent signal completed' : 'Remote agent signal failed',
				LOG_CONTEXT,
				{
					sessionId: target.sessionId,
					mode,
					exitCode: code,
				}
			);
		});
		child.stdin?.on('error', () => {
			// EPIPE when ssh fails to connect; the exit/error handlers report it.
		});
		child.stdin?.end(script);
		child.unref();
		return true;
	} catch (error) {
		logger.warn('Could not signal remote agent', LOG_CONTEXT, {
			sessionId: target.sessionId,
			mode,
			...redactedErrorFields(error),
		});
		return false;
	}
}

/**
 * Waits between attempts to stop an agent whose ssh connection dropped under
 * it: about 25 minutes in all, which outlasts the 10 minute ceiling of an
 * OpenSSH PerSourcePenalties refusal.
 */
export const REMOTE_REAP_RETRY_DELAYS_MS: readonly number[] = [
	10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000,
];

interface PendingReap {
	target: RemoteSignalTarget;
	timer: ReturnType<typeof setTimeout> | null;
}

/** Reaps still trying to reach their host, by pid file. */
const pendingReaps = new Map<string, PendingReap>();

/**
 * Stop an SSH-hosted agent whose turn Maestro has already settled, and keep
 * trying until its host answers.
 *
 * A dropped connection is the usual reason a turn settles under a live remote
 * agent, and the same outage then refuses a single signal ssh too: on
 * 2026-11-13 a Claude turn on pedtome kept working for three minutes after its
 * tab reported exit 255, then committed and deployed, while the one-shot
 * terminate was refused by the host's sshd. Attempts repeat on
 * {@link REMOTE_REAP_RETRY_DELAYS_MS} only while ssh itself fails (exit 255,
 * a timeout, or no start). Any other exit means the host ran the script, which
 * ends quietly when the agent is already gone.
 *
 * `firstDelayMs` holds the first attempt back (the grace a Stop gives the
 * agent) while the reap is already registered, so the next launch on the tab
 * takes and runs it before its own agent starts, even inside that grace.
 */
export function reapRemoteAgent(
	target: RemoteSignalTarget,
	delaysMs: readonly number[] = REMOTE_REAP_RETRY_DELAYS_MS,
	firstDelayMs = 0
): void {
	const previous = pendingReaps.get(target.pidFile);
	if (previous?.timer) clearTimeout(previous.timer);
	const entry: PendingReap = { target, timer: null };
	pendingReaps.set(target.pidFile, entry);
	let attempt = 0;

	const isCurrent = () => pendingReaps.get(target.pidFile) === entry;
	const run = () => {
		entry.timer = null;
		if (!isCurrent()) return;
		const started = signalRemoteAgent(target, 'terminate', (exitCode) => {
			if (!isCurrent()) return;
			if (
				exitCode !== null &&
				!isSshConnectionFailure(exitCode) &&
				!(
					target.turnDir !== undefined &&
					(exitCode === DURABLE_TERMINATE_UNCONFIRMED_EXIT_CODE ||
						exitCode === DURABLE_CLEANUP_FAILED_EXIT_CODE)
				)
			) {
				pendingReaps.delete(target.pidFile);
				return;
			}
			if (attempt >= delaysMs.length) {
				// The agent may still run. The next launch on its tab still carries
				// the reap and runs it before its own agent; only the timer stops.
				if (target.promptArtifactPath !== undefined) pendingReaps.delete(target.pidFile);
				logger.warn('Gave up stopping a remote agent: its host never answered', LOG_CONTEXT, {
					sessionId: target.sessionId,
					attempts: attempt + 1,
				});
				return;
			}
			entry.timer = setTimeout(run, delaysMs[attempt++]);
			entry.timer.unref?.();
		});
		// Not a stdin-script SSH spawn, or ssh could not even be spawned: no
		// later attempt would do better.
		if (!started) pendingReaps.delete(target.pidFile);
	};
	if (firstDelayMs > 0) {
		entry.timer = setTimeout(run, firstDelayMs);
		entry.timer.unref?.();
	} else run();
}

/** The host a stdin-script ssh reaches: its destination and port, not its other options. */
function sshEndpointKey(sshCommand: string, sshArgs: readonly string[]): string | undefined {
	const connection = sshConnectionArgs(sshArgs);
	if (!connection?.length) return undefined;
	const port = connection.indexOf('-p');
	return [
		sshCommand,
		connection[connection.length - 1],
		port >= 0 ? connection[port + 1] : '',
	].join('\0');
}

/**
 * Take the reaps still pending for `sessionId` that its next launch can carry.
 *
 * The next turn on a tab resumes the same provider session, so an orphan still
 * running there is a second writer. The launch script runs the terminate
 * itself, over the connection that just proved the host answers, before it
 * starts the new agent. Only reaps for the same ssh endpoint (destination and
 * port; other options may change between turns) go: a launch on another host
 * cannot reach them, so they stay with their own retry loop.
 * Prompt-owner records stay with their retry loop too: their script reads its
 * own descriptors through `/proc/$$`, which a subshell of the launch script
 * would point at the wrong process.
 */
export function takePendingRemoteReaps(
	sessionId: string,
	sshCommand: string,
	sshArgs: readonly string[]
): RemoteSignalTarget[] {
	const endpoint = sshEndpointKey(sshCommand, sshArgs);
	const taken: RemoteSignalTarget[] = [];
	for (const [pidFile, entry] of pendingReaps) {
		if (entry.target.sessionId !== sessionId) continue;
		if (entry.target.promptArtifactPath !== undefined) continue;
		if (
			endpoint === undefined ||
			sshEndpointKey(entry.target.sshCommand, entry.target.sshArgs) !== endpoint
		)
			continue;
		if (entry.timer) clearTimeout(entry.timer);
		pendingReaps.delete(pidFile);
		taken.push(entry.target);
	}
	return taken;
}

/**
 * Launch-script lines that terminate earlier agents before this one starts.
 * Each runs in a subshell, so its `exit` and variables stay out of the launch
 * script, with stdin closed so it cannot read the script bash is still reading.
 * An earlier durable agent that cannot be proven gone ends the launch before
 * its own agent starts ({@link PRE_LAUNCH_REAP_REFUSED_EXIT_CODE}); the caller
 * hands the reaps back to their retry loop.
 */
export function buildPreLaunchReapScript(targets: readonly RemoteSignalTarget[]): string {
	const refuse =
		`[ "$?" != ${DURABLE_TERMINATE_UNCONFIRMED_EXIT_CODE} ] || ` +
		`{ printf '%s\\n' ${shellEscape(PRE_LAUNCH_REAP_REFUSED_MESSAGE)} >&2; exit ${PRE_LAUNCH_REAP_REFUSED_EXIT_CODE}; }\n`;
	return targets
		.map(
			(target) =>
				`(\n${terminateScriptFor(target)}) </dev/null >/dev/null 2>&1\n` +
				(target.turnDir !== undefined ? refuse : '')
		)
		.join('');
}

/** Test-only: drop every pending reap and its timer. */
export function __resetPendingRemoteReapsForTest(): void {
	for (const entry of pendingReaps.values()) {
		if (entry.timer) clearTimeout(entry.timer);
	}
	pendingReaps.clear();
}
