// src/shared/maestro-lib/control/process-tree.ts

import { execFileSyncNoThrow } from '../launch/exec-file';
import { logger } from '../host';
import { isWindows } from '../../platformDetection';

/**
 * Signal a pid, swallowing "already gone" / "not permitted".
 * Returns true when the signal was delivered.
 */
export function killQuiet(target: number, signal: NodeJS.Signals): boolean {
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
 * Kill a process tree RIGHT NOW, with SIGKILL.
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
 * Killing descendants is not optional politeness: a `git push` whose pre-push
 * hook is running a test suite holds the pipes open through that grandchild, so
 * signalling only git leaves the run neither dead nor finished.
 *
 * Windows has no process groups in this sense, so `taskkill /t /f` walks the
 * tree instead. Synchronous there too, for the same reason.
 *
 * The cost of no grace period: a command killed mid-write (`npm install`, a
 * file copy) leaves whatever partial state it had. That is the accepted trade
 * for Stop being instant and certain.
 */
export function killProcessTreeNow(
	pid: number,
	context: { sessionId?: string; label?: string }
): void {
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

	logger.debug('[ProcessTree] Killed process tree', 'ProcessManager', {
		sessionId: context.sessionId,
		label: context.label,
		pid,
		descendants: descendants.length,
	});
}

/**
 * One process in a descendant snapshot.
 *
 * `startedAt` is what makes the entry safe to act on LATER. A snapshot is taken
 * before the first stop signal and used after the agent has exited, seconds
 * apart, and in that gap a pid can be freed and handed to an unrelated process.
 * A pid is only ever signalled when its start time still matches.
 */
export interface ProcessSnapshotEntry {
	pid: number;
	/** `ps -o lstart=` text, compared verbatim and never parsed. */
	startedAt: string;
}

interface ProcessTableRow extends ProcessSnapshotEntry {
	ppid: number;
}

/**
 * The process table with start times. Empty when `ps` cannot report `lstart`
 * (BusyBox), which turns every caller below into a no-op rather than a guess.
 */
function readProcessTable(): ProcessTableRow[] {
	const table = execFileSyncNoThrow('ps', ['-eo', 'pid=,ppid=,lstart=']);
	if (!table) return [];

	const rows: ProcessTableRow[] = [];
	for (const line of table.split('\n')) {
		const [pidRaw, ppidRaw, ...startParts] = line.trim().split(/\s+/);
		const pid = Number(pidRaw);
		const ppid = Number(ppidRaw);
		if (!pid || Number.isNaN(ppid) || startParts.length === 0) continue;
		rows.push({ pid, ppid, startedAt: startParts.join(' ') });
	}
	return rows;
}

/** Descendants of every root in `roots`, nearest first, from one table read. */
function descendantsOf(rows: ProcessTableRow[], roots: number[]): ProcessTableRow[] {
	const childrenByParent = new Map<number, ProcessTableRow[]>();
	for (const row of rows) {
		const siblings = childrenByParent.get(row.ppid);
		if (siblings) siblings.push(row);
		else childrenByParent.set(row.ppid, [row]);
	}

	const descendants: ProcessTableRow[] = [];
	const seen = new Set<number>(roots);
	const queue = [...roots];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const child of childrenByParent.get(current) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			descendants.push(child);
			queue.push(child.pid);
		}
	}
	return descendants;
}

/** What {@link snapshotProcessTree} recorded about a process and its tree. */
export interface ProcessTreeSnapshot {
	/**
	 * True when `pid` is a running child of THIS process. A tree is only ever
	 * killed on the strength of this: a pid that is not our own child is either
	 * stale (its process exited and the number was reused) or was never ours.
	 */
	owned: boolean;
	descendants: ProcessSnapshotEntry[];
}

const UNOWNED_TREE: ProcessTreeSnapshot = { owned: false, descendants: [] };

/**
 * Record a child's descendants so the ones that outlive it can be found.
 *
 * MUST be called BEFORE the first stop signal, for the reason given on
 * `collectDescendants`: once the parent dies its children are re-parented and
 * no longer lead back to it.
 *
 * Unowned and empty on Windows, where `taskkill /t` walks the tree itself.
 */
export function snapshotProcessTree(pid: number): ProcessTreeSnapshot {
	if (!pid || pid <= 0 || isWindows()) return UNOWNED_TREE;

	const rows = readProcessTable();
	const root = rows.find((row) => row.pid === pid);
	if (!root || root.ppid !== process.pid) return UNOWNED_TREE;

	return {
		owned: true,
		descendants: descendantsOf(rows, [pid]).map(({ pid: descendant, startedAt }) => ({
			pid: descendant,
			startedAt,
		})),
	};
}

/**
 * SIGKILL whatever in `snapshot` is still running, plus anything those
 * survivors started since.
 *
 * An agent that exits on a stop signal does not take its tools with it: a
 * stopped OpenCode turn left the `sleep` its shell tool had started running
 * after both SIGINT and SIGTERM. The survivor also holds the agent's stdout
 * pipe open, so the turn's `close` never fires and the caller waits on a run
 * that is already over.
 *
 * Returns how many processes were signalled.
 */
export function killSurvivors(
	snapshot: ProcessSnapshotEntry[],
	context: { sessionId?: string; label?: string }
): number {
	if (snapshot.length === 0 || isWindows()) return 0;

	const rows = readProcessTable();
	const startedAtByPid = new Map(rows.map((row) => [row.pid, row.startedAt]));
	const survivors = snapshot.filter((entry) => startedAtByPid.get(entry.pid) === entry.startedAt);
	if (survivors.length === 0) return 0;

	const survivorPids = survivors.map((entry) => entry.pid);
	const targets = [...survivorPids, ...descendantsOf(rows, survivorPids).map((row) => row.pid)];

	// Deepest-last, as in killProcessTreeNow.
	for (const target of [...targets].reverse()) {
		killQuiet(target, 'SIGKILL');
	}

	logger.debug('[ProcessTree] Killed processes that outlived their agent', 'ProcessManager', {
		sessionId: context.sessionId,
		label: context.label,
		survivors: targets.length,
	});
	return targets.length;
}
