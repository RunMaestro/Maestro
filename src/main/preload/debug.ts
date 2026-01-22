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
 * Creates the Debug API object for preload exposure
 */
export function createDebugApi() {
	return {
		createPackage: (options?: DebugPackageOptions) =>
			ipcRenderer.invoke('debug:createPackage', options),

		previewPackage: () => ipcRenderer.invoke('debug:previewPackage'),
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
