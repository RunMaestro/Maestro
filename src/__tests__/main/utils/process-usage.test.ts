/**
 * @file process-usage.test.ts
 *
 * Process tree memory and CPU for the Application Stats panel: the `ps` table
 * parses, each root is measured with every descendant, and the total across
 * roots counts a shared process once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/platformDetection')>()),
	isWindows: vi.fn(() => false),
}));

import {
	parsePsUsageTable,
	readProcessTreeUsage,
	summarizeProcessTrees,
	type ProcessUsageRow,
} from '../../../main/utils/process-usage';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { isWindows } from '../../../shared/platformDetection';

const row = (pid: number, ppid: number, rssKb: number, cpu: number): ProcessUsageRow => ({
	pid,
	ppid,
	rssBytes: rssKb * 1024,
	cpuPercent: cpu,
});

describe('parsePsUsageTable', () => {
	it('reads pid, ppid, rss (KiB) and %cpu, skipping lines that do not parse', () => {
		const table = [
			'  10     1  2048  1.5',
			'  11    10   512  0.0',
			'garbage line',
			'',
			'  0  0 0 0',
		].join('\n');
		expect(parsePsUsageTable(table)).toEqual([row(10, 1, 2048, 1.5), row(11, 10, 512, 0)]);
	});

	it('accepts a decimal comma in the CPU column', () => {
		expect(parsePsUsageTable(' 5 1 100 2,5')).toEqual([row(5, 1, 100, 2.5)]);
	});
});

describe('summarizeProcessTrees', () => {
	// 1 (unrelated) -> 10 (agent) -> 11 -> 12 ; 10 -> 13 ; 20 (server) -> 21
	const rows = [
		row(1, 0, 9999, 50),
		row(10, 1, 100, 1),
		row(11, 10, 200, 2),
		row(12, 11, 300, 3),
		row(13, 10, 400, 4),
		row(20, 1, 1000, 10),
		row(21, 20, 2000, 20),
	];

	it('measures each root with all of its descendants', () => {
		const { trees } = summarizeProcessTrees(rows, [10, 20]);
		expect(trees.get(10)).toEqual({ processCount: 4, rssBytes: 1000 * 1024, cpuPercent: 10 });
		expect(trees.get(20)).toEqual({ processCount: 2, rssBytes: 3000 * 1024, cpuPercent: 30 });
	});

	it('counts a process two roots share once in the total', () => {
		// 11 is both a root of its own and inside 10's tree.
		const { trees, total } = summarizeProcessTrees(rows, [10, 11]);
		expect(trees.get(11)?.processCount).toBe(2);
		expect(total).toEqual({ processCount: 4, rssBytes: 1000 * 1024, cpuPercent: 10 });
	});

	it('leaves a root that is not running out', () => {
		const { trees, total } = summarizeProcessTrees(rows, [999]);
		expect(trees.size).toBe(0);
		expect(total.processCount).toBe(0);
	});
});

describe('readProcessTreeUsage', () => {
	beforeEach(() => {
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(isWindows).mockReturnValue(false);
	});

	it('reads the table once for every root', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: '10 1 100 1\n11 10 200 2\n20 1 300 3\n',
			stderr: '',
		});

		const report = await readProcessTreeUsage([10, 20]);

		expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'ps',
			['-A', '-o', 'pid=,ppid=,rss=,%cpu='],
			undefined,
			expect.objectContaining({ timeout: expect.any(Number) })
		);
		expect(report.measured).toBe(true);
		expect(report.trees.get(10)?.processCount).toBe(2);
		expect(report.total.processCount).toBe(3);
	});

	it('is unmeasured, not zero, when ps fails', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'nope' });
		const report = await readProcessTreeUsage([10]);
		expect(report.measured).toBe(false);
		expect(report.trees.size).toBe(0);
	});

	it('does not run ps on Windows', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		const report = await readProcessTreeUsage([10]);
		expect(report.measured).toBe(false);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it('skips the read when there is nothing to measure', async () => {
		const report = await readProcessTreeUsage([0, -1]);
		expect(report.measured).toBe(true);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
});
