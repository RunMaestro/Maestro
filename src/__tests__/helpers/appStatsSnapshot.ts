/**
 * Shared factory for an Application Stats snapshot (`AppStatsSnapshot`).
 *
 * The modal, the CLI formatter, and the `app-stats` verb all render the same
 * shape; build it here once and override only what a test is about.
 */

import type { AppStatsSnapshot, LocalModelResources } from '../../shared/appStats';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function createLocalModelResources(
	overrides: Partial<LocalModelResources> = {}
): LocalModelResources {
	return {
		disk: {
			totalBytes: 6 * GB,
			modelsBytes: 5 * GB,
			runtimesBytes: 900 * MB,
			serverEngineBytes: 100 * MB,
			serverDataBytes: 4 * MB,
			semanticIndexBytes: 96 * MB,
			models: [
				{
					id: 'qwen3-4b',
					name: 'Qwen3 4B',
					kind: 'text-gen',
					bytes: 3 * GB,
					userAdded: false,
				},
				{
					id: 'parakeet-tdt',
					name: 'Parakeet TDT',
					kind: 'stt',
					bytes: 2 * GB,
					userAdded: false,
				},
			],
		},
		inProcess: { textModel: null, encoders: [], speechToText: ['parakeet-tdt'] },
		modelServer: {
			state: 'running',
			pid: 7000,
			port: 8090,
			models: ['qwen3-4b'],
			loadedModels: ['qwen3-4b'],
			startedAt: 1_000,
			usage: { processCount: 2, rssBytes: 3 * GB, cpuPercent: 12.5 },
		},
		...overrides,
	};
}

export function createAppStatsSnapshot(
	overrides: Partial<AppStatsSnapshot> = {}
): AppStatsSnapshot {
	return {
		timestamp: 1_700_000_000_000,
		platform: 'darwin',
		system: {
			totalMemoryBytes: 32 * GB,
			freeMemoryBytes: 8 * GB,
			cpuCount: 10,
			loadAverage: [1.5, 1.25, 1],
		},
		main: {
			rss: 400 * MB,
			heapTotal: 466 * MB,
			heapUsed: 388 * MB,
			external: 10 * MB,
			arrayBuffers: 5 * MB,
		},
		electronProcesses: [
			{ pid: 100, type: 'Browser', cpuPercent: 1.2, workingSetBytes: 2 * GB },
			{ pid: 101, type: 'Tab', cpuPercent: 0.8, workingSetBytes: 1 * GB },
		],
		managedProcesses: [
			{
				sessionId: 'agent-a-ai-tab-1',
				toolType: 'claude-code',
				pid: 200,
				isBatchMode: false,
				rssBytes: 500 * MB,
				cpuPercent: 4,
				processCount: 3,
			},
		],
		localModels: createLocalModelResources(),
		totals: {
			processCount: 7,
			memoryBytes: 2 * GB + 1 * GB + 500 * MB + 3 * GB,
			cpuPercent: 18.5,
			processTreesMeasured: true,
		},
		...overrides,
	};
}
