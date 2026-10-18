// src/shared/maestro-lib/control/process-tree.ts

import { readdirSync, readFileSync } from 'fs';
import { readdir, readFile } from 'fs/promises';

import { execFileNoThrow, execFileSyncNoThrow } from '../launch/exec-file';
import { logger } from '../host';
import { isLinux, isWindows } from '../../platformDetection';

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
	/**
	 * When the process started, as the platform's process table words it: the
	 * `ps -o lstart=` text on macOS, the `starttime` tick count from
	 * `/proc/<pid>/stat` on Linux. Compared verbatim and never parsed.
	 */
	startedAt: string;
}

export interface ProcessTableRow extends ProcessSnapshotEntry {
	ppid: number;
}

const PS_TABLE_ARGS = ['-eo', 'pid=,ppid=,lstart='];
const PROC_DIR = '/proc';
const PID_NAME = /^\d+$/;

/** Rows from `ps -eo pid=,ppid=,lstart=` output. */
function parsePsTable(table: string): ProcessTableRow[] {
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

/**
 * One row from the text of `/proc/<pid>/stat`, or null when it is not one.
 *
 * The line is `pid (comm) state ppid ... starttime ...`. `comm` is the
 * executable's name and may hold spaces and parentheses, so the fields are
 * counted from the LAST `)`: state is the first after it, the parent pid the
 * second, and `starttime` (field 22 of the line) the twentieth.
 */
export function parseProcStat(text: string): ProcessTableRow | null {
	const open = text.indexOf('(');
	const close = text.lastIndexOf(')');
	if (open < 0 || close < open) return null;

	const pid = Number(text.slice(0, open).trim());
	const fields = text
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	const ppid = Number(fields[1]);
	const startedAt = fields[19];
	if (!pid || Number.isNaN(ppid) || !startedAt) return null;
	return { pid, ppid, startedAt };
}

/**
 * The process table with start times, read synchronously.
 *
 * Linux reads `/proc` directly: it needs no `ps` (BusyBox `ps`, on Alpine and
 * in many containers, cannot report `lstart`) and its start time is an exact
 * tick count. macOS has no `/proc`, so it asks `ps`. Empty when the table
 * cannot be read, which turns every caller below into a no-op rather than a
 * guess.
 */
function readProcessTable(): ProcessTableRow[] {
	if (!isLinux()) {
		return parsePsTable(execFileSyncNoThrow('ps', PS_TABLE_ARGS));
	}

	let names: string[];
	try {
		names = readdirSync(PROC_DIR);
	} catch {
		return [];
	}
	const rows: ProcessTableRow[] = [];
	for (const name of names) {
		if (!PID_NAME.test(name)) continue;
		try {
			const row = parseProcStat(readFileSync(`${PROC_DIR}/${name}/stat`, 'utf8'));
			if (row) rows.push(row);
		} catch {
			// The process exited between the listing and the read.
		}
	}
	return rows;
}

/** {@link readProcessTable} without blocking, for a read that can wait. */
async function readProcessTableAsync(): Promise<ProcessTableRow[]> {
	if (!isLinux()) {
		const result = await execFileNoThrow('ps', PS_TABLE_ARGS);
		return result.exitCode === 0 ? parsePsTable(result.stdout) : [];
	}

	let names: string[];
	try {
		names = await readdir(PROC_DIR);
	} catch {
		return [];
	}
	const rows = await Promise.all(
		names
			.filter((name) => PID_NAME.test(name))
			.map(async (name) => {
				try {
					return parseProcStat(await readFile(`${PROC_DIR}/${name}/stat`, 'utf8'));
				} catch {
					// The process exited between the listing and the read.
					return null;
				}
			})
	);
	return rows.filter((row): row is ProcessTableRow => row !== null);
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
 * Add to `snapshot` what the tree has started since it was recorded.
 *
 * New processes are found under the agent itself, while it is still a running
 * child of this process, and under every recorded descendant that is still
 * the same process. A descendant whose pid now belongs to something else
 * (its start time differs) is not followed.
 *
 * Returns `snapshot` itself when nothing was added.
 */
export function mergeProcessTree(
	pid: number,
	snapshot: ProcessTreeSnapshot,
	rows: ProcessTableRow[]
): ProcessTreeSnapshot {
	if (!snapshot.owned || rows.length === 0) return snapshot;

	const startedAtByPid = new Map(rows.map((row) => [row.pid, row.startedAt]));
	const roots = snapshot.descendants
		.filter((entry) => startedAtByPid.get(entry.pid) === entry.startedAt)
		.map((entry) => entry.pid);
	const agent = rows.find((row) => row.pid === pid);
	if (agent && agent.ppid === process.pid) roots.unshift(pid);
	if (roots.length === 0) return snapshot;

	const recorded = new Set(snapshot.descendants.map((entry) => `${entry.pid} ${entry.startedAt}`));
	const added = descendantsOf(rows, roots).filter(
		(row) => !recorded.has(`${row.pid} ${row.startedAt}`)
	);
	if (added.length === 0) return snapshot;

	return {
		owned: true,
		descendants: [
			...snapshot.descendants,
			...added.map(({ pid: descendant, startedAt }) => ({ pid: descendant, startedAt })),
		],
	};
}

/**
 * Re-read the process table and {@link mergeProcessTree} it into `snapshot`.
 *
 * A snapshot taken when a stop is requested misses a tool the agent starts
 * afterwards, while it is still winding down. The stop ladder calls this on an
 * interval while a stop is pending, so such a tool is recorded too and swept
 * with the rest. It does not block: the first snapshot had to be synchronous
 * (nothing may die before it is taken), a refresh does not.
 */
export async function refreshProcessTree(
	pid: number,
	snapshot: ProcessTreeSnapshot
): Promise<ProcessTreeSnapshot> {
	if (!pid || pid <= 0 || !snapshot.owned || isWindows()) return snapshot;
	return mergeProcessTree(pid, snapshot, await readProcessTableAsync());
}

/**
 * SIGKILL whatever in `snapshot` is still running, plus anything those
 * survivors started since.
 *
 * An agent that exits on a stop signal does not take its tools with it: a
 * stopped OpenCode turn left the `sleep` its shell tool had started running
 * after both SIGINT and SIGTERM, still doing its work with nothing left to
 * stop it.
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
