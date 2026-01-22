/**
 * Preload API for filesystem operations
 *
 * Provides the window.maestro.fs namespace for:
 * - Reading directories and files
 * - File stats and sizes
 * - Writing, renaming, and deleting files
 * - SSH remote support for all operations
 */

import { ipcRenderer } from 'electron';

/**
 * Directory entry information
 */
export interface DirectoryEntry {
	name: string;
	isDirectory: boolean;
	path: string;
}

/**
 * File stat information
 */
export interface FileStat {
	size: number;
	createdAt: string;
	modifiedAt: string;
	isDirectory: boolean;
	isFile: boolean;
}

/**
 * Directory size information
 */
export interface DirectorySizeInfo {
	totalSize: number;
	fileCount: number;
	folderCount: number;
}

/**
 * Item count information
 */
export interface ItemCountInfo {
	fileCount: number;
	folderCount: number;
}

/**
 * Creates the filesystem API object for preload exposure
 */
export function createFsApi() {
	return {
		/**
		 * Get the user's home directory
		 */
		homeDir: (): Promise<string> => ipcRenderer.invoke('fs:homeDir'),

		/**
		 * Read directory contents
		 */
		readDir: (dirPath: string, sshRemoteId?: string): Promise<DirectoryEntry[]> =>
			ipcRenderer.invoke('fs:readDir', dirPath, sshRemoteId),

		/**
		 * Read file contents
		 */
		readFile: (filePath: string, sshRemoteId?: string): Promise<string> =>
			ipcRenderer.invoke('fs:readFile', filePath, sshRemoteId),

		/**
		 * Write file contents
		 */
		writeFile: (filePath: string, content: string): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('fs:writeFile', filePath, content),

		/**
		 * Get file/directory stats
		 */
		stat: (filePath: string, sshRemoteId?: string): Promise<FileStat> =>
			ipcRenderer.invoke('fs:stat', filePath, sshRemoteId),

		/**
		 * Get directory size information
		 */
		directorySize: (dirPath: string, sshRemoteId?: string): Promise<DirectorySizeInfo> =>
			ipcRenderer.invoke('fs:directorySize', dirPath, sshRemoteId),

		/**
		 * Fetch an image from URL and return as base64
		 */
		fetchImageAsBase64: (url: string): Promise<string | null> =>
			ipcRenderer.invoke('fs:fetchImageAsBase64', url),

		/**
		 * Rename a file or directory
		 */
		rename: (
			oldPath: string,
			newPath: string,
			sshRemoteId?: string
		): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('fs:rename', oldPath, newPath, sshRemoteId),

		/**
		 * Delete a file or directory
		 */
		delete: (
			targetPath: string,
			options?: { recursive?: boolean; sshRemoteId?: string }
		): Promise<{ success: boolean }> => ipcRenderer.invoke('fs:delete', targetPath, options),

		/**
		 * Count files and folders in a directory
		 */
		countItems: (dirPath: string, sshRemoteId?: string): Promise<ItemCountInfo> =>
			ipcRenderer.invoke('fs:countItems', dirPath, sshRemoteId),
	};
}

/**
 * TypeScript type for the filesystem API
 */
export type FsApi = ReturnType<typeof createFsApi>;
