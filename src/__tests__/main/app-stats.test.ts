/**
 * @file app-stats.test.ts
 *
 * `collectAppStats()` is the one builder of the Application Stats snapshot.
 * These tests pin how it joins its sources: one process table read covers
 * every agent tree and the model server, each managed process carries its
 * tree, and the totals add Electron to the trees without counting a process
 * twice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLocalModelResources } from '../helpers/appStatsSnapshot';

vi.mock('electron', () => ({
	app: { getAppMetrics: vi.fn() },
}));

vi.mock('../../main/local-models/resource-report', () => ({
	collectLocalModelResources: vi.fn(),
}));

vi.mock('../../main/utils/process-usage', () => ({
	readProcessTreeUsage: vi.fn(),
}));

import { app } from 'electron';
import { collectAppStats } from '../../main/app-stats';
import { collectLocalModelResources } from '../../main/local-models/resource-report';
import { readProcessTreeUsage } from '../../main/utils/process-usage';

const MB = 1024 ** 2;

function processManager(processes: Array<Record<string, unknown>>) {
	return { getAll: () => processes } as never;
}

describe('collectAppStats', () => {
	beforeEach(() => {
		vi.mocked(app.getAppMetrics).mockReturnValue([
			{
				pid: 1,
				type: 'Browser',
				cpu: { percentCPUUsage: 2 },
				memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 },
			},
			{ pid: 2, type: 'GPU', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 512 } },
		] as never);
		vi.mocked(collectLocalModelResources).mockResolvedValue(
			createLocalModelResources({
				modelServer: {
					...createLocalModelResources().modelServer,
					pid: 900,
					usage: null,
				},
			})
		);
		vi.mocked(readProcessTreeUsage).mockResolvedValue({
			measured: true,
			trees: new Map([
				[300, { processCount: 3, rssBytes: 30 * MB, cpuPercent: 3 }],
				[900, { processCount: 2, rssBytes: 900 * MB, cpuPercent: 9 }],
			]),
			total: { processCount: 5, rssBytes: 930 * MB, cpuPercent: 12 },
		});
	});

	it('measures every agent tree and the model server in one read', async () => {
		await collectAppStats({
			getProcessManager: () =>
				processManager([
					{ sessionId: 'a-ai-t1', toolType: 'claude-code', pid: 300, isTerminal: false },
					{ sessionId: 'a-terminal-t2', toolType: 'terminal', pid: 0, isTerminal: true },
				]),
		});

		expect(readProcessTreeUsage).toHaveBeenCalledTimes(1);
		expect(readProcessTreeUsage).toHaveBeenCalledWith([300, 900]);
	});

	it('attaches each tree to its process and to the model server', async () => {
		const snapshot = await collectAppStats({
			getProcessManager: () =>
				processManager([
					{ sessionId: 'a-ai-t1', toolType: 'claude-code', pid: 300, isTerminal: false },
				]),
		});

		expect(snapshot.managedProcesses[0]).toMatchObject({
			sessionId: 'a-ai-t1',
			rssBytes: 30 * MB,
			cpuPercent: 3,
			processCount: 3,
			isBatchMode: false,
		});
		expect(snapshot.localModels.modelServer.usage).toEqual({
			processCount: 2,
			rssBytes: 900 * MB,
			cpuPercent: 9,
		});
	});

	it('adds Electron to the deduplicated tree total', async () => {
		const snapshot = await collectAppStats({ getProcessManager: () => null });

		// Electron reports KiB: 1024 + 512 KiB.
		expect(snapshot.electronProcesses[0].workingSetBytes).toBe(1024 * 1024);
		expect(snapshot.totals).toEqual({
			processCount: 2 + 5,
			memoryBytes: 1536 * 1024 + 930 * MB,
			cpuPercent: 3 + 12,
			processTreesMeasured: true,
		});
	});

	it('reports the computer it is measuring', async () => {
		const snapshot = await collectAppStats({ getProcessManager: () => null });
		expect(snapshot.system.totalMemoryBytes).toBeGreaterThan(0);
		expect(snapshot.system.cpuCount).toBeGreaterThan(0);
	});
});
