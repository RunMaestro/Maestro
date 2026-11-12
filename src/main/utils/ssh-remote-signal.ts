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
import { logger } from './logger';
import { shellEscape } from './shell-escape';

const LOG_CONTEXT = '[ssh-remote-signal]';

/** The trailing remote command every stdin-script SSH spawn ends with. */
export const SSH_STDIN_REMOTE_SHELL = ['/bin/bash', '--norc', '--noprofile', '-s'] as const;

/** How long a one-shot signal ssh may run before it is killed. */
const SIGNAL_SSH_TIMEOUT_MS = 30_000;

/** Pid records older than this are swept by the next launch on that host. */
const PID_FILE_MAX_AGE_MIN = 24 * 60;

/** A fresh remote pid-file path for one SSH agent spawn. */
export function newRemotePidFilePath(): string {
	return `/tmp/maestro-agent-${randomUUID()}.pid`;
}

/**
 * Prefix a stdin launch script with the line that records the agent's pid.
 *
 * `$$` is the remote bash, which the script later `exec`s into the agent, so
 * the recorded pid is the agent's. The start time is recorded beside it so a
 * later signal can refuse a pid the OS has since handed to something else.
 */
export function withRemotePidRecord(script: string, pidFile: string): string {
	const f = shellEscape(pidFile);
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
export function buildRemoteSignalScript(pidFile: string, mode: RemoteSignalMode): string {
	const f = shellEscape(pidFile);
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
	target: { sshCommand: string; sshArgs: readonly string[]; pidFile: string; sessionId: string },
	mode: RemoteSignalMode
): boolean {
	const connection = sshConnectionArgs(target.sshArgs);
	if (!connection) return false;

	try {
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
			logger.warn('Remote agent signal ssh failed to start', LOG_CONTEXT, {
				sessionId: target.sessionId,
				mode,
				error: String(error),
			});
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			logger.info('Remote agent signal sent', LOG_CONTEXT, {
				sessionId: target.sessionId,
				mode,
				exitCode: code,
			});
		});
		child.stdin?.on('error', () => {
			// EPIPE when ssh fails to connect; the exit/error handlers report it.
		});
		child.stdin?.end(buildRemoteSignalScript(target.pidFile, mode));
		child.unref();
		return true;
	} catch (error) {
		logger.warn('Could not signal remote agent', LOG_CONTEXT, {
			sessionId: target.sessionId,
			mode,
			error: String(error),
		});
		return false;
	}
}
