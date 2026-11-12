// src/main/process-manager/utils/commandKill.ts

import { execFileNoThrow } from '../../utils/execFile';
import { killQuiet } from '../../utils/processTree';

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
 * Re-exported from `shared/ptyKill` so the process-manager callers keep one
 * import site, exactly as `killProcessTreeNow` is above. The implementation
 * lives in `shared/` because the standalone `maestro-p` CLI drives its own PTY
 * and must follow the same rule (Sentry MAESTRO-XZ).
 */
export { killPty } from '../../../shared/ptyKill';

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
