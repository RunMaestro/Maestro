/**
 * Desktop guard for the data directory (requirement CO-5).
 *
 * A headless runtime (a TUI hosting in process, or a detached `maestro-cli host`)
 * is the only writer of the data directory while it runs. If the desktop loaded
 * its stores on top of one, the desktop's next flush would overwrite the
 * runtime's writes. So the desktop takes the same lock the runtime takes, in
 * mode `desktop`, before it touches a store, and quits when a headless runtime
 * already holds the directory.
 *
 * It acquires rather than only checks (RT2): the desktop publishes
 * `cli-server.json` seconds after its stores load, and only the lock closes that
 * start race for a TUI launching in the gap.
 *
 * Design: `Plans/maestro-tui-runtime.md` section 4.4.
 */

import {
	acquireDataDirLock,
	type DataDirLock,
	type DataDirRefusal,
} from '../../shared/maestro-lib/runtime/data-dir-lock';
import { resolveMaestroPaths } from '../../shared/maestro-lib/paths/resolve';

export type DataDirClaim =
	| {
			/** This process holds the lock. Call `release` on quit. */
			outcome: 'claimed';
			release: () => void;
			/**
			 * The held lock, for the library runtime to adopt (DG1) so a desktop that hosts one has a single
			 * lock, a single heartbeat, and a single release.
			 */
			lock: DataDirLock;
			/** Stop the guard's own heartbeat, because the adopting runtime beats the lock instead. Idempotent. */
			pauseHeartbeat: () => void;
			/** Beat again: the runtime refused to start and the guard is the lock's only keeper. Idempotent. */
			resumeHeartbeat: () => void;
	  }
	/** A headless runtime holds the directory. The desktop must not load. */
	| { outcome: 'blocked'; title: string; message: string }
	/**
	 * Carry on without the lock: another desktop owns it (the single-instance lock
	 * quits this one and focuses that one), or the lock could not be taken at all
	 * (a read-only directory must not brick the app).
	 */
	| { outcome: 'proceed'; reason: string };

export interface DataDirGuardDeps {
	acquire?: typeof acquireDataDirLock;
	/** Called once, with the reason, if the lock is taken over while the desktop runs. */
	onLost?: (reason: string) => void;
}

const BLOCKED_TITLE = 'Maestro is already running headless';

const WOULD_OVERWRITE = 'Maestro Desktop would overwrite its changes, so it will not start.';

function startedLine(startedAt: string | number | undefined): string {
	const time = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
	return time && Number.isFinite(time) ? `\nStarted: ${new Date(time).toLocaleString()}` : '';
}

/** The dialog text for a refusal that means "a headless runtime has it", or null for any other refusal. */
function describeBlock(refusal: DataDirRefusal): string | null {
	if (refusal.reason === 'held') {
		const { holder } = refusal;
		const host = holder.host ? `\nHost: ${holder.host}` : '';
		return (
			`The Maestro TUI (pid ${holder.pid}) is running on this data directory.` +
			`${startedLine(holder.startedAt)}${host}\n\n` +
			`${WOULD_OVERWRITE} Quit that TUI, then open Maestro again.`
		);
	}
	if (refusal.reason === 'host-running' && refusal.host.kind === 'headless') {
		const { host } = refusal;
		return (
			`A headless Maestro host (pid ${host.pid}) is running on this data directory.` +
			`${startedLine(host.startedAt)}\n\n` +
			`${WOULD_OVERWRITE} Stop it with \`maestro-cli host stop\`, then open Maestro again.`
		);
	}
	return null;
}

/**
 * Take the data directory for the desktop, or say why not. Pure of Electron:
 * the caller shows the dialog and exits, so a test needs neither.
 */
export function claimDataDirForDesktop(
	userDataDir: string,
	deps: DataDirGuardDeps = {}
): DataDirClaim {
	const acquire = deps.acquire ?? acquireDataDirLock;
	const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userDataDir } });
	const result = acquire(paths, 'desktop');

	if (!result.ok) {
		const blocked = describeBlock(result.refusal);
		if (blocked) return { outcome: 'blocked', title: BLOCKED_TITLE, message: blocked };
		return { outcome: 'proceed', reason: result.refusal.message };
	}

	const lock: DataDirLock = result.lock;
	let stopHeartbeat: (() => void) | undefined;
	const startBeating = (): void => {
		stopHeartbeat ??= lock.startHeartbeat((reason) => deps.onLost?.(reason));
	};
	const stopBeating = (): void => {
		stopHeartbeat?.();
		stopHeartbeat = undefined;
	};
	startBeating();
	return {
		outcome: 'claimed',
		release: () => {
			stopBeating();
			lock.release();
		},
		lock,
		pauseHeartbeat: stopBeating,
		resumeHeartbeat: startBeating,
	};
}
