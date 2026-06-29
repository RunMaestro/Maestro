/**
 * Preload API for debug and document graph operations
 *
 * Provides the window.maestro.debug and window.maestro.documentGraph namespaces for:
 * - Debug package generation
 * - Document graph file watching
 */

import { ipcRenderer } from 'electron';

/**
 * Debug package options
 */
export interface DebugPackageOptions {
	includeLogs?: boolean;
	includeErrors?: boolean;
	includeSessions?: boolean;
	includeGroupChats?: boolean;
	includeBatchState?: boolean;
}

/**
 * Document graph file change event
 */
export interface DocumentGraphChange {
	filePath: string;
	eventType: 'add' | 'change' | 'unlink';
}

/**
 * Runtime snapshot returned by debug:getAppStats.
 * See src/main/ipc/handlers/debug.ts for field population details.
 */
export interface AppStatsSnapshot {
	timestamp: number;
	platform: NodeJS.Platform;
	main: {
		rss: number;
		heapTotal: number;
		heapUsed: number;
		external: number;
		arrayBuffers: number;
	};
	electronProcesses: Array<{
		pid: number;
		type: string;
		name?: string;
		serviceName?: string;
		cpuPercent?: number;
		workingSetBytes?: number;
		peakWorkingSetBytes?: number;
	}>;
	managedProcesses: Array<{
		sessionId: string;
		toolType: string;
		pid?: number;
		isTerminal?: boolean;
		isBatchMode: boolean;
		startTime?: number;
		rssBytes?: number;
	}>;
}

/**
 * Live performance-profiling status (debug:getProfilingStatus / startProfiling).
 */
export interface ProfilingStatusResponse {
	success: boolean;
	active: boolean;
	startedAt: number;
	elapsedMs: number;
	categories: string[];
	error?: string;
}

/**
 * Result of stopping a recording and saving the bundle (debug:stopProfiling).
 */
export interface StopProfilingResponse {
	success: boolean;
	path: string | null;
	cancelled: boolean;
	bundleSizeBytes: number;
	traceSizeBytes: number;
	durationMs: number;
	error?: string;
}

/**
 * Creates the Debug API object for preload exposure
 */
export function createDebugApi() {
	return {
		createPackage: (options?: DebugPackageOptions) =>
			ipcRenderer.invoke('debug:createPackage', options),

		previewPackage: () => ipcRenderer.invoke('debug:previewPackage'),

		getAppStats: (): Promise<AppStatsSnapshot> => ipcRenderer.invoke('debug:getAppStats'),

		// Performance profiling (Chromium contentTracing). Off by default with no
		// steady-state cost; see src/main/profiling.
		getProfilingStatus: (): Promise<ProfilingStatusResponse> =>
			ipcRenderer.invoke('debug:getProfilingStatus'),

		startProfiling: (): Promise<ProfilingStatusResponse> =>
			ipcRenderer.invoke('debug:startProfiling'),

		stopProfiling: (): Promise<StopProfilingResponse> => ipcRenderer.invoke('debug:stopProfiling'),
	};
}

/**
 * Creates the Document Graph API object for preload exposure
 */
export function createDocumentGraphApi() {
	return {
		watchFolder: (rootPath: string) => ipcRenderer.invoke('documentGraph:watchFolder', rootPath),

		unwatchFolder: (rootPath: string) =>
			ipcRenderer.invoke('documentGraph:unwatchFolder', rootPath),

		onFilesChanged: (
			handler: (data: { rootPath: string; changes: DocumentGraphChange[] }) => void
		) => {
			const wrappedHandler = (
				_event: Electron.IpcRendererEvent,
				data: { rootPath: string; changes: DocumentGraphChange[] }
			) => handler(data);
			ipcRenderer.on('documentGraph:filesChanged', wrappedHandler);
			return () => ipcRenderer.removeListener('documentGraph:filesChanged', wrappedHandler);
		},
	};
}

export type DebugApi = ReturnType<typeof createDebugApi>;
export type DocumentGraphApi = ReturnType<typeof createDocumentGraphApi>;
