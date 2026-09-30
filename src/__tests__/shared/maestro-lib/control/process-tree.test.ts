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
	isWindows: vi.fn(() => false),
}));

vi.mock('../../../../shared/maestro-lib/launch/exec-file', () => ({
	execFileSyncNoThrow: mocks.execFileSyncNoThrow,
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: mocks.isWindows,
}));

import {
	snapshotProcessTree,
	killSurvivors,
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

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isWindows.mockReturnValue(false);
	mocks.execFileSyncNoThrow.mockReturnValue('');
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
		// BusyBox ps rejects `lstart`, so the call fails and returns nothing.
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
