// src/main/process-manager/utils/commandKill.ts

import { execFileNoThrow, execFileSyncNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import { isWindows } from '../../../shared/platformDetection';

/**
 * Signal a pid, swallowing "already gone" / "not permitted".
 * Returns true when the signal was delivered.
 */
function killQuiet(target: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(target, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Every descendant of `pid`, nearest first, read synchronously.
 *
 * MUST be called BEFORE anything in the tree is killed. The moment a parent
 * dies its children are re-parented to launchd/init, so their ppid no longer
 * leads back here and a snapshot taken even a few milliseconds later finds
 * nothing. (Session id would survive that, but macOS `ps -o sess=` reports 0,
 * so it is not usable here - verified, not assumed.)
 */
function collectDescendants(pid: number): number[] {
	const table = execFileSyncNoThrow('ps', ['-eo', 'pid=,ppid=']);
	if (!table) return [];

	const childrenByParent = new Map<number, number[]>();
	for (const line of table.split('\n')) {
		const [childRaw, parentRaw] = line.trim().split(/\s+/);
		const child = Number(childRaw);
		const parent = Number(parentRaw);
		if (!child || Number.isNaN(parent)) continue;
		const siblings = childrenByParent.get(parent);
		if (siblings) siblings.push(child);
		else childrenByParent.set(parent, [child]);
	}

	// Breadth-first, so the result is ordered nearest-descendant first.
	// `seen` guards against a malformed table looping.
	const descendants: number[] = [];
	const seen = new Set<number>([pid]);
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const child of childrenByParent.get(current) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			descendants.push(child);
			queue.push(child);
		}
	}
	return descendants;
}

/**
 * Kill a command's whole process tree RIGHT NOW, with SIGKILL.
 *
 * No grace period and no SIGTERM first. Stop is an explicit, deliberate user
 * action on a command they have decided they do not want; making them wait out
 * a negotiation with a process that may never honour it is the wrong trade.
 * SIGKILL cannot be caught, blocked, or ignored, so this is the only way the
 * button can actually mean what it says.
 *
 * Three targets, because none of them subsumes the others:
 *
 *  - **Descendants**, snapshotted before anything dies (see collectDescendants)
 *    and killed deepest-last, so a parent cannot fork more while we work.
 *  - **The process group** (negative pid) - children that stayed in the
 *    parent's group, the common case for a plain `sh -c 'cmd'`.
 *  - **The pid itself**, NOT as an else-branch: `kill(-pid)` succeeding only
 *    proves *something* in that group was signalled, and an interactive shell
 *    with job control keeps itself in that group while the actual job runs in
 *    a new one.
 *
 * Windows has no process groups in this sense, so `taskkill /t /f` walks the
 * tree instead. Synchronous there too, for the same reason.
 *
 * The cost of no grace period: a command killed mid-write (`npm install`, a
 * file copy) leaves whatever partial state it had. That is the accepted trade
 * for Stop being instant and certain.
 */
export function killProcessTreeNow(pid: number, context: { sessionId: string }): void {
	if (!pid || pid <= 0) return;

	if (isWindows()) {
		execFileSyncNoThrow('taskkill', ['/pid', String(pid), '/t', '/f']);
		return;
	}

	// Snapshot first - this is unrecoverable once the parent is gone.
	const descendants = collectDescendants(pid);

	// Deepest-last: reversing the breadth-first order kills leaves before their
	// parents, so nothing gets a chance to spawn a replacement.
	for (const descendant of descendants.reverse()) {
		killQuiet(descendant, 'SIGKILL');
		killQuiet(-descendant, 'SIGKILL');
	}

	killQuiet(-pid, 'SIGKILL');
	killQuiet(pid, 'SIGKILL');

	logger.debug('[CommandKill] Killed command process tree', 'ProcessManager', {
		sessionId: context.sessionId,
		pid,
		descendants: descendants.length,
	});
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
