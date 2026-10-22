import fs from 'fs';

/**
 * Pre-flight check on the working directory a process is about to be spawned in.
 *
 * A missing `cwd` is an ordinary user state - a deleted worktree, an unmounted
 * volume, a renamed project folder, a directory that only exists on the other
 * machine - and it has to be caught BEFORE the spawn, because node-pty's
 * Windows path does not fail in a place anyone can catch:
 *
 *   `pty.spawn()` returns a live-looking object and defers the real work.
 *   `WindowsPtyAgent._completePtyConnection()` runs later, from the conout
 *   worker's `onReady` callback (or a 5 s timeout), and calls the native
 *   `conptyNative.connect(pty, commandLine, cwd, ...)` there. A `cwd` that is
 *   not a directory throws win32 `error 267` (ERROR_DIRECTORY) out of that
 *   callback - past the `try`/`catch` in `PtySpawner.spawn`, past the IPC
 *   handler, into the main-process uncaught-exception handler.
 *
 * The spawn is reported as successful, the pty is a zombie with no inner pid,
 * and whatever wanted the process asks again. Sentry grouped 998 of these
 * crashes under one issue (MAESTRO-S0), 995 of them from a single installation
 * relaunching into the same missing directory.
 *
 * POSIX is better behaved (child_process emits a catchable ENOENT), but a
 * missing directory is equally not-runnable there, so the check is unconditional.
 */

/**
 * Describe why `cwd` cannot be used, or `null` when it is fine.
 *
 * Deliberately conservative: it only reports a directory we can PROVE is
 * unusable. A stat that fails for any other reason (EACCES on a locked folder,
 * EIO on a flaky network mount) returns `null` and lets the spawn proceed, so a
 * surprising filesystem can never lock a user out of starting their agent.
 *
 * An empty/absent `cwd` is also fine: the child then inherits ours, which is
 * what every caller that omits it intends.
 */
export function unusableCwdReason(cwd: string | undefined): string | null {
	if (!cwd) return null;

	let stats: fs.Stats;
	try {
		stats = fs.statSync(cwd);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return `Working directory does not exist: ${cwd}`;
		}
		return null;
	}

	if (!stats.isDirectory()) {
		return `Working directory is not a directory: ${cwd}`;
	}

	return null;
}
