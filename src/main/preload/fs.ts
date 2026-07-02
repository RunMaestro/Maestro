/**
 * Preload API for filesystem operations
 *
 * Provides the window.maestro.fs namespace for:
 * - Reading directories and files
 * - File stats and sizes
 * - Writing, renaming, and deleting files
 * - SSH remote support for all operations
 */

import { ipcRenderer, webUtils } from 'electron';
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
		 * Download a remote SSH file to the local disk (binary-safe). Omit
		 * `localDestPath` to write to a temp dir (e.g. to then open in the default
		 * app); pass a path for a user-chosen save location. Resolves with the
		 * absolute path the file was written to.
		 */
		downloadRemoteFile: (
			remotePath: string,
			sshRemoteId: string,
			localDestPath?: string
		): Promise<{ success: boolean; path: string }> =>
			ipcRenderer.invoke('fs:downloadRemoteFile', remotePath, sshRemoteId, localDestPath),

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
		 * Write a base64 data URL (e.g. `data:image/png;base64,...`) to disk as
		 * raw binary. Use this for images/binary payloads; `writeFile` encodes
		 * content as UTF-8 and would corrupt binary data.
		 */
		writeImageFile: (
			filePath: string,
			dataUrl: string,
			sshRemoteId?: string
		): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('fs:writeImageFile', filePath, dataUrl, sshRemoteId),

		/**
		 * Create a directory (recursive)
		 */
		mkdir: (dirPath: string, sshRemoteId?: string): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('fs:mkdir', dirPath, sshRemoteId),

		/**
		 * Get file/directory stats. Resolves to null when the path does not exist.
		 */
		stat: (filePath: string, sshRemoteId?: string): Promise<FileStat | null> =>
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

		/**
		 * Copy a file or folder from an arbitrary source path into a destination
		 * path. Used by drag-and-drop import of OS files into the file tree. The
		 * source is always a local OS path; pass `sshRemoteId` to upload it to a
		 * remote host (the file panel is showing a remote session). Pass
		 * `overwrite: true` to replace an existing destination.
		 */
		copyPath: (
			sourcePath: string,
			destPath: string,
			options?: { overwrite?: boolean; sshRemoteId?: string }
		): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('fs:copyPath', sourcePath, destPath, options),

		/**
		 * Start an OS-level file drag-out (drag a file from the file panel to
		 * Finder/Explorer). `paths` are absolute LOCAL paths that must exist on
		 * disk - for remote files the caller downloads to a temp file first and
		 * passes that. Fire-and-forget: it hooks into the live drag gesture via
		 * Electron's `startDrag`, so it must be invoked from the row's `dragstart`.
		 */
		startDragOut: (paths: string[]): void => {
			ipcRenderer.send('fs:startDragOut', paths);
		},

		/**
		 * Resolve the absolute filesystem path of a dropped/selected `File`.
		 * Electron removed the non-standard `File.path` property; `webUtils`
		 * is the supported replacement and must be called from the preload
		 * context. Returns an empty string for files with no backing path
		 * (e.g. synthesized File objects).
		 */
		getPathForFile: (file: File): string => {
			try {
				return webUtils.getPathForFile(file);
			} catch {
				return '';
			}
		},
	};
}

/**
 * TypeScript type for the filesystem API
 */
export type FsApi = ReturnType<typeof createFsApi>;
