// src/main/process-manager/utils/commandKill.ts

import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import { isWindows } from '../../../shared/platformDetection';

/**
 * How long to wait after SIGTERM before escalating to SIGKILL.
 *
 * Short, because this only runs when a user has explicitly pressed Stop - they
 * have already decided they don't want the command. It is still non-zero so a
 * well-behaved program gets a chance to clean up (flush output, remove temp
 * files) rather than being torn down mid-write.
 */
export const COMMAND_KILL_ESCALATION_MS = 1500;

/**
 * Send `signal` to a process AND everything it spawned.
 *
 * Killing only the direct child is not enough for a one-off command. The child
 * is a shell (`zsh -l -i -c <command>`), and the thing the user actually wants
 * dead is usually its grandchild - the command itself, a pager it opened, a
 * build it kicked off. Worse, a surviving grandchild keeps the PTY slave fd
 * open, so node-pty may never report an exit and the UI sits on "Running..."
 * forever even though the shell is gone.
 *
 * On Unix, node-pty calls setsid() for the child, making it a process-group
 * leader; a negative pid signals that whole group. On Windows there are no
 * process groups in that sense, so we shell out to taskkill /t (tree) /f.
 */
export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (!pid || pid <= 0) return;

	if (isWindows()) {
		// /t = tree, /f = force. Non-zero exit just means it was already gone,
		// which execFileNoThrow reports rather than throwing.
		void execFileNoThrow('taskkill', ['/pid', String(pid), '/t', '/f']);
		return;
	}

	try {
		// Negative pid = "the whole process group".
		process.kill(-pid, signal);
		return;
	} catch {
		// ESRCH (group already gone) or EPERM (not a group leader - can happen if
		// setsid didn't apply). Fall through to signalling the bare pid so we at
		// least get the direct child.
	}

	try {
		process.kill(pid, signal);
	} catch {
		// Already dead. Nothing to do - the exit handler has fired or is about to.
	}
}

/**
 * Terminate a one-off command's process tree: SIGTERM now, SIGKILL shortly
 * after if it is still alive.
 *
 * SIGTERM rather than node-pty's default SIGHUP: an interactive login shell
 * (which is what these commands run under, so aliases resolve) survives SIGHUP
 * on macOS, so the default signal makes Stop silently do nothing.
 *
 * @returns a function that cancels the pending SIGKILL. **Call it when the
 * process exits.** Otherwise a late SIGKILL can land on a recycled pid and
 * take down an unrelated process.
 */
export function terminateProcessTree(pid: number, context: { sessionId: string }): () => void {
	signalProcessTree(pid, 'SIGTERM');

	const escalationTimer = setTimeout(() => {
		logger.warn(
			'[CommandKill] Command did not exit after SIGTERM, escalating to SIGKILL',
			'ProcessManager',
			{ sessionId: context.sessionId, pid }
		);
		signalProcessTree(pid, 'SIGKILL');
	}, COMMAND_KILL_ESCALATION_MS);

	return () => clearTimeout(escalationTimer);
}
