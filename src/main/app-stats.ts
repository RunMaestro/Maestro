/**
 * The Application Stats snapshot, built in one place for every caller: the
 * Debug: View Application Stats modal (`debug:getAppStats` IPC) and
 * `maestro-cli app-stats` (the `app_stats` WS bridge message).
 *
 * It answers "what is Maestro costing this computer right now": every process
 * it runs with memory and CPU, the agent and model server process trees, the
 * models resident inside the main process, and the disk Local Models occupies.
 * Reads only; it starts, loads, and opens nothing.
 */

import { app } from 'electron';
import os from 'os';

import type {
	AppStatsElectronProcess,
	AppStatsManagedProcess,
	AppStatsSnapshot,
} from '../shared/appStats';
import { isWindows } from '../shared/platformDetection';
import { collectLocalModelResources } from './local-models/resource-report';
import type { ProcessManager } from './process-manager';
import { readProcessTreeUsage } from './utils/process-usage';

export interface AppStatsDependencies {
	getProcessManager: () => ProcessManager | null;
}

function electronProcesses(): AppStatsElectronProcess[] {
	return app.getAppMetrics().map((metric) => ({
		pid: metric.pid,
		type: metric.type,
		name: metric.name,
		serviceName: metric.serviceName,
		cpuPercent: metric.cpu?.percentCPUUsage,
		// Electron reports memory in KiB.
		workingSetBytes:
			typeof metric.memory?.workingSetSize === 'number'
				? metric.memory.workingSetSize * 1024
				: undefined,
		peakWorkingSetBytes:
			typeof metric.memory?.peakWorkingSetSize === 'number'
				? metric.memory.peakWorkingSetSize * 1024
				: undefined,
	}));
}

function managedProcesses(processManager: ProcessManager | null): AppStatsManagedProcess[] {
	if (!processManager) return [];
	return processManager.getAll().map((p) => ({
		sessionId: p.sessionId,
		toolType: p.toolType,
		pid: p.pid,
		isTerminal: p.isTerminal,
		isBatchMode: p.isBatchMode || false,
		startTime: p.startTime,
	}));
}

export async function collectAppStats(deps: AppStatsDependencies): Promise<AppStatsSnapshot> {
	const electron = electronProcesses();
	const managed = managedProcesses(deps.getProcessManager());
	const localModels = await collectLocalModelResources();

	// One read of the process table measures every agent tree and the model
	// server tree, so a process two roots share is counted once in the total.
	const roots = managed
		.map((p) => p.pid)
		.filter((pid): pid is number => typeof pid === 'number' && pid > 0);
	if (localModels.modelServer.pid !== null) roots.push(localModels.modelServer.pid);
	const usage = await readProcessTreeUsage(roots);

	const managedWithUsage = managed.map((p) => {
		const tree = p.pid ? usage.trees.get(p.pid) : undefined;
		return tree
			? {
					...p,
					rssBytes: tree.rssBytes,
					cpuPercent: tree.cpuPercent,
					processCount: tree.processCount,
				}
			: p;
	});
	if (localModels.modelServer.pid !== null) {
		localModels.modelServer.usage = usage.trees.get(localModels.modelServer.pid) ?? null;
	}

	const mainMemory = process.memoryUsage();
	const electronMemory = electron.reduce((sum, p) => sum + (p.workingSetBytes ?? 0), 0);
	const electronCpu = electron.reduce((sum, p) => sum + (p.cpuPercent ?? 0), 0);
	const [load1, load5, load15] = os.loadavg();

	return {
		timestamp: Date.now(),
		platform: process.platform,
		system: {
			totalMemoryBytes: os.totalmem(),
			freeMemoryBytes: os.freemem(),
			cpuCount: os.cpus().length,
			loadAverage: isWindows() ? null : [load1, load5, load15],
		},
		main: {
			rss: mainMemory.rss,
			heapTotal: mainMemory.heapTotal,
			heapUsed: mainMemory.heapUsed,
			external: mainMemory.external,
			arrayBuffers: mainMemory.arrayBuffers,
		},
		electronProcesses: electron,
		managedProcesses: managedWithUsage,
		localModels,
		totals: {
			processCount: electron.length + usage.total.processCount,
			memoryBytes: electronMemory + usage.total.rssBytes,
			cpuPercent: electronCpu + usage.total.cpuPercent,
			processTreesMeasured: usage.measured,
		},
	};
}
