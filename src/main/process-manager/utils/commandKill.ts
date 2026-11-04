// src/main/process-manager/utils/commandKill.ts

import { execFileNoThrow } from '../../utils/execFile';
import { killQuiet } from '../../utils/processTree';
import { beginGlobalWorktreeActivity } from '../../git/worktreeActivity';
import { withWorktreeTurnActivity } from '../../git/worktreeTurnActivity';
import { captureException } from '../../utils/sentry';
import { logger } from '../../utils/logger';

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
 * Deliberately fire-and-forget after the synchronous kill request, to catch a
 * process that was mid-fork during the kill. Never awaited, and never gates the
 * UI. Completion does not establish that all descendants have terminated.
 */
export function sweepStragglers(pid: number): void {
	withWorktreeTurnActivity(
		(_start, observe) => {
			// UI settlement and ps results do not prove native close. Unknown
			// launch/observation stays busy; signalling proves no descendant exit.
			const releaseNative = beginGlobalWorktreeActivity();
			void observe(
				execFileNoThrow('ps', ['-eo', 'pid=,ppid='], undefined, undefined, (child) =>
					child.once('close', releaseNative)
				)
					.then(({ stdout }) => {
						if (!stdout) return;
						for (const line of stdout.split('\n')) {
							const [childRaw, parentRaw] = line.trim().split(/\s+/);
							if (Number(parentRaw) === pid && Number(childRaw)) {
								killQuiet(Number(childRaw), 'SIGKILL');
							}
						}
					})
					.catch((error) => captureException(error))
			);
		},
		(error) =>
			logger.warn('Failed to sweep command stragglers', 'ProcessManager', { error: String(error) })
	);
}
