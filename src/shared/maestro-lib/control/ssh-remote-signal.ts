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

/**
 * Signal an SSH-hosted agent on its remote host. Fire-and-forget: it never
 * throws, the one-shot ssh is detached so it finishes even if the app is
 * quitting, and it is killed if it outlives {@link SIGNAL_SSH_TIMEOUT_MS}.
 */
export function signalRemoteAgent(
	target: {
		sshCommand: string;
		sshArgs: readonly string[];
		pidFile: string;
		sessionId: string;
		/** Remote-owned file; enables descriptor-preserving cancellation. */
		promptArtifactPath?: string;
	},
	mode: RemoteSignalMode
): boolean {
	const connection = sshConnectionArgs(target.sshArgs);
	if (!connection) return false;

	try {
		const script = buildRemoteSignalScript(target.pidFile, mode, target.promptArtifactPath);
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
		child.on('error', () => {
			clearTimeout(timer);
			logger.warn('Remote agent signal ssh failed to start', LOG_CONTEXT, {
				sessionId: target.sessionId,
				mode,
			});
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
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
	} catch {
		logger.warn('Could not signal remote agent', LOG_CONTEXT, {
			sessionId: target.sessionId,
			mode,
		});
		return false;
	}
}
