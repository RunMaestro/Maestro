/**
 * The Application Stats snapshot: what Maestro is costing this computer right
 * now, in memory, CPU, processes, and the disk Local Models occupies.
 *
 * One shape for every reader. The Debug: View Application Stats modal, the
 * preload bridge, and `maestro-cli app-stats` all take this type, and main
 * builds it in exactly one place (`collectAppStats()` in `src/main/app-stats.ts`).
 */

import type { LocalModelKind } from './local-models/types';
import type { ModelServerState } from './local-models/model-server';

/**
 * Memory and CPU of a process together with everything it started.
 *
 * An agent CLI starts MCP servers, language servers and shells; the model
 * server starts one worker per loaded model. The process the app spawned is a
 * small part of what it costs, so every figure here covers its whole tree.
 */
export interface ProcessTreeUsage {
	/** The root and every descendant still running. */
	processCount: number;
	/** Resident memory summed over the tree. */
	rssBytes: number;
	/**
	 * CPU summed over the tree, as the OS reports it: 100 is one full core, so
	 * a busy tree on a many-core machine reads above 100.
	 */
	cpuPercent: number;
}

/** One process Electron itself runs (main, renderers, GPU, utility services). */
export interface AppStatsElectronProcess {
	pid: number;
	type: string;
	name?: string;
	serviceName?: string;
	cpuPercent?: number;
	workingSetBytes?: number;
	peakWorkingSetBytes?: number;
}

/** One agent or terminal process the process manager spawned. */
export interface AppStatsManagedProcess {
	sessionId: string;
	toolType: string;
	pid?: number;
	isTerminal?: boolean;
	isBatchMode: boolean;
	startTime?: number;
	/** Resident memory of the process and its descendants. Absent where the OS table cannot be read. */
	rssBytes?: number;
	/** CPU of the process and its descendants (100 = one core). */
	cpuPercent?: number;
	/** The process and its descendants. */
	processCount?: number;
}

/** One model directory under the Local Models store. */
export interface AppStatsModelOnDisk {
	/** Directory name: the catalog id, or a stray directory's name. */
	id: string;
	/** Catalog display name, or the id when the catalog does not know it. */
	name: string;
	/** Null for a directory the catalog does not know. */
	kind: LocalModelKind | null;
	bytes: number;
	userAdded: boolean;
}

/** What Local Models occupies on disk and holds in memory. */
export interface LocalModelResources {
	disk: {
		/** Everything below, summed. */
		totalBytes: number;
		/** Every model directory. */
		modelsBytes: number;
		/** Native runtimes (ONNX, llama.cpp bindings), the model server engine included. */
		runtimesBytes: number;
		/** The `llama-server` engine, a part of `runtimesBytes`. */
		serverEngineBytes: number;
		/** The model server's presets, key and prompt cache. */
		serverDataBytes: number;
		/** The semantic search index (`embeddings.db` and its WAL). */
		semanticIndexBytes: number;
		/** Largest first. */
		models: AppStatsModelOnDisk[];
	};
	/**
	 * Models loaded INSIDE the main process. Their memory is part of the main
	 * (Browser) process's working set, not a process of their own.
	 */
	inProcess: {
		/** The shared llama.cpp text engine's model, or null when none is loaded. */
		textModel: string | null;
		/** ONNX encoders (embedding, classifier) currently resident. */
		encoders: string[];
		/** Speech-to-text models currently resident. */
		speechToText: string[];
	};
	/** The Maestro model server (`llama-server`), a separate process tree. */
	modelServer: {
		state: ModelServerState;
		pid: number | null;
		port: number | null;
		/** Catalog ids it serves. */
		models: string[];
		/** The ones loaded in memory now. */
		loadedModels: string[];
		startedAt: number | null;
		/** Null while it is not running, or where the OS table cannot be read. */
		usage: ProcessTreeUsage | null;
	};
}

export interface AppStatsSnapshot {
	timestamp: number;
	platform: NodeJS.Platform;
	/** The computer, for scale. */
	system: {
		totalMemoryBytes: number;
		freeMemoryBytes: number;
		cpuCount: number;
		/** 1, 5 and 15 minute load averages. Null on Windows, which has none. */
		loadAverage: [number, number, number] | null;
	};
	main: {
		rss: number;
		heapTotal: number;
		heapUsed: number;
		external: number;
		arrayBuffers: number;
	};
	electronProcesses: AppStatsElectronProcess[];
	managedProcesses: AppStatsManagedProcess[];
	localModels: LocalModelResources;
	/**
	 * Everything Maestro runs: Electron's processes, every agent and terminal
	 * tree, and the model server tree, each process counted once.
	 */
	totals: {
		processCount: number;
		memoryBytes: number;
		cpuPercent: number;
		/**
		 * False where the OS process table cannot be read (Windows): child trees
		 * are then missing from the totals and only Electron's own processes count.
		 */
		processTreesMeasured: boolean;
	};
}

/** CPU as the OS reports it, one decimal: `12.3%` (100% is one core). */
export function formatCpuPercent(percent: number): string {
	return `${percent.toFixed(1)}%`;
}

/** Share of the computer's memory Maestro holds, 0-100. */
export function memoryShareOfSystem(snapshot: AppStatsSnapshot): number {
	const total = snapshot.system.totalMemoryBytes;
	return total > 0 ? (snapshot.totals.memoryBytes / total) * 100 : 0;
}

/** Every model resident in the main process, labeled by where it lives. */
export function inProcessModels(
	resources: LocalModelResources
): Array<{ id: string; role: 'text' | 'encoder' | 'speech' }> {
	const { textModel, encoders, speechToText } = resources.inProcess;
	return [
		...(textModel ? [{ id: textModel, role: 'text' as const }] : []),
		...encoders.map((id) => ({ id, role: 'encoder' as const })),
		...speechToText.map((id) => ({ id, role: 'speech' as const })),
	];
}
