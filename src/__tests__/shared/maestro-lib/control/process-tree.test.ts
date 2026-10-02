/**
 * The descendant snapshot and the sweep that follows an agent's exit.
 *
 * Both act on pids read from the process table seconds apart, so every test
 * here defends one of two things: a process that is not provably ours is never
 * signalled, and a tool that outlived its agent always is.
 *
 * `killProcessTreeNow`, which lives in the same module, is covered by
 * `src/__tests__/main/process-manager/utils/commandKill.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	execFileSyncNoThrow: vi.fn(() => ''),
	execFileNoThrow: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 as number | string })),
	isWindows: vi.fn(() => false),
	isLinux: vi.fn(() => false),
	readdirSync: vi.fn((): string[] => []),
	readFileSync: vi.fn((_path: string): string => ''),
	readdir: vi.fn(async (): Promise<string[]> => []),
	readFile: vi.fn(async (_path: string): Promise<string> => ''),
}));

vi.mock('../../../../shared/maestro-lib/launch/exec-file', () => ({
	execFileSyncNoThrow: mocks.execFileSyncNoThrow,
	execFileNoThrow: mocks.execFileNoThrow,
}));

// Pinned, so the `ps` tests and the `/proc` tests each run on every host.
vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: mocks.isWindows,
	isLinux: mocks.isLinux,
}));

vi.mock('fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs')>()),
	readdirSync: mocks.readdirSync,
	readFileSync: mocks.readFileSync,
}));

vi.mock('fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs/promises')>()),
	readdir: mocks.readdir,
	readFile: mocks.readFile,
}));

import {
	snapshotProcessTree,
	killSurvivors,
	mergeProcessTree,
	parseProcStat,
	refreshProcessTree,
	type ProcessTableRow,
} from '../../../../shared/maestro-lib/control/process-tree';

const SELF = process.pid;
const AGENT = 4242;
const CTX = { sessionId: 'agent-1' };

const MORNING = 'Tue Sep 29 10:00:00 2026';
const LATER = 'Tue Sep 29 10:00:07 2026';

/** One `ps -eo pid=,ppid=,lstart=` row, padded the way ps pads it. */
function row(pid: number, ppid: number, startedAt = MORNING): string {
	return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${startedAt}`;
}

function processTable(...rows: string[]): void {
	mocks.execFileSyncNoThrow.mockReturnValue(rows.join('\n') + '\n');
}

/**
 * The text of one `/proc/<pid>/stat`, with the 52 fields a real one has.
 * `starttime` (field 22) is the only one after the parent pid that is read.
 */
function procStat(pid: number, ppid: number, starttime: number, comm = 'node'): string {
	const afterComm = ['S', ppid, pid, pid, 0, -1, 4194304, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0];
	const rest = new Array(30).fill(0);
	return `${pid} (${comm}) ${[...afterComm, starttime, ...rest].join(' ')}\n`;
}

/** Serve `/proc` from a map of pid to stat text, to both the sync and async readers. */
function procTable(stats: Record<number, string>, extraNames: string[] = []): void {
	const names = [...Object.keys(stats), ...extraNames];
	const read = (path: string): string => {
		const match = /^\/proc\/(\d+)\/stat$/.exec(path);
		const text = match ? stats[Number(match[1])] : undefined;
		if (text === undefined) throw new Error(`ENOENT: ${path}`);
		return text;
	};
	mocks.readdirSync.mockReturnValue(names);
	mocks.readFileSync.mockImplementation(read);
	mocks.readdir.mockResolvedValue(names);
	mocks.readFile.mockImplementation(async (path: string) => read(path));
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isWindows.mockReturnValue(false);
	mocks.isLinux.mockReturnValue(false);
	mocks.execFileSyncNoThrow.mockReturnValue('');
	mocks.execFileNoThrow.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
	killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
	killSpy.mockRestore();
});

describe('snapshotProcessTree', () => {
	it('asks ps for start times along with the parent links', () => {
		processTable(row(AGENT, SELF));

		snapshotProcessTree(AGENT);

		expect(mocks.execFileSyncNoThrow).toHaveBeenCalledWith('ps', ['-eo', 'pid=,ppid=,lstart=']);
	});

	it('records every descendant, nearest first, with its start time', () => {
		processTable(
			row(AGENT, SELF),
			row(6000, 5000, LATER),
			row(5000, AGENT),
			row(5001, AGENT),
			row(7777, 1)
		);

		expect(snapshotProcessTree(AGENT)).toEqual({
			owned: true,
			descendants: [
				{ pid: 5000, startedAt: MORNING },
				{ pid: 5001, startedAt: MORNING },
				{ pid: 6000, startedAt: LATER },
			],
		});
	});

	it('owns a child that has started nothing', () => {
		processTable(row(AGENT, SELF), row(7777, 1));

		expect(snapshotProcessTree(AGENT)).toEqual({ owned: true, descendants: [] });
	});

	it('does not own a pid whose parent is some other process', () => {
		// The number belongs to something else now. Its children are not ours.
		processTable(row(AGENT, 1), row(5000, AGENT));

		expect(snapshotProcessTree(AGENT)).toEqual({ owned: false, descendants: [] });
	});

	it('does not own a pid that is not running', () => {
		processTable(row(7777, 1));

		expect(snapshotProcessTree(AGENT)).toEqual({ owned: false, descendants: [] });
	});

	it('owns nothing when ps cannot report start times', () => {
		// A `ps` that rejects `lstart` fails the call, which returns nothing.
		mocks.execFileSyncNoThrow.mockReturnValue('');

		expect(snapshotProcessTree(AGENT)).toEqual({ owned: false, descendants: [] });
	});

	it('skips rows it cannot read', () => {
		processTable(row(AGENT, SELF), 'garbage', '', `5000 ${AGENT}`, row(5001, AGENT));

		expect(snapshotProcessTree(AGENT).descendants).toEqual([{ pid: 5001, startedAt: MORNING }]);
	});

	it('does not loop on a table that contains a cycle', () => {
		processTable(row(AGENT, SELF), row(5000, AGENT), row(AGENT, 5000));

		expect(snapshotProcessTree(AGENT).descendants).toEqual([{ pid: 5000, startedAt: MORNING }]);
	});

	it('reads nothing for a pid that cannot be a process', () => {
		expect(snapshotProcessTree(0)).toEqual({ owned: false, descendants: [] });
		expect(snapshotProcessTree(-1)).toEqual({ owned: false, descendants: [] });
		expect(mocks.execFileSyncNoThrow).not.toHaveBeenCalled();
	});

	it('reads nothing on Windows, where taskkill walks the tree', () => {
		mocks.isWindows.mockReturnValue(true);

		expect(snapshotProcessTree(AGENT)).toEqual({ owned: false, descendants: [] });
		expect(mocks.execFileSyncNoThrow).not.toHaveBeenCalled();
	});
});

describe('killSurvivors', () => {
	const tool = { pid: 5000, startedAt: MORNING };

	it('kills a recorded process that is still running', () => {
		// Re-parented to init once its agent exited, which is why it was recorded.
		processTable(row(5000, 1));

		expect(killSurvivors([tool], CTX)).toBe(1);
		expect(killSpy.mock.calls).toEqual([[5000, 'SIGKILL']]);
	});

	it('leaves a pid alone when a different process has taken the number', () => {
		processTable(row(5000, 1, LATER));

		expect(killSurvivors([tool], CTX)).toBe(0);
		expect(killSpy).not.toHaveBeenCalled();
	});

	it('leaves a recorded process alone once it has exited', () => {
		processTable(row(7777, 1));

		expect(killSurvivors([tool], CTX)).toBe(0);
		expect(killSpy).not.toHaveBeenCalled();
	});

	it('also kills what a survivor started after it was recorded, deepest first', () => {
		processTable(row(5000, 1), row(5500, 5000, LATER), row(5600, 5500, LATER));

		expect(killSurvivors([tool], CTX)).toBe(3);
		expect(killSpy.mock.calls).toEqual([
			[5600, 'SIGKILL'],
			[5500, 'SIGKILL'],
			[5000, 'SIGKILL'],
		]);
	});

	it('signals a process once when it is both recorded and a descendant of a survivor', () => {
		const child = { pid: 5500, startedAt: MORNING };
		processTable(row(5000, 1), row(5500, 5000));

		expect(killSurvivors([tool, child], CTX)).toBe(2);
		expect(killSpy.mock.calls).toEqual([
			[5500, 'SIGKILL'],
			[5000, 'SIGKILL'],
		]);
	});

	it('reads nothing for an empty snapshot', () => {
		expect(killSurvivors([], CTX)).toBe(0);
		expect(mocks.execFileSyncNoThrow).not.toHaveBeenCalled();
	});

	it('does nothing on Windows', () => {
		mocks.isWindows.mockReturnValue(true);

		expect(killSurvivors([tool], CTX)).toBe(0);
		expect(mocks.execFileSyncNoThrow).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();
	});
});

describe('parseProcStat', () => {
	it('reads the pid, the parent pid and the start time', () => {
		expect(parseProcStat(procStat(5000, AGENT, 123456))).toEqual({
			pid: 5000,
			ppid: AGENT,
			startedAt: '123456',
		});
	});

	it('reads a real stat line', () => {
		const line =
			'2216 (bash) S 2215 2216 2216 34816 2290 4194304 1523 9105 0 3 2 1 11 6 20 0 1 0 ' +
			'8675309 11620352 1381 18446744073709551615 94120 95114 140724 0 0 0 65536 3670020 ' +
			'1266777851 1 0 0 17 3 0 0 0 0 0 95117 95164 95165 140725 140726 140727 140728 0';

		expect(parseProcStat(line)).toEqual({ pid: 2216, ppid: 2215, startedAt: '8675309' });
	});

	it.each([
		['spaces', 'tmux: server'],
		['a closing parenthesis', 'weird) name'],
		['both parentheses', '(sd-pam)'],
		['digits that look like fields', 'a) S 1 2 3'],
	])('counts fields from the last parenthesis when the name holds %s', (_case, comm) => {
		expect(parseProcStat(procStat(5000, AGENT, 777, comm))).toEqual({
			pid: 5000,
			ppid: AGENT,
			startedAt: '777',
		});
	});

	it.each([
		['empty text', ''],
		['text with no name', '5000 S 4242 5000'],
		['a line cut short before the start time', '5000 (node) S 4242 5000 5000 0 -1'],
		['a line with no pid', '(node) S 4242'],
	])('rejects %s', (_case, text) => {
		expect(parseProcStat(text)).toBeNull();
	});
});

describe('on Linux, where the table comes from /proc', () => {
	beforeEach(() => {
		mocks.isLinux.mockReturnValue(true);
	});

	it('records descendants with no ps at all', () => {
		// BusyBox ps, on Alpine and in many containers, cannot report `lstart`.
		procTable(
			{
				[AGENT]: procStat(AGENT, SELF, 100),
				5000: procStat(5000, AGENT, 200),
				6000: procStat(6000, 5000, 300),
				7777: procStat(7777, 1, 50),
			},
			['self', 'meminfo', 'sys']
		);

		expect(snapshotProcessTree(AGENT)).toEqual({
			owned: true,
			descendants: [
				{ pid: 5000, startedAt: '200' },
				{ pid: 6000, startedAt: '300' },
			],
		});
		expect(mocks.execFileSyncNoThrow).not.toHaveBeenCalled();
		expect(mocks.readFileSync).not.toHaveBeenCalledWith('/proc/self/stat', 'utf8');
	});

	it('skips a process that exited between the listing and the read', () => {
		procTable({ [AGENT]: procStat(AGENT, SELF, 100), 5000: procStat(5000, AGENT, 200) }, ['5001']);

		expect(snapshotProcessTree(AGENT).descendants).toEqual([{ pid: 5000, startedAt: '200' }]);
	});

	it('owns nothing when /proc cannot be listed', () => {
		mocks.readdirSync.mockImplementation(() => {
			throw new Error('EACCES');
		});

		expect(snapshotProcessTree(AGENT)).toEqual({ owned: false, descendants: [] });
	});

	it('sweeps a survivor by its tick count, and leaves a reused pid alone', () => {
		procTable({ 5000: procStat(5000, 1, 200), 5001: procStat(5001, 1, 999) });

		const swept = killSurvivors(
			[
				{ pid: 5000, startedAt: '200' },
				{ pid: 5001, startedAt: '201' },
			],
			CTX
		);

		expect(swept).toBe(1);
		expect(killSpy.mock.calls).toEqual([[5000, 'SIGKILL']]);
	});

	it('refreshes without blocking, from /proc', async () => {
		procTable({
			[AGENT]: procStat(AGENT, SELF, 100),
			5000: procStat(5000, AGENT, 200),
			5001: procStat(5001, AGENT, 400),
		});
		const before = { owned: true, descendants: [{ pid: 5000, startedAt: '200' }] };

		expect(await refreshProcessTree(AGENT, before)).toEqual({
			owned: true,
			descendants: [
				{ pid: 5000, startedAt: '200' },
				{ pid: 5001, startedAt: '400' },
			],
		});
		expect(mocks.readdirSync).not.toHaveBeenCalled();
		expect(mocks.execFileNoThrow).not.toHaveBeenCalled();
	});
});

describe('mergeProcessTree', () => {
	const tool = { pid: 5000, startedAt: MORNING };
	const owned = { owned: true, descendants: [tool] };
	const tableRow = (pid: number, ppid: number, startedAt = MORNING): ProcessTableRow => ({
		pid,
		ppid,
		startedAt,
	});

	it('adds what the agent started since the record was taken', () => {
		const rows = [tableRow(AGENT, SELF), tableRow(5000, AGENT), tableRow(5001, AGENT, LATER)];

		expect(mergeProcessTree(AGENT, owned, rows)).toEqual({
			owned: true,
			descendants: [tool, { pid: 5001, startedAt: LATER }],
		});
	});

	it('adds what a recorded descendant started, even after the agent is gone', () => {
		// The agent exited, so its tool now belongs to init. The tool's own
		// children still lead back to it.
		const rows = [tableRow(5000, 1), tableRow(5500, 5000, LATER)];

		expect(mergeProcessTree(AGENT, owned, rows).descendants).toEqual([
			tool,
			{ pid: 5500, startedAt: LATER },
		]);
	});

	it('does not follow a recorded pid that now belongs to another process', () => {
		const rows = [tableRow(5000, 1, LATER), tableRow(5500, 5000, LATER)];

		expect(mergeProcessTree(AGENT, owned, rows)).toBe(owned);
	});

	it('does not follow the agent pid once it is not a child of this process', () => {
		const rows = [tableRow(AGENT, 1), tableRow(5001, AGENT, LATER)];

		expect(mergeProcessTree(AGENT, { owned: true, descendants: [] }, rows)).toEqual({
			owned: true,
			descendants: [],
		});
	});

	it('hands back the same record when nothing new has started', () => {
		const rows = [tableRow(AGENT, SELF), tableRow(5000, AGENT)];

		expect(mergeProcessTree(AGENT, owned, rows)).toBe(owned);
	});

	it('hands back the same record when the table could not be read', () => {
		expect(mergeProcessTree(AGENT, owned, [])).toBe(owned);
	});

	it('adds nothing to a tree that is not ours', () => {
		const unowned = { owned: false, descendants: [] };
		const rows = [tableRow(AGENT, SELF), tableRow(5001, AGENT)];

		expect(mergeProcessTree(AGENT, unowned, rows)).toBe(unowned);
	});
});

describe('refreshProcessTree', () => {
	const owned = { owned: true, descendants: [{ pid: 5000, startedAt: MORNING }] };

	it('reads the table through ps without blocking', async () => {
		mocks.execFileNoThrow.mockResolvedValue({
			stdout: [row(AGENT, SELF), row(5000, AGENT), row(5001, AGENT, LATER)].join('\n'),
			stderr: '',
			exitCode: 0,
		});

		expect((await refreshProcessTree(AGENT, owned)).descendants).toEqual([
			{ pid: 5000, startedAt: MORNING },
			{ pid: 5001, startedAt: LATER },
		]);
		expect(mocks.execFileNoThrow).toHaveBeenCalledWith('ps', ['-eo', 'pid=,ppid=,lstart=']);
		expect(mocks.execFileSyncNoThrow).not.toHaveBeenCalled();
	});

	it('keeps the record it has when ps fails', async () => {
		mocks.execFileNoThrow.mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });

		expect(await refreshProcessTree(AGENT, owned)).toBe(owned);
	});

	it('reads nothing for a tree that is not ours, or on Windows', async () => {
		const unowned = { owned: false, descendants: [] };
		expect(await refreshProcessTree(AGENT, unowned)).toBe(unowned);

		mocks.isWindows.mockReturnValue(true);
		expect(await refreshProcessTree(AGENT, owned)).toBe(owned);

		expect(mocks.execFileNoThrow).not.toHaveBeenCalled();
	});
});
