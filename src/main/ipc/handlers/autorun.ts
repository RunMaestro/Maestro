import { ipcMain, BrowserWindow, App } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { resolveDirentType } from '../../utils/dirent-utils';
import { WINDOWS_LOCKED_SYSTEM_FILES } from '../../utils/watcher-ignore';
import { SshRemoteConfig } from '../../../shared/types';
import { MaestroSettings } from './persistence';
import { isWebContentsAvailable } from '../../utils/safe-send';
import {
	readDirRemote,
	readFileRemote,
	writeFileRemote,
	existsRemote,
	mkdirRemote,
	deleteRemote,
	statRemote,
} from '../../utils/remote-fs';
import { PLAYBOOKS_DIR, LEGACY_PLAYBOOKS_DIR } from '../../../shared/maestro-paths';

const LOG_CONTEXT = '[AutoRun]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Dependencies required for Auto Run handler registration.
 * Optional for backward compatibility - SSH remote support requires settingsStore.
 */
export interface AutorunHandlerDependencies {
	/** The settings store (MaestroSettings) - required for SSH remote lookup */
	settingsStore?: Store<MaestroSettings>;
}

/**
 * Get SSH remote configuration by ID from the settings store.
 * Returns undefined if not found or store not provided.
 */
function getSshRemoteById(
	store: Store<MaestroSettings> | undefined,
	sshRemoteId: string
): SshRemoteConfig | undefined {
	if (!store) {
		logger.warn(`${LOG_CONTEXT} Settings store not available for SSH remote lookup`, LOG_CONTEXT);
		return undefined;
	}
	const sshRemotes = store.get('sshRemotes', []) as SshRemoteConfig[];
	return sshRemotes.find((r) => r.id === sshRemoteId);
}

// State managed by this module
const autoRunWatchers = new Map<string, FSWatcher>();
// One coalescing timer per folder. Pending changes within the debounce window
// are flushed together so 10 files written in parallel produce one tick of work
// instead of 10 staggered IPC bursts.
type PendingFolderChanges = {
	timer: NodeJS.Timeout;
	changes: Map<string, string>;
};
const autoRunWatchPending = new Map<string, PendingFolderChanges>();

const clearPendingChangesForFolder = (folderPath: string) => {
	const pending = autoRunWatchPending.get(folderPath);
	if (!pending) return;
	clearTimeout(pending.timer);
	autoRunWatchPending.delete(folderPath);
};

/**
 * Tree node interface for autorun directory scanning.
 *
 * Note: This is intentionally different from shared/treeUtils.TreeNode:
 * - Includes a `path` property (pre-computed relative path from scanDirectory)
 * - shared TreeNode has only `name` and constructs paths during traversal
 *
 * @internal
 */
interface TreeNode {
	name: string;
	type: 'file' | 'folder';
	/** Pre-computed relative path from root folder */
	path: string;
	children?: TreeNode[];
}

/**
 * Recursively scan directory for markdown files
 */
async function resolveLocalEntryType(
	dirPath: string,
	entry: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink?: () => boolean }
): Promise<{ isDirectory: boolean; isFile: boolean; isSymlink: boolean }> {
	let isDirectory = entry.isDirectory();
	let isFile = entry.isFile();
	const isSymlink = typeof entry.isSymbolicLink === 'function' ? entry.isSymbolicLink() : false;
	if (isSymlink) {
		try {
			const stats = await fs.stat(path.join(dirPath, entry.name));
			isDirectory = stats.isDirectory();
			isFile = stats.isFile();
		} catch {
			isDirectory = false;
			isFile = false;
		}
	}
	return { isDirectory, isFile, isSymlink };
}

async function scanDirectory(
	dirPath: string,
	relativePath: string = '',
	visitedRealPaths: Set<string> = new Set()
): Promise<TreeNode[]> {
	const realPath =
		typeof (fs as any).realpath === 'function'
			? await fs.realpath(dirPath).catch(() => path.resolve(dirPath))
			: path.resolve(dirPath);
	if (visitedRealPaths.has(realPath)) {
		return [];
	}
	visitedRealPaths.add(realPath);

	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	const nodes: TreeNode[] = [];

	// Resolve symlinks so symlinked folders/files are classified by target type.
	// Broken symlinks are skipped (they can't contribute .md files).
	const resolvedEntries = await Promise.all(
		entries
			.filter((entry) => !entry.name.startsWith('.'))
			.map(async (entry) => ({
				entry,
				...(await resolveLocalEntryType(dirPath, entry)),
			}))
	);

	// Sort entries: folders first, then files, both alphabetically
	const sortedEntries = resolvedEntries.sort((a, b) => {
		if (a.isDirectory && !b.isDirectory) return -1;
		if (!a.isDirectory && b.isDirectory) return 1;
		return a.entry.name.toLowerCase().localeCompare(b.entry.name.toLowerCase());
	});

	for (const { entry, isDirectory, isFile } of sortedEntries) {
		const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

		if (isDirectory) {
			// Recursively scan subdirectory
			const children = await scanDirectory(
				path.join(dirPath, entry.name),
				entryRelativePath,
				visitedRealPaths
			);
			// Only include folders that contain .md files (directly or in subfolders)
			if (children.length > 0) {
				nodes.push({
					name: entry.name,
					type: 'folder',
					path: entryRelativePath,
					children,
				});
			}
		} else if (isFile && entry.name.toLowerCase().endsWith('.md')) {
			// Add .md file (without extension in name, but keep in path)
			nodes.push({
				name: entry.name.slice(0, -3),
				type: 'file',
				path: entryRelativePath.slice(0, -3), // Remove .md from path too
			});
		}
	}

	return nodes;
}

async function resolveRemoteEntryType(
	dirPath: string,
	entry: { name: string; isDirectory: boolean; isSymlink: boolean },
	sshRemote: SshRemoteConfig
): Promise<{ isDirectory: boolean; isFile: boolean }> {
	if (!entry.isSymlink) {
		return {
			isDirectory: entry.isDirectory,
			isFile: !entry.isDirectory,
		};
	}

	const fullPath = `${dirPath}/${entry.name}`;
	const statResult = await statRemote(fullPath, sshRemote);
	if (!statResult.success || !statResult.data) {
		return {
			isDirectory: false,
			isFile: false,
		};
	}

	return {
		isDirectory: statResult.data.isDirectory,
		isFile: !statResult.data.isDirectory,
	};
}

/**
 * Recursively scan directory for markdown files on a remote host via SSH.
 * This is the SSH version of scanDirectory.
 */
async function scanDirectoryRemote(
	dirPath: string,
	sshRemote: SshRemoteConfig,
	relativePath: string = '',
	visitedPaths: Set<string> = new Set()
): Promise<TreeNode[]> {
	const normalizedPath = dirPath.replace(/\/+/g, '/');
	if (visitedPaths.has(normalizedPath)) {
		return [];
	}
	visitedPaths.add(normalizedPath);

	const result = await readDirRemote(dirPath, sshRemote);
	if (!result.success || !result.data) {
		logger.warn(`${LOG_CONTEXT} Failed to read remote directory: ${result.error}`, LOG_CONTEXT);
		return [];
	}

	const resolvedEntries = await Promise.all(
		result.data
			.filter((entry) => !entry.name.startsWith('.'))
			.map(async (entry) => ({
				entry,
				...(await resolveRemoteEntryType(dirPath, entry, sshRemote)),
			}))
	);

	const nodes: TreeNode[] = [];

	// Sort entries: folders first, then files, both alphabetically
	const sortedEntries = resolvedEntries.sort((a, b) => {
		if (a.isDirectory && !b.isDirectory) return -1;
		if (!a.isDirectory && b.isDirectory) return 1;
		return a.entry.name.toLowerCase().localeCompare(b.entry.name.toLowerCase());
	});

	for (const { entry, isDirectory, isFile } of sortedEntries) {
		const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

		if (isDirectory) {
			// Avoid infinite recursion on remote symlink cycles.
			// We currently don't have remote realpath canonicalization in remote-fs,
			// so skip descending into symlinked directories.
			if (entry.isSymlink) {
				continue;
			}

			// Recursively scan subdirectory
			// Use forward slashes for remote paths (Unix style)
			const children = await scanDirectoryRemote(
				`${dirPath}/${entry.name}`,
				sshRemote,
				entryRelativePath,
				visitedPaths
			);
			// Only include folders that contain .md files (directly or in subfolders)
			if (children.length > 0) {
				nodes.push({
					name: entry.name,
					type: 'folder',
					path: entryRelativePath,
					children,
				});
			}
		} else if (isFile && entry.name.toLowerCase().endsWith('.md')) {
			// Add .md file (without extension in name, but keep in path)
			nodes.push({
				name: entry.name.slice(0, -3),
				type: 'file',
				path: entryRelativePath.slice(0, -3), // Remove .md from path too
			});
		}
	}

	return nodes;
}

/**
 * Flatten tree structure to flat list of paths.
 *
 * Note: This is intentionally NOT using shared/treeUtils.getAllFilePaths because:
 * - autorun.ts TreeNode has a pre-computed `path` property from scanDirectory
 * - shared TreeNode builds paths on-the-fly from `name` properties
 * The shared utility would re-construct paths we already have, duplicating work.
 *
 * @internal
 */
function flattenTree(nodes: TreeNode[]): string[] {
	const files: string[] = [];
	for (const node of nodes) {
		if (node.type === 'file') {
			files.push(node.path);
		} else if (node.children) {
			files.push(...flattenTree(node.children));
		}
	}
	return files;
}

/**
 * Validate path is within allowed folder (prevent directory traversal)
 */
function validatePathWithinFolder(filePath: string, folderPath: string): boolean {
	const resolvedPath = path.resolve(filePath);
	const resolvedFolder = path.resolve(folderPath);
	return resolvedPath.startsWith(resolvedFolder + path.sep) || resolvedPath === resolvedFolder;
}

/**
 * Recursively check if a directory contains any markdown files.
 * Optimized to return early as soon as one .md file is found.
 */
async function checkForMarkdownFiles(
	dirPath: string,
	visitedRealPaths: Set<string> = new Set()
): Promise<boolean> {
	const realPath =
		typeof (fs as any).realpath === 'function'
			? await fs.realpath(dirPath).catch(() => path.resolve(dirPath))
			: path.resolve(dirPath);
	if (visitedRealPaths.has(realPath)) {
		return false;
	}
	visitedRealPaths.add(realPath);

	const entries = await fs.readdir(dirPath, { withFileTypes: true });

	for (const entry of entries) {
		// Skip hidden files/folders
		if (entry.name.startsWith('.')) {
			continue;
		}

		const fullPath = path.join(dirPath, entry.name);
		const resolved = await resolveDirentType(entry, fullPath);

		if (resolved.isFile && entry.name.toLowerCase().endsWith('.md')) {
			// Found a markdown file - return immediately
			return true;
		}

		if (resolved.isDirectory) {
			// Recursively check subdirectory (follows symlinked folders)
			const hasFiles = await checkForMarkdownFiles(fullPath, visitedRealPaths);
			if (hasFiles) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Register all Auto Run-related IPC handlers.
 *
 * These handlers provide Auto Run document operations:
 * - Document listing with tree structure
 * - Document read/write operations
 * - Image management (save, delete, list)
 * - Folder watching for external changes
 * - Folder deletion (wizard "start fresh" feature)
 *
 * SSH remote support: Handlers accept optional sshRemoteId parameter for remote file operations.
 */
export function registerAutorunHandlers(
	deps: {
		mainWindow: BrowserWindow | null;
		getMainWindow: () => BrowserWindow | null;
		app: App;
	} & AutorunHandlerDependencies
): void {
	const { getMainWindow, app, settingsStore } = deps;

	// List markdown files in a directory for Auto Run (with recursive subfolder support)
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'autorun:listDocs',
		createIpcHandler(handlerOpts('listDocs'), async (folderPath: string, sshRemoteId?: string) => {
			// SSH remote: dispatch to remote operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				logger.debug(`${LOG_CONTEXT} listDocs via SSH: ${folderPath}`, LOG_CONTEXT);

				const tree = await scanDirectoryRemote(folderPath, sshConfig);
				const files = flattenTree(tree);

				logger.info(
					`Listed ${files.length} remote markdown files in ${folderPath} (with subfolders)`,
					LOG_CONTEXT
				);
				return { files, tree };
			}

			// Local: Validate the folder path exists
			const folderStat = await fs.stat(folderPath);
			if (!folderStat.isDirectory()) {
				throw new Error('Path is not a directory');
			}

			const tree = await scanDirectory(folderPath);
			const files = flattenTree(tree);

			logger.info(
				`Listed ${files.length} markdown files in ${folderPath} (with subfolders)`,
				LOG_CONTEXT
			);
			return { files, tree };
		})
	);

	// Quick check if Auto Run Docs folder exists and contains any .md files
	ipcMain.handle(
		'autorun:hasDocuments',
		createIpcHandler(handlerOpts('hasDocuments', false), async (folderPath: string) => {
			try {
				// First check if the folder exists
				const folderStat = await fs.stat(folderPath);
				if (!folderStat.isDirectory()) {
					return { hasDocuments: false };
				}

				// Check for any .md files (recursively, but stop early once we find one)
				const hasMarkdownFiles = await checkForMarkdownFiles(folderPath);
				return { hasDocuments: hasMarkdownFiles };
			} catch {
				// Folder doesn't exist or other error - no documents
				return { hasDocuments: false };
			}
		})
	);

	// Read a markdown document for Auto Run (supports subdirectories)
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'autorun:readDoc',
		createIpcHandler(
			handlerOpts('readDoc'),
			async (folderPath: string, filename: string, sshRemoteId?: string) => {
				// Reject obvious traversal attempts
				if (filename.includes('..')) {
					throw new Error('Invalid filename');
				}

				// Ensure filename has .md extension
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Construct remote path (use forward slashes)
					const remotePath = `${folderPath}/${fullFilename}`;
					logger.debug(`${LOG_CONTEXT} readDoc via SSH: ${remotePath}`, LOG_CONTEXT);

					const result = await readFileRemote(remotePath, sshConfig);
					if (!result.success || result.data === undefined) {
						throw new Error(result.error || 'Failed to read remote file');
					}

					logger.info(`Read remote Auto Run doc: ${fullFilename}`, LOG_CONTEXT);
					return { content: result.data };
				}

				// Local: Validate and read
				const filePath = path.join(folderPath, fullFilename);

				// Validate the file is within the folder path (prevent traversal)
				if (!validatePathWithinFolder(filePath, folderPath)) {
					throw new Error('Invalid file path');
				}

				// Check if file exists — return empty content instead of throwing,
				// since missing files are expected (deleted, renamed, stale references)
				try {
					await fs.access(filePath);
				} catch {
					return { content: '', notFound: true };
				}

				// Read the file
				const content = await fs.readFile(filePath, 'utf-8');

				logger.info(`Read Auto Run doc: ${fullFilename}`, LOG_CONTEXT);
				return { content };
			}
		)
	);

	// Write a markdown document for Auto Run (supports subdirectories)
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'autorun:writeDoc',
		createIpcHandler(
			handlerOpts('writeDoc'),
			async (folderPath: string, filename: string, content: string, sshRemoteId?: string) => {
				// Decode any URL-encoded characters to catch encoded traversal attempts
				let decodedFilename: string;
				try {
					decodedFilename = decodeURIComponent(filename);
				} catch {
					decodedFilename = filename;
				}

				// Reject obvious traversal attempts (check both original and decoded)
				if (filename.includes('..') || decodedFilename.includes('..')) {
					throw new Error('Invalid filename');
				}

				// Ensure filename has .md extension
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Construct remote path (use forward slashes)
					const remotePath = `${folderPath}/${fullFilename}`;

					// Ensure parent directory exists on remote
					const remoteParentDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
					if (remoteParentDir && remoteParentDir !== folderPath) {
						const parentExists = await existsRemote(remoteParentDir, sshConfig);
						if (!parentExists.success || !parentExists.data) {
							const mkdirResult = await mkdirRemote(remoteParentDir, sshConfig, true);
							if (!mkdirResult.success) {
								throw new Error(mkdirResult.error || 'Failed to create remote parent directory');
							}
						}
					}

					logger.debug(`${LOG_CONTEXT} writeDoc via SSH: ${remotePath}`, LOG_CONTEXT);

					const result = await writeFileRemote(remotePath, content, sshConfig);
					if (!result.success) {
						throw new Error(result.error || 'Failed to write remote file');
					}

					logger.info(`Wrote remote Auto Run doc: ${fullFilename}`, LOG_CONTEXT);
					return {};
				}

				// Local: Validate and write
				const filePath = path.join(folderPath, fullFilename);

				// Validate the file is within the folder path (prevent traversal)
				if (!validatePathWithinFolder(filePath, folderPath)) {
					throw new Error('Invalid file path');
				}

				// Ensure the parent directory exists (create if needed for subdirectories)
				const parentDir = path.dirname(filePath);
				try {
					await fs.access(parentDir);
				} catch {
					// Parent dir doesn't exist - create it if it's within folderPath
					const resolvedParent = path.resolve(parentDir);
					const resolvedFolder = path.resolve(folderPath);
					if (resolvedParent.startsWith(resolvedFolder)) {
						await fs.mkdir(parentDir, { recursive: true });
					} else {
						throw new Error('Invalid parent directory');
					}
				}

				// Write the file
				await fs.writeFile(filePath, content, 'utf-8');

				logger.info(`Wrote Auto Run doc: ${fullFilename}`, LOG_CONTEXT);
				return {};
			}
		)
	);

	// Save image to Auto Run folder
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'autorun:saveImage',
		createIpcHandler(
			handlerOpts('saveImage'),
			async (
				folderPath: string,
				docName: string,
				base64Data: string,
				extension: string,
				sshRemoteId?: string
			) => {
				// Sanitize docName to prevent directory traversal
				const sanitizedDocName = path.basename(docName).replace(/\.md$/i, '');
				if (sanitizedDocName.includes('..') || sanitizedDocName.includes('/')) {
					throw new Error('Invalid document name');
				}

				// Validate extension (only allow common image formats)
				const allowedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
				const sanitizedExtension = extension.toLowerCase().replace(/[^a-z]/g, '');
				if (!allowedExtensions.includes(sanitizedExtension)) {
					throw new Error('Invalid image extension');
				}

				// Generate filename: {docName}-{timestamp}.{ext}
				const timestamp = Date.now();
				const filename = `${sanitizedDocName}-${timestamp}.${sanitizedExtension}`;
				const relativePath = `images/${filename}`;

				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Construct remote paths (use forward slashes)
					const remoteImagesDir = `${folderPath}/images`;
					const remotePath = `${folderPath}/${relativePath}`;

					// Create images subdirectory on remote if it doesn't exist
					const dirExists = await existsRemote(remoteImagesDir, sshConfig);
					if (!dirExists.success || !dirExists.data) {
						const mkdirResult = await mkdirRemote(remoteImagesDir, sshConfig, true);
						if (!mkdirResult.success) {
							throw new Error(mkdirResult.error || 'Failed to create remote images directory');
						}
					}

					logger.debug(`${LOG_CONTEXT} saveImage via SSH: ${remotePath}`, LOG_CONTEXT);

					// Decode base64 and write as buffer - writeFileRemote handles binary via Buffer
					const imageBuffer = Buffer.from(base64Data, 'base64');
					const result = await writeFileRemote(remotePath, imageBuffer, sshConfig);
					if (!result.success) {
						throw new Error(result.error || 'Failed to write remote image file');
					}

					logger.info(`Saved remote Auto Run image: ${relativePath}`, LOG_CONTEXT);
					return { relativePath };
				}

				// Local: Create images subdirectory if it doesn't exist
				const imagesDir = path.join(folderPath, 'images');
				try {
					await fs.mkdir(imagesDir, { recursive: true });
				} catch {
					// Directory might already exist, that's fine
				}

				const filePath = path.join(imagesDir, filename);

				// Validate the file is within the folder path (prevent traversal)
				const resolvedPath = path.resolve(filePath);
				const resolvedFolder = path.resolve(folderPath);
				if (!resolvedPath.startsWith(resolvedFolder)) {
					throw new Error('Invalid file path');
				}

				// Decode and write the image
				const buffer = Buffer.from(base64Data, 'base64');
				await fs.writeFile(filePath, buffer);

				// Return the relative path for markdown insertion
				logger.info(`Saved Auto Run image: ${relativePath}`, LOG_CONTEXT);
				return { relativePath };
			}
		)
	);

	// Delete image from Auto Run folder
	ipcMain.handle(
		'autorun:deleteImage',
		createIpcHandler(
			handlerOpts('deleteImage'),
			async (folderPath: string, relativePath: string, sshRemoteId?: string) => {
				// Sanitize relativePath to prevent directory traversal
				const normalizedPath = path.normalize(relativePath);
				const normalizedPathPosix = normalizedPath.replace(/\\/g, '/');
				if (
					normalizedPath.includes('..') ||
					path.isAbsolute(normalizedPath) ||
					!normalizedPathPosix.startsWith('images/')
				) {
					throw new Error('Invalid image path');
				}

				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Construct remote path (use forward slashes)
					const remotePath = `${folderPath}/${normalizedPathPosix}`;

					logger.debug(`${LOG_CONTEXT} deleteImage via SSH: ${remotePath}`, LOG_CONTEXT);

					// Delete the remote file
					const result = await deleteRemote(remotePath, sshConfig, false);
					if (!result.success) {
						throw new Error(result.error || 'Failed to delete remote image file');
					}

					logger.info(`Deleted remote Auto Run image: ${relativePath}`, LOG_CONTEXT);
					return {};
				}

				// Local: Build full path
				const filePath = path.join(folderPath, normalizedPath);

				// Validate the file is within the folder path (prevent traversal)
				const resolvedPath = path.resolve(filePath);
				const resolvedFolder = path.resolve(folderPath);
				if (!resolvedPath.startsWith(resolvedFolder)) {
					throw new Error('Invalid file path');
				}

				// Check if file exists
				try {
					await fs.access(filePath);
				} catch {
					throw new Error('Image file not found');
				}

				// Delete the file
				await fs.unlink(filePath);
				logger.info(`Deleted Auto Run image: ${relativePath}`, LOG_CONTEXT);
				return {};
			}
		)
	);

	// Replace an existing image at relativePath by overwriting it in place.
	// Used by the image annotator to save edits back to the original file.
	ipcMain.handle(
		'autorun:replaceImage',
		createIpcHandler(
			handlerOpts('replaceImage'),
			async (
				folderPath: string,
				relativePath: string,
				base64Data: string,
				sshRemoteId?: string
			) => {
				// Sanitize relativePath to prevent directory traversal
				const normalizedPath = path.normalize(relativePath);
				const normalizedPathPosix = normalizedPath.replace(/\\/g, '/');
				if (
					normalizedPath.includes('..') ||
					path.isAbsolute(normalizedPath) ||
					!normalizedPathPosix.startsWith('images/')
				) {
					throw new Error('Invalid image path');
				}

				const imageBuffer = Buffer.from(base64Data, 'base64');

				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					const remotePath = `${folderPath}/${normalizedPathPosix}`;
					logger.debug(`${LOG_CONTEXT} replaceImage via SSH: ${remotePath}`, LOG_CONTEXT);

					// Mirror the local branch's "overwrite only" contract — without
					// the existence check, a stale annotator save could silently
					// recreate a file that was deleted on the remote.
					const stat = await statRemote(remotePath, sshConfig);
					if (!stat.success) {
						throw new Error('Image file not found');
					}

					const result = await writeFileRemote(remotePath, imageBuffer, sshConfig);
					if (!result.success) {
						throw new Error(result.error || 'Failed to write remote image file');
					}

					logger.info(`Replaced remote Auto Run image: ${relativePath}`, LOG_CONTEXT);
					return { relativePath: normalizedPathPosix };
				}

				const filePath = path.join(folderPath, normalizedPath);
				const resolvedPath = path.resolve(filePath);
				const resolvedFolder = path.resolve(folderPath);
				if (!resolvedPath.startsWith(resolvedFolder)) {
					throw new Error('Invalid file path');
				}

				try {
					await fs.access(filePath);
				} catch {
					throw new Error('Image file not found');
				}

				await fs.writeFile(filePath, imageBuffer);
				logger.info(`Replaced Auto Run image: ${relativePath}`, LOG_CONTEXT);
				return { relativePath: normalizedPathPosix };
			}
		)
	);

	// List images for a document (by prefix match)
	ipcMain.handle(
		'autorun:listImages',
		createIpcHandler(
			handlerOpts('listImages', false),
			async (folderPath: string, docName: string, sshRemoteId?: string) => {
				// Sanitize docName to prevent directory traversal
				const sanitizedDocName = path.basename(docName).replace(/\.md$/i, '');
				if (sanitizedDocName.includes('..') || sanitizedDocName.includes('/')) {
					throw new Error('Invalid document name');
				}

				const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Construct remote images directory path (use forward slashes)
					const remoteImagesDir = `${folderPath}/images`;

					logger.debug(`${LOG_CONTEXT} listImages via SSH: ${remoteImagesDir}`, LOG_CONTEXT);

					// Check if images directory exists on remote
					const existsResult = await existsRemote(remoteImagesDir, sshConfig);
					if (!existsResult.success || !existsResult.data) {
						// No images directory means no images
						return { images: [] };
					}

					// Read remote directory contents
					const dirResult = await readDirRemote(remoteImagesDir, sshConfig);
					if (!dirResult.success || !dirResult.data) {
						throw new Error(dirResult.error || 'Failed to read remote images directory');
					}

					// Filter files that start with the docName prefix
					const images = dirResult.data
						.filter((entry) => {
							// Only include files (not directories)
							if (entry.isDirectory) {
								return false;
							}
							// Check if filename starts with docName-
							if (!entry.name.startsWith(`${sanitizedDocName}-`)) {
								return false;
							}
							// Check if it has a valid image extension
							const ext = entry.name.split('.').pop()?.toLowerCase();
							return ext && imageExtensions.includes(ext);
						})
						.map((entry) => ({
							filename: entry.name,
							relativePath: `images/${entry.name}`,
						}));

					return { images };
				}

				// Local: Build images directory path
				const imagesDir = path.join(folderPath, 'images');

				// Check if images directory exists
				try {
					await fs.access(imagesDir);
				} catch {
					// No images directory means no images
					return { images: [] };
				}

				// Read directory contents
				const files = await fs.readdir(imagesDir);

				// Filter files that start with the docName prefix
				const images = files
					.filter((file) => {
						// Check if filename starts with docName-
						if (!file.startsWith(`${sanitizedDocName}-`)) {
							return false;
						}
						// Check if it has a valid image extension
						const ext = file.split('.').pop()?.toLowerCase();
						return ext && imageExtensions.includes(ext);
					})
					.map((file) => ({
						filename: file,
						relativePath: `images/${file}`,
					}));

				return { images };
			}
		)
	);

	// Delete the playbooks folder (for wizard "start fresh" feature)
	// Checks canonical .maestro/playbooks first, then legacy Auto Run Docs
	ipcMain.handle(
		'autorun:deleteFolder',
		createIpcHandler(handlerOpts('deleteFolder'), async (projectPath: string) => {
			// Validate input
			if (!projectPath || typeof projectPath !== 'string') {
				throw new Error('Invalid project path');
			}

			// Allowed playbook folder names (canonical + legacy)
			const ALLOWED_FOLDER_NAMES = new Set(['playbooks', 'Auto Run Docs']);

			// Try canonical path first, then legacy
			const canonicalFolder = path.join(projectPath, PLAYBOOKS_DIR);
			const legacyFolder = path.join(projectPath, LEGACY_PLAYBOOKS_DIR);

			for (const autoRunFolder of [canonicalFolder, legacyFolder]) {
				try {
					const stat = await fs.stat(autoRunFolder);
					if (!stat.isDirectory()) continue;
				} catch {
					continue;
				}

				// Safety check: ensure we're only deleting known playbook folders
				const folderName = path.basename(autoRunFolder);
				if (!ALLOWED_FOLDER_NAMES.has(folderName)) {
					throw new Error('Safety check failed: not a playbooks folder');
				}

				await fs.rm(autoRunFolder, { recursive: true, force: true });
				logger.info(`Deleted playbooks folder: ${autoRunFolder}`, LOG_CONTEXT);
			}

			return {};
		})
	);

	// Start watching an Auto Run folder for changes
	// Supports SSH remote execution via optional sshRemoteId parameter
	// For remote sessions, file watching is not supported (chokidar can't watch remote directories)
	// Returns isRemote: true to indicate the UI should poll using listDocs instead
	ipcMain.handle(
		'autorun:watchFolder',
		createIpcHandler(
			handlerOpts('watchFolder'),
			async (folderPath: string, sshRemoteId?: string) => {
				// SSH remote: Cannot use chokidar for remote directories
				// Return success with isRemote flag so UI can fall back to polling
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Ensure remote folder exists (create if not)
					const folderExists = await existsRemote(folderPath, sshConfig);
					if (!folderExists.success || !folderExists.data) {
						const mkdirResult = await mkdirRemote(folderPath, sshConfig, true);
						if (!mkdirResult.success) {
							throw new Error(mkdirResult.error || 'Failed to create remote Auto Run folder');
						}
						logger.info(`Created remote Auto Run folder: ${folderPath}`, LOG_CONTEXT);
					}

					logger.info(`Remote Auto Run folder ready (polling mode): ${folderPath}`, LOG_CONTEXT);
					return {
						isRemote: true,
						message: 'File watching not available for remote sessions. Use polling.',
					};
				}

				// Local: Stop any existing watcher for this folder
				if (autoRunWatchers.has(folderPath)) {
					autoRunWatchers.get(folderPath)?.close();
					autoRunWatchers.delete(folderPath);
					clearPendingChangesForFolder(folderPath);
				}

				// Create folder if it doesn't exist (agent will create files in it)
				try {
					await fs.stat(folderPath);
				} catch {
					// Folder doesn't exist, create it
					await fs.mkdir(folderPath, { recursive: true });
					logger.info(`Created Auto Run folder for watching: ${folderPath}`, LOG_CONTEXT);
				}

				// Validate folder exists
				const folderStat = await fs.stat(folderPath);
				if (!folderStat.isDirectory()) {
					throw new Error('Path is not a directory');
				}

				// Start watching the folder recursively using chokidar (cross-platform)
				const watcher = chokidar.watch(folderPath, {
					ignored: [
						/(^|[/\\])\../, // Ignore dotfiles
						WINDOWS_LOCKED_SYSTEM_FILES,
					],
					persistent: true,
					ignoreInitial: true, // Don't emit events for existing files on startup
					depth: 99, // Recursive watching
				});

				// Handler for file changes — coalesces all pending changes for this folder
				// into a single debounced flush so a burst of writes produces one tick of work.
				const handleFileChange = (eventType: string) => (filePath: string) => {
					// Only care about .md files
					if (!filePath.toLowerCase().endsWith('.md')) {
						return;
					}

					const filename = path.relative(folderPath, filePath);
					const existing = autoRunWatchPending.get(folderPath);
					if (existing) {
						clearTimeout(existing.timer);
					}
					const changes = existing?.changes ?? new Map<string, string>();
					// 'rename' (add/unlink) takes precedence over 'change' for the same file.
					const prior = changes.get(filename);
					changes.set(filename, prior === 'rename' ? 'rename' : eventType);

					const timer = setTimeout(() => {
						autoRunWatchPending.delete(folderPath);
						const mainWindow = getMainWindow();
						if (!isWebContentsAvailable(mainWindow)) return;
						for (const [name, evt] of changes) {
							const filenameWithoutExt = name.replace(/\.md$/i, '');
							mainWindow.webContents.send('autorun:fileChanged', {
								folderPath,
								filename: filenameWithoutExt,
								eventType: evt,
							});
						}
						logger.info(
							`Auto Run flushed ${changes.size} change(s) for ${folderPath}`,
							LOG_CONTEXT
						);
					}, 300);
					autoRunWatchPending.set(folderPath, { timer, changes });
				};

				watcher.on('add', handleFileChange('rename'));
				watcher.on('change', handleFileChange('change'));
				watcher.on('unlink', handleFileChange('rename'));

				autoRunWatchers.set(folderPath, watcher);

				watcher.on('error', (error) => {
					logger.error(`Auto Run watcher error for ${folderPath}`, LOG_CONTEXT, error);
				});

				logger.info(`Started watching Auto Run folder: ${folderPath}`, LOG_CONTEXT);
				return {};
			}
		)
	);

	// Stop watching an Auto Run folder
	ipcMain.handle(
		'autorun:unwatchFolder',
		createIpcHandler(handlerOpts('unwatchFolder', false), async (folderPath: string) => {
			if (autoRunWatchers.has(folderPath)) {
				autoRunWatchers.get(folderPath)?.close();
				autoRunWatchers.delete(folderPath);
				logger.info(`Stopped watching Auto Run folder: ${folderPath}`, LOG_CONTEXT);
			}
			clearPendingChangesForFolder(folderPath);
			return {};
		})
	);

	// Create a backup copy of a document (for reset-on-completion)
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'autorun:createBackup',
		createIpcHandler(
			handlerOpts('createBackup'),
			async (folderPath: string, filename: string, sshRemoteId?: string) => {
				// Reject obvious traversal attempts
				if (filename.includes('..')) {
					throw new Error('Invalid filename');
				}

				// Ensure filename has .md extension
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
				const backupFilename = fullFilename.replace(/\.md$/, '.backup.md');

				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Construct remote paths (use forward slashes)
					const remoteSourcePath = `${folderPath}/${fullFilename}`;
					const remoteBackupPath = `${folderPath}/${backupFilename}`;

					logger.debug(
						`${LOG_CONTEXT} createBackup via SSH: ${remoteSourcePath} -> ${remoteBackupPath}`,
						LOG_CONTEXT
					);

					// Read source file from remote
					const readResult = await readFileRemote(remoteSourcePath, sshConfig);
					if (!readResult.success || readResult.data === undefined) {
						throw new Error(readResult.error || 'Source file not found');
					}

					// Write backup file to remote
					const writeResult = await writeFileRemote(remoteBackupPath, readResult.data, sshConfig);
					if (!writeResult.success) {
						throw new Error(writeResult.error || 'Failed to write backup file');
					}

					logger.info(`Created remote Auto Run backup: ${backupFilename}`, LOG_CONTEXT);
					return { backupFilename };
				}

				// Local: Construct paths
				const sourcePath = path.join(folderPath, fullFilename);
				const backupPath = path.join(folderPath, backupFilename);

				// Validate paths are within folder
				if (
					!validatePathWithinFolder(sourcePath, folderPath) ||
					!validatePathWithinFolder(backupPath, folderPath)
				) {
					throw new Error('Invalid file path');
				}

				// Check if source file exists
				try {
					await fs.access(sourcePath);
				} catch {
					throw new Error('Source file not found');
				}

				// Copy the file to backup
				await fs.copyFile(sourcePath, backupPath);

				logger.info(`Created Auto Run backup: ${backupFilename}`, LOG_CONTEXT);
				return { backupFilename };
			}
		)
	);

	// Restore a document from its backup (for reset-on-completion)
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'autorun:restoreBackup',
		createIpcHandler(
			handlerOpts('restoreBackup'),
			async (folderPath: string, filename: string, sshRemoteId?: string) => {
				// Reject obvious traversal attempts
				if (filename.includes('..')) {
					throw new Error('Invalid filename');
				}

				// Ensure filename has .md extension
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
				const backupFilename = fullFilename.replace(/\.md$/, '.backup.md');

				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Construct remote paths (use forward slashes)
					const remoteTargetPath = `${folderPath}/${fullFilename}`;
					const remoteBackupPath = `${folderPath}/${backupFilename}`;

					logger.debug(
						`${LOG_CONTEXT} restoreBackup via SSH: ${remoteBackupPath} -> ${remoteTargetPath}`,
						LOG_CONTEXT
					);

					// Check if backup file exists by reading it
					const readResult = await readFileRemote(remoteBackupPath, sshConfig);
					if (!readResult.success || readResult.data === undefined) {
						throw new Error('Backup file not found');
					}

					// Write backup content to original file
					const writeResult = await writeFileRemote(remoteTargetPath, readResult.data, sshConfig);
					if (!writeResult.success) {
						throw new Error(writeResult.error || 'Failed to restore backup');
					}

					// Delete the backup file
					const deleteResult = await deleteRemote(remoteBackupPath, sshConfig, false);
					if (!deleteResult.success) {
						// Log but don't fail - the restore was successful
						logger.warn(
							`${LOG_CONTEXT} Failed to delete remote backup file: ${deleteResult.error}`,
							LOG_CONTEXT
						);
					}

					logger.info(`Restored remote Auto Run backup: ${fullFilename}`, LOG_CONTEXT);
					return {};
				}

				// Local: Construct paths
				const targetPath = path.join(folderPath, fullFilename);
				const backupPath = path.join(folderPath, backupFilename);

				// Validate paths are within folder
				if (
					!validatePathWithinFolder(targetPath, folderPath) ||
					!validatePathWithinFolder(backupPath, folderPath)
				) {
					throw new Error('Invalid file path');
				}

				// Check if backup file exists
				try {
					await fs.access(backupPath);
				} catch {
					throw new Error('Backup file not found');
				}

				// Copy backup back to original
				await fs.copyFile(backupPath, targetPath);

				// Delete the backup
				await fs.unlink(backupPath);

				logger.info(`Restored Auto Run backup: ${fullFilename}`, LOG_CONTEXT);
				return {};
			}
		)
	);

	// Create a working copy of a document for reset-on-completion loops
	// Working copies are stored in /Runs/ subdirectory with format: {name}-{timestamp}-loop-{N}.md
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'autorun:createWorkingCopy',
		createIpcHandler(
			handlerOpts('createWorkingCopy'),
			async (folderPath: string, filename: string, loopNumber: number, sshRemoteId?: string) => {
				// Reject obvious traversal attempts
				if (filename.includes('..')) {
					throw new Error('Invalid filename');
				}

				// Ensure filename has .md extension for source, remove for naming
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
				const baseName = filename.endsWith('.md') ? filename.slice(0, -3) : filename;

				// Handle subdirectory paths (e.g., "Ingest-Loop/0_DISCOVER_NEW")
				const pathParts = baseName.split('/');
				const docName = pathParts[pathParts.length - 1];
				const subDir = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';

				// Generate working copy filename: {name}-{timestamp}-loop-{N}.md
				const timestamp = Date.now();
				const workingCopyName = `${docName}-${timestamp}-loop-${loopNumber}.md`;

				// Return the relative path (without .md for consistency with other APIs)
				const relativePath = subDir
					? `runs/${subDir}/${workingCopyName.slice(0, -3)}`
					: `runs/${workingCopyName.slice(0, -3)}`;

				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Construct remote paths (use forward slashes)
					const remoteSourcePath = `${folderPath}/${fullFilename}`;
					const remoteRunsDir = subDir ? `${folderPath}/runs/${subDir}` : `${folderPath}/runs`;
					const remoteWorkingCopyPath = `${remoteRunsDir}/${workingCopyName}`;

					logger.debug(
						`${LOG_CONTEXT} createWorkingCopy via SSH: ${remoteSourcePath} -> ${remoteWorkingCopyPath}`,
						LOG_CONTEXT
					);

					// Read source file from remote
					const readResult = await readFileRemote(remoteSourcePath, sshConfig);
					if (!readResult.success || readResult.data === undefined) {
						throw new Error(readResult.error || 'Source file not found');
					}

					// Create Runs directory on remote (with subdirectory if needed)
					const mkdirResult = await mkdirRemote(remoteRunsDir, sshConfig, true);
					if (!mkdirResult.success) {
						throw new Error(mkdirResult.error || 'Failed to create Runs directory');
					}

					// Write working copy to remote
					const writeResult = await writeFileRemote(
						remoteWorkingCopyPath,
						readResult.data,
						sshConfig
					);
					if (!writeResult.success) {
						throw new Error(writeResult.error || 'Failed to write working copy');
					}

					logger.info(`Created remote Auto Run working copy: ${relativePath}`, LOG_CONTEXT);
					return { workingCopyPath: relativePath, originalPath: baseName };
				}

				// Local: Construct paths
				const sourcePath = path.join(folderPath, fullFilename);

				// Validate source path is within folder
				if (!validatePathWithinFolder(sourcePath, folderPath)) {
					throw new Error('Invalid file path');
				}

				// Check if source file exists
				try {
					await fs.access(sourcePath);
				} catch {
					throw new Error('Source file not found');
				}

				// Create Runs directory (with subdirectory if needed)
				const runsDir = subDir
					? path.join(folderPath, 'runs', subDir)
					: path.join(folderPath, 'runs');
				await fs.mkdir(runsDir, { recursive: true });

				const workingCopyPath = path.join(runsDir, workingCopyName);

				// Validate working copy path is within folder
				if (!validatePathWithinFolder(workingCopyPath, folderPath)) {
					throw new Error('Invalid working copy path');
				}

				// Copy the source to working copy
				await fs.copyFile(sourcePath, workingCopyPath);

				logger.info(`Created Auto Run working copy: ${relativePath}`, LOG_CONTEXT);
				return { workingCopyPath: relativePath, originalPath: baseName };
			}
		)
	);

	// Delete all backup files in a folder
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'autorun:deleteBackups',
		createIpcHandler(
			handlerOpts('deleteBackups'),
			async (folderPath: string, sshRemoteId?: string) => {
				// SSH remote: dispatch to remote operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					logger.debug(`${LOG_CONTEXT} deleteBackups via SSH: ${folderPath}`, LOG_CONTEXT);

					// Recursive function to find and delete .backup.md files on remote
					const deleteBackupsRemoteRecursive = async (dirPath: string): Promise<number> => {
						let deleted = 0;

						// Read remote directory contents
						const dirResult = await readDirRemote(dirPath, sshConfig);
						if (!dirResult.success || !dirResult.data) {
							// Directory doesn't exist or can't be read - skip
							logger.debug(
								`${LOG_CONTEXT} Skipping remote directory: ${dirPath} - ${dirResult.error}`,
								LOG_CONTEXT
							);
							return 0;
						}

						for (const entry of dirResult.data) {
							const entryPath = `${dirPath}/${entry.name}`;

							if (entry.isDirectory) {
								// Recurse into subdirectory (including symlinked dirs)
								deleted += await deleteBackupsRemoteRecursive(entryPath);
							} else if (!entry.isDirectory && entry.name.endsWith('.backup.md')) {
								// Delete backup file
								const deleteResult = await deleteRemote(entryPath, sshConfig, false);
								if (deleteResult.success) {
									deleted++;
									logger.info(`Deleted remote Auto Run backup: ${entry.name}`, LOG_CONTEXT);
								} else {
									logger.warn(
										`${LOG_CONTEXT} Failed to delete remote backup ${entry.name}: ${deleteResult.error}`,
										LOG_CONTEXT
									);
								}
							}
						}

						return deleted;
					};

					const deletedCount = await deleteBackupsRemoteRecursive(folderPath);
					logger.info(
						`Deleted ${deletedCount} remote Auto Run backup(s) in ${folderPath}`,
						LOG_CONTEXT
					);
					return { deletedCount };
				}

				// Local: Validate folder exists
				const folderStat = await fs.stat(folderPath);
				if (!folderStat.isDirectory()) {
					throw new Error('Path is not a directory');
				}

				// Find and delete all .backup.md files recursively
				const deleteBackupsRecursive = async (dirPath: string): Promise<number> => {
					let deleted = 0;
					const entries = await fs.readdir(dirPath, { withFileTypes: true });

					for (const entry of entries) {
						const entryPath = path.join(dirPath, entry.name);

						if (entry.isDirectory()) {
							// Recurse into subdirectory
							deleted += await deleteBackupsRecursive(entryPath);
						} else if (entry.isFile() && entry.name.endsWith('.backup.md')) {
							// Delete backup file
							await fs.unlink(entryPath);
							deleted++;
							logger.info(`Deleted Auto Run backup: ${entry.name}`, LOG_CONTEXT);
						}
					}

					return deleted;
				};

				const deletedCount = await deleteBackupsRecursive(folderPath);
				logger.info(`Deleted ${deletedCount} Auto Run backup(s) in ${folderPath}`, LOG_CONTEXT);
				return { deletedCount };
			}
		)
	);

	// Clean up all watchers on app quit
	app.on('before-quit', () => {
		for (const [folderPath, watcher] of autoRunWatchers) {
			watcher.close();
			logger.info(`Cleaned up Auto Run watcher for: ${folderPath}`, LOG_CONTEXT);
		}
		autoRunWatchers.clear();
	});

	logger.debug(`${LOG_CONTEXT} Auto Run IPC handlers registered`);
}
