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
import type { DirectoryEntry } from '../../shared/types';
export type { DirectoryEntry } from '../../shared/types';

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
 * Options for batched remote tree enumeration.
 */
export interface ListTreeRemoteOptions {
	maxDepth?: number;
	ignorePatterns?: string[];
	excludePaths?: string[];
	maxFiles?: number;
}

/**
 * Result of batched remote tree enumeration. Paths are relative to the
 * requested root, with no leading `./` or `/`.
 */
export interface ListTreeRemoteResult {
	directories: string[];
	files: string[];
	truncated: boolean;
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
		 * Enumerate a remote directory tree in a single SSH round-trip.
		 * Returns flat lists of directory and file paths relative to `rootPath`.
		 * SSH-only — local trees should use the renderer's recursive `loadFileTree`.
		 */
		listTreeRemote: (
			rootPath: string,
			sshRemoteId: string,
			options: ListTreeRemoteOptions
		): Promise<ListTreeRemoteResult> =>
			ipcRenderer.invoke('fs:listTreeRemote', rootPath, sshRemoteId, options),

		/**
		 * Read file contents.
		 *
		 * For SSH remote files, pass `requestId` to make the read cancellable —
		 * call `cancelReadFile(requestId)` to abort the underlying ssh+cat process.
		 * Cancelled reads resolve to null.
		 */
		readFile: (
			filePath: string,
			sshRemoteId?: string,
			requestId?: string
		): Promise<string | null> =>
			ipcRenderer.invoke('fs:readFile', filePath, sshRemoteId, requestId),

		/**
		 * Cancel an in-flight remote `readFile` by requestId. No-op if unknown.
		 */
		cancelReadFile: (requestId: string): Promise<void> =>
			ipcRenderer.invoke('fs:cancelReadFile', requestId),

		/**
		 * Write file contents
		 */
		writeFile: (
			filePath: string,
			content: string,
			sshRemoteId?: string
		): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('fs:writeFile', filePath, content, sshRemoteId),

		/**
		 * Get file/directory stats
		 */
		stat: (filePath: string, sshRemoteId?: string): Promise<FileStat> =>
			ipcRenderer.invoke('fs:stat', filePath, sshRemoteId),

		/**
		 * Get directory size information
		 */
		directorySize: (
			dirPath: string,
			sshRemoteId?: string,
			ignorePatterns?: string[],
			honorGitignore?: boolean
		): Promise<DirectorySizeInfo> =>
			ipcRenderer.invoke('fs:directorySize', dirPath, sshRemoteId, ignorePatterns, honorGitignore),

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
