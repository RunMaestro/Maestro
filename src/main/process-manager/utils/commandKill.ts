// src/main/process-manager/utils/commandKill.ts

import type * as pty from 'node-pty';

import { execFileNoThrow } from '../../utils/execFile';
import { killQuiet } from '../../utils/processTree';
import { isWindows } from '../../../shared/platformDetection';

/**
 * Kill a command's whole process tree RIGHT NOW, with SIGKILL.
 *
 * Re-exported from `utils/processTree` so the process-manager callers keep one
 * import site. That module is the canonical implementation and is shared with
 * `execFileStreaming`, whose Cancel needs exactly the same guarantee.
 */
export { killProcessTreeNow } from '../../utils/processTree';

/**
 * Kill a PTY, dropping the POSIX signal on Windows.
 *
 * node-pty's Windows backend throws `Signals not supported on windows.` for any
 * signal argument at all - it only implements the no-argument form, which closes
 * the pty and kills the ConPTY/winpty agent. On POSIX the signal is honoured, so
 * it is passed straight through.
 *
 * A plain try/catch around `ptyProcess.kill(signal)` does NOT contain that throw.
 * node-pty queues the call as a *deferred* whenever the agent has not signalled
 * ready yet, and later runs the queue from a socket `data` handler - so the throw
 * surfaces on a completely different stack, escapes as an uncaught exception, and
 * takes the main process down (Sentry MAESTRO-XZ: 822 fatal events from a single
 * Windows install). Callers must therefore never hand node-pty a signal on
 * Windows, rather than trying to catch what it throws.
 *
 * Windows PTYs are normally torn down by pid with `taskkill /t /f`, which also
 * gets grandchildren. This path is what remains when the pid is unavailable -
 * ConPTY reports pid 0 when the shell fails to launch - and a signal-less kill()
 * is then the only correct call.
 */
export function killPty(ptyProcess: pty.IPty, signal: NodeJS.Signals): void {
	ptyProcess.kill(isWindows() ? undefined : signal);
}

/**
 * Best-effort async sweep for anything that outlived the synchronous kill.
 *
 * Deliberately fire-and-forget: the tree is already dead by the time this runs,
 * so it exists only to catch a process that was mid-fork during the kill. Never
 * awaited, and never gates the UI.
 */
export function sweepStragglers(pid: number): void {
	void execFileNoThrow('ps', ['-eo', 'pid=,ppid=']).then(({ stdout }) => {
		if (!stdout) return;
		for (const line of stdout.split('\n')) {
			const [childRaw, parentRaw] = line.trim().split(/\s+/);
			if (Number(parentRaw) === pid && Number(childRaw)) {
				killQuiet(Number(childRaw), 'SIGKILL');
			}
		}
	});
}
