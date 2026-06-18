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
 * Creates the Debug API object for preload exposure
 */
export function createDebugApi() {
	return {
		createPackage: (options?: DebugPackageOptions) =>
			ipcRenderer.invoke('debug:createPackage', options),

		previewPackage: () => ipcRenderer.invoke('debug:previewPackage'),

		getAppStats: (): Promise<AppStatsSnapshot> => ipcRenderer.invoke('debug:getAppStats'),
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
