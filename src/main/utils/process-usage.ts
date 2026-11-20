/**
 * Memory and CPU of process trees, from one read of the OS process table.
 *
 * The Application Stats panel asks "what does this agent cost?", and the
 * process the app spawned is rarely the answer: an agent CLI starts MCP
 * servers and shells, and the model server starts a worker per loaded model.
 * So each root is measured with every descendant, and a total across roots
 * counts a shared process once.
 *
 * macOS and Linux read `ps -A -o pid=,ppid=,rss=,%cpu=` (both accept that
 * form). Windows has no equivalent without a native dependency, so it reads as
 * unmeasured rather than as zero.
 */

import { descendantsOf } from './processTree';
import { execFileNoThrow } from './execFile';
import { isWindows } from '../../shared/platformDetection';
import type { ProcessTreeUsage } from '../../shared/appStats';

/** One row of the process table: who, whose child, how much memory and CPU. */
export interface ProcessUsageRow {
	pid: number;
	ppid: number;
	rssBytes: number;
	cpuPercent: number;
}

export interface ProcessTreeUsageReport {
	/** False when the table could not be read; every tree is then absent. */
	measured: boolean;
	/** Per root pid. A root that is not running has no entry. */
	trees: Map<number, ProcessTreeUsage>;
	/** Every process under every root, each counted once. */
	total: ProcessTreeUsage;
}

const PS_USAGE_ARGS = ['-A', '-o', 'pid=,ppid=,rss=,%cpu='];
const PS_TIMEOUT_MS = 3000;

const EMPTY_USAGE: ProcessTreeUsage = Object.freeze({
	processCount: 0,
	rssBytes: 0,
	cpuPercent: 0,
});

/**
 * Rows from `ps -o pid=,ppid=,rss=,%cpu=` output. `rss` is in KiB on both
 * macOS and Linux. A line that does not parse is skipped.
 */
export function parsePsUsageTable(table: string): ProcessUsageRow[] {
	const rows: ProcessUsageRow[] = [];
	for (const line of table.split('\n')) {
		const [pidRaw, ppidRaw, rssRaw, cpuRaw] = line.trim().split(/\s+/);
		const pid = Number(pidRaw);
		const ppid = Number(ppidRaw);
		const rssKb = Number(rssRaw);
		// Some locales print the CPU column with a decimal comma.
		const cpu = Number((cpuRaw ?? '').replace(',', '.'));
		if (!pid || !Number.isFinite(ppid) || !Number.isFinite(rssKb) || !Number.isFinite(cpu)) {
			continue;
		}
		rows.push({ pid, ppid, rssBytes: rssKb * 1024, cpuPercent: cpu });
	}
	return rows;
}

function sumRows(rows: Iterable<ProcessUsageRow>): ProcessTreeUsage {
	let processCount = 0;
	let rssBytes = 0;
	let cpuPercent = 0;
	for (const row of rows) {
		processCount++;
		rssBytes += row.rssBytes;
		cpuPercent += row.cpuPercent;
	}
	return { processCount, rssBytes, cpuPercent };
}

/** Measure each root's tree, and the union of all of them, from one table. */
export function summarizeProcessTrees(
	rows: readonly ProcessUsageRow[],
	roots: readonly number[]
): Omit<ProcessTreeUsageReport, 'measured'> {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const trees = new Map<number, ProcessTreeUsage>();
	const union = new Map<number, ProcessUsageRow>();

	for (const root of new Set(roots)) {
		const rootRow = byPid.get(root);
		if (!rootRow) continue;
		const tree = [rootRow, ...descendantsOf(rows, [root])];
		trees.set(root, sumRows(tree));
		for (const row of tree) union.set(row.pid, row);
	}

	return { trees, total: sumRows(union.values()) };
}

/** Read the process table once and measure every root's tree. */
export async function readProcessTreeUsage(
	roots: readonly number[]
): Promise<ProcessTreeUsageReport> {
	const unmeasured: ProcessTreeUsageReport = {
		measured: false,
		trees: new Map(),
		total: { ...EMPTY_USAGE },
	};
	if (isWindows()) return unmeasured;

	const live = roots.filter((pid) => Number.isInteger(pid) && pid > 0);
	if (live.length === 0) return { ...unmeasured, measured: true };

	const result = await execFileNoThrow('ps', PS_USAGE_ARGS, undefined, {
		timeout: PS_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) return unmeasured;

	return { measured: true, ...summarizeProcessTrees(parsePsUsageTable(result.stdout), live) };
}
