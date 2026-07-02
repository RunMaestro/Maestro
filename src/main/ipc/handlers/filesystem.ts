/**
 * Filesystem IPC Handlers
 *
 * This module handles IPC calls for filesystem operations:
 * - homeDir: Get user home directory
 * - readDir: Read directory contents (local & SSH remote)
 * - readFile: Read file contents with image base64 encoding (local & SSH remote)
 * - stat: Get file/directory statistics (local & SSH remote)
 * - directorySize: Calculate directory size recursively (local & SSH remote)
 * - writeFile: Write content to file (local & SSH remote)
 * - rename: Rename file/directory (local & SSH remote)
 * - copyPath: Copy a file/directory into a destination (local only; drag-import)
 * - delete: Delete file/directory (local & SSH remote)
 * - countItems: Count files and folders recursively (local & SSH remote)
 * - fetchImageAsBase64: Fetch image from URL and return as base64
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';

import { logger } from '../../utils/logger';
import {
	shouldIgnore,
	parseGitignoreContent,
	LOCAL_IGNORE_DEFAULTS,
} from '../../../shared/globUtils';
import {
	readDirRemote,
	readFileRemote,
	readBinaryFileRemoteAsBase64,
	readFileRemoteAbortable,
	writeFileRemote,
	mkdirRemote,
	statRemote,
	directorySizeRemote,
	renameRemote,
	deleteRemote,
	existsRemote,
	countItemsRemote,
	listTreeRemote,
	type ListTreeOptions,
} from '../../utils/remote-fs';
import type { SshRemoteConfig } from '../../../shared/types';
import { resolveDirentType } from '../../utils/dirent-utils';
import { getDragOutIcon } from '../../utils/drag-out-icon';
import { getSshRemoteById } from '../../stores';
import { captureException } from '../../utils/sentry';

/**
 * Recursively upload a local directory to a remote host over SSH.
 *
 * Creates `remoteDir` (mkdir -p), then walks the local tree, streaming each file
 * to the remote via {@link writeFileRemote} (base64 over the SSH stdin channel,
 * binary-safe) and re-creating subdirectories as it descends. Remote paths are
 * always joined with POSIX `/` - never `path.join`, which would emit `\` on a
 * Windows host and break the remote shell.
 */
async function uploadDirToRemote(
	localDir: string,
	remoteDir: string,
	sshConfig: SshRemoteConfig
): Promise<void> {
	const mk = await mkdirRemote(remoteDir, sshConfig, true);
	if (!mk.success) {
		throw new Error(mk.error || `Failed to create remote directory: ${remoteDir}`);
	}
	const entries = await fs.readdir(localDir, { withFileTypes: true });
	for (const entry of entries) {
		const localChild = path.join(localDir, entry.name);
		const remoteChild = `${remoteDir}/${entry.name}`;
		const resolved = await resolveDirentType(entry, localChild);
		if (resolved.isDirectory) {
			await uploadDirToRemote(localChild, remoteChild, sshConfig);
		} else {
			const bytes = await fs.readFile(localChild);
			const res = await writeFileRemote(remoteChild, bytes, sshConfig);
			if (!res.success) {
				throw new Error(res.error || `Failed to upload file: ${localChild}`);
			}
		}
	}
}

/**
 * Upload a local file or directory to a remote host over SSH - the drag-and-drop
 * import path when the file panel is showing a remote (SSH) session. The dropped
 * source always lives on the local machine; the destination is on the remote.
 *
 * `overwrite` mirrors the local `fs.cp` semantics the renderer already decided
 * via the move-conflict modal: when true any existing remote target is removed
 * first (file or directory, wholesale); when false an existing target is a hard
 * error so the caller surfaces the conflict instead of silently clobbering.
 */
async function uploadLocalPathToRemote(
	localSource: string,
	remoteDest: string,
	sshConfig: SshRemoteConfig,
	overwrite: boolean
): Promise<void> {
	const stat = await fs.stat(localSource);

	if (overwrite) {
		const del = await deleteRemote(remoteDest, sshConfig, true);
		if (!del.success) {
			throw new Error(del.error || `Failed to clear remote destination: ${remoteDest}`);
		}
	} else {
		const exists = await existsRemote(remoteDest, sshConfig);
		if (exists.success && exists.data) {
			throw new Error(`Destination already exists: ${remoteDest}`);
		}
	}

	if (stat.isDirectory()) {
		await uploadDirToRemote(localSource, remoteDest, sshConfig);
	} else {
		const bytes = await fs.readFile(localSource);
		const res = await writeFileRemote(remoteDest, bytes, sshConfig);
		if (!res.success) {
			throw new Error(res.error || `Failed to upload file: ${localSource}`);
		}
	}
}

/**
 * Supported image file extensions for base64 encoding
 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];

/**
 * Check if a hostname resolves to a private/internal network address.
 * Blocks SSRF attacks targeting localhost, private RFC1918 ranges,
 * link-local addresses, and cloud metadata endpoints.
 */
function isPrivateHostname(hostname: string): boolean {
	// Localhost variants
	if (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname === '::1' ||
		hostname === '0.0.0.0' ||
		hostname.endsWith('.localhost')
	) {
		return true;
	}

	// Cloud metadata endpoints
	if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
		return true;
	}

	// IPv4 private/reserved ranges
	const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4Match) {
		const [, a, b] = ipv4Match.map(Number);
		if (
			a === 10 || // 10.0.0.0/8
			a === 127 || // 127.0.0.0/8
			(a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
			(a === 192 && b === 168) || // 192.168.0.0/16
			(a === 169 && b === 254) || // 169.254.0.0/16 (link-local)
			a === 0 // 0.0.0.0/8
		) {
			return true;
		}
	}

	return false;
}

/**
 * Register all filesystem-related IPC handlers.
 */
export function registerFilesystemHandlers(): void {
	// Get user home directory
	ipcMain.handle('fs:homeDir', () => {
		return os.homedir();
	});

	// Read directory contents (supports SSH remote)
	ipcMain.handle('fs:readDir', async (_, dirPath: string, sshRemoteId?: string) => {
		// SSH remote: dispatch to remote fs operations
		if (sshRemoteId) {
			const sshConfig = getSshRemoteById(sshRemoteId);
			if (!sshConfig) {
				throw new Error(`SSH remote not found: ${sshRemoteId}`);
			}
			const result = await readDirRemote(dirPath, sshConfig);
			if (!result.success) {
				throw new Error(result.error || 'Failed to read remote directory');
			}
			// Map remote entries to match local format.
			// For symlinks, resolve target type via remote stat so directory/file links remain visible.
			// Include full path for recursive directory scanning (e.g., document graph).
			return await Promise.all(
				result.data!.map(async (entry) => {
					const fullPath = dirPath.endsWith('/')
						? `${dirPath}${entry.name}`
						: `${dirPath}/${entry.name}`;
					let isDirectory = entry.isDirectory;
					let isFile = !entry.isDirectory && !entry.isSymlink;
					if (entry.isSymlink) {
						const statResult = await statRemote(fullPath, sshConfig);
						if (statResult.success && statResult.data) {
							isDirectory = statResult.data.isDirectory;
							isFile = !statResult.data.isDirectory;
						} else {
							// Broken symlink or inaccessible target: keep entry visible as symlink
							isDirectory = false;
							isFile = false;
						}
					}
					return {
						name: entry.name.normalize('NFC'),
						isDirectory,
						isFile,
						...(entry.isSymlink ? { isSymlink: true } : {}),
						// Preserve raw filesystem name in path for correct remote operations
						path: fullPath,
					};
				})
			);
		}

		// Local: use standard fs operations
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		// Convert Dirent objects to plain objects for IPC serialization.
		// Resolve symlinks via resolveDirentType so linked directories/files are not dropped.
		// Broken symlinks are shown as files so they still appear in the browser.
		// Include full path for recursive directory scanning (e.g., document graph).
		return Promise.all(
			entries.map(async (entry) => {
				const fullPath = path.join(dirPath, entry.name);
				const resolved = await resolveDirentType(entry, fullPath);
				const isSymlink = entry.isSymbolicLink?.() === true;
				return {
					name: entry.name.normalize('NFC'),
					isDirectory: resolved.isDirectory,
					isFile: resolved.isFile || resolved.isBrokenSymlink,
					...(isSymlink ? { isSymlink: true } : {}),
					// Preserve raw filesystem name in path for correct local operations
					path: fullPath,
				};
			})
		);
	});

	// In-flight cancellable remote reads keyed by renderer-supplied requestId.
	// Lets the renderer SIGTERM the underlying ssh+cat when the user closes
	// the file tab mid-load (e.g. they double-clicked a huge file by mistake).
	const inflightReads = new Map<string, AbortController>();

	// Read file contents (supports SSH remote, with image base64 encoding).
	// requestId is optional; when present, the read is cancellable via fs:cancelReadFile.
	ipcMain.handle(
		'fs:readFile',
		async (_, filePath: string, sshRemoteId?: string, requestId?: string) => {
			try {
				// SSH remote: dispatch to remote fs operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}

					// Images must be read as base64 ON THE REMOTE: a `cat`-over-SSH read
					// returns stdout decoded as text, which mangles binary bytes beyond
					// local recovery (the old "binary images may have issues" path). The
					// remote `base64` output is pure ASCII and survives the text channel.
					const imgExt = filePath.split('.').pop()?.toLowerCase();
					if (IMAGE_EXTENSIONS.includes(imgExt || '')) {
						const imgResult = await readBinaryFileRemoteAsBase64(filePath, sshConfig);
						if (!imgResult.success) {
							if (imgResult.error?.startsWith('File not found:')) {
								return null;
							}
							throw new Error(imgResult.error || 'Failed to read remote image');
						}
						const mimeType = imgExt === 'svg' ? 'image/svg+xml' : `image/${imgExt}`;
						return `data:${mimeType};base64,${imgResult.data}`;
					}

					let result: Awaited<ReturnType<typeof readFileRemote>>;
					if (requestId) {
						const controller = new AbortController();
						inflightReads.set(requestId, controller);
						try {
							result = await readFileRemoteAbortable(filePath, sshConfig, controller.signal);
						} finally {
							inflightReads.delete(requestId);
						}
						if (controller.signal.aborted) {
							// Surface cancellation as null so the renderer can ignore
							// the result without it being a generic error.
							return null;
						}
					} else {
						result = await readFileRemote(filePath, sshConfig);
					}
					if (!result.success) {
						// Missing remote files mirror the local ENOENT path below: return
						// null instead of throwing so callers can handle absence cleanly
						// without surfacing an unhandled IPC rejection. (MAESTRO-MG/MF)
						if (result.error?.startsWith('File not found:')) {
							return null;
						}
						throw new Error(result.error || 'Failed to read remote file');
					}
					return result.data!;
				}

				// Local: use standard fs operations
				// Check if file is an image
				const ext = filePath.split('.').pop()?.toLowerCase();
				const isImage = IMAGE_EXTENSIONS.includes(ext || '');

				if (isImage) {
					// Read image as buffer and convert to base64 data URL
					const buffer = await fs.readFile(filePath);
					const base64 = buffer.toString('base64');
					const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
					return `data:${mimeType};base64,${base64}`;
				} else {
					// Read text files as UTF-8
					const content = await fs.readFile(filePath, 'utf-8');
					return content;
				}
			} catch (error: any) {
				// Return null for missing files instead of throwing.
				// Prevents noisy Electron IPC error logging when callers
				// expect files that may not exist (e.g., .gitignore).
				if (error?.code === 'ENOENT') {
					return null;
				}
				// EISDIR happens when a caller passes a directory path (e.g., user
				// clicks an entry that resolved to a folder). Treat like ENOENT —
				// return null so the renderer can handle the absence cleanly instead
				// of surfacing an unhandled IPC rejection. Fixes MAESTRO-JP.
				if (error?.code === 'EISDIR') {
					return null;
				}
				throw new Error(`Failed to read file: ${error}`);
			}
		}
	);

	// Enumerate a remote directory tree in a single SSH round-trip.
	// Replaces N-per-directory `ls` recursion with two batched `find` calls
	// bundled into one SSH command. Used by the file explorer to load remote
	// trees in 1–2 round-trips total instead of one per directory.
	// SSH-only: local trees use direct fs recursion in the renderer.
	ipcMain.handle(
		'fs:listTreeRemote',
		async (_, rootPath: string, sshRemoteId: string, options: ListTreeOptions) => {
			const sshConfig = getSshRemoteById(sshRemoteId);
			if (!sshConfig) {
				throw new Error(`SSH remote not found: ${sshRemoteId}`);
			}
			const result = await listTreeRemote(rootPath, options, sshConfig);
			if (!result.success) {
				throw new Error(result.error || 'Failed to list remote tree');
			}
			// Normalize names to NFC to match the readDir handler's behavior
			// (paths may contain composed/decomposed unicode on macOS remotes).
			return {
				directories: result.data!.directories.map((p) => p.normalize('NFC')),
				files: result.data!.files.map((p) => p.normalize('NFC')),
				truncated: result.data!.truncated,
			};
		}
	);

	// Cancel an in-flight remote file read by requestId.
	// Aborts the SSH child process so we don't waste bandwidth on a file the
	// user already closed. No-op if the requestId is unknown (read may have
	// completed or never started).
	ipcMain.handle('fs:cancelReadFile', (_, requestId: string) => {
		const controller = inflightReads.get(requestId);
		if (controller) {
			controller.abort();
		}
	});

	// Download a remote SSH file to the local disk. The remote bytes are read as
	// base64 ON THE REMOTE (binary-safe over SSH's text channel) and decoded to
	// raw bytes locally. SSH-only: there is no local fallback because a local file
	// is already on disk and needs no download. When `localDestPath` is omitted the
	// file lands in a temp dir (used by "Open in Default App" for remote binaries);
	// pass an explicit path for the user-chosen "Download File" save location.
	// Returns the absolute path the file was written to.
	ipcMain.handle(
		'fs:downloadRemoteFile',
		async (_, remotePath: string, sshRemoteId: string, localDestPath?: string) => {
			const sshConfig = getSshRemoteById(sshRemoteId);
			if (!sshConfig) {
				throw new Error(`SSH remote not found: ${sshRemoteId}`);
			}

			const result = await readBinaryFileRemoteAsBase64(remotePath, sshConfig);
			if (!result.success) {
				throw new Error(result.error || `Failed to download remote file: ${remotePath}`);
			}

			let destPath = localDestPath;
			if (!destPath) {
				const tempDir = path.join(os.tmpdir(), 'maestro-remote-downloads');
				await fs.mkdir(tempDir, { recursive: true });
				destPath = path.join(tempDir, path.basename(remotePath));
			}

			await fs.writeFile(destPath, Buffer.from(result.data ?? '', 'base64'));
			return { success: true, path: destPath };
		}
	);

	// Get file/directory statistics (supports SSH remote)
	ipcMain.handle('fs:stat', async (_, filePath: string, sshRemoteId?: string) => {
		try {
			// SSH remote: dispatch to remote fs operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				const result = await statRemote(filePath, sshConfig);
				if (!result.success) {
					// Missing remote paths return null instead of throwing (mirrors the
					// local ENOENT handling below and fs:readFile) so callers can handle
					// absence without an unhandled IPC rejection. (MAESTRO-MH/ME)
					if (result.error?.startsWith('Path not found:')) {
						return null;
					}
					throw new Error(result.error || 'Failed to get remote file stats');
				}
				// Map remote stat result to match local format
				// Note: remote stat doesn't provide createdAt (birthtime), use mtime as fallback
				const mtimeDate = new Date(result.data!.mtime);
				return {
					size: result.data!.size,
					createdAt: mtimeDate.toISOString(), // Fallback: use mtime for createdAt
					modifiedAt: mtimeDate.toISOString(),
					isDirectory: result.data!.isDirectory,
					isFile: !result.data!.isDirectory,
				};
			}

			// Local: use standard fs operations
			const stats = await fs.stat(filePath);
			return {
				size: stats.size,
				createdAt: stats.birthtime.toISOString(),
				modifiedAt: stats.mtime.toISOString(),
				isDirectory: stats.isDirectory(),
				isFile: stats.isFile(),
			};
		} catch (error: any) {
			// Return null for missing files/paths instead of throwing, matching the
			// fs:readFile handler's ENOENT contract. Callers stat phantom targets
			// routinely (e.g. the Document Graph following unresolved [[wiki]] links),
			// and a missing target is an expected, benign condition - not an error.
			// ENOTDIR covers links that treat a file as a directory (e.g. `[[file.md/sub]]`).
			// Mirrors fs:readFile so callers avoid an unhandled IPC rejection reaching
			// Sentry. (MAESTRO-MH/ME)
			if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
				return null;
			}
			throw new Error(`Failed to get file stats: ${error}`);
		}
	});

	// Calculate total size of a directory recursively
	// Respects the same ignore patterns as loadFileTree
	ipcMain.handle(
		'fs:directorySize',
		async (
			_,
			dirPath: string,
			sshRemoteId?: string,
			ignorePatterns?: string[],
			honorGitignore?: boolean
		) => {
			// SSH remote: dispatch to remote fs operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				// Fetch size and counts in parallel for SSH remotes
				const [sizeResult, countResult] = await Promise.all([
					directorySizeRemote(dirPath, sshConfig),
					countItemsRemote(dirPath, sshConfig),
				]);
				if (!sizeResult.success) {
					throw new Error(sizeResult.error || 'Failed to get remote directory size');
				}
				return {
					totalSize: sizeResult.data!,
					fileCount: countResult.success ? countResult.data!.fileCount : 0,
					folderCount: countResult.success ? countResult.data!.folderCount : 0,
				};
			}

			// Build effective ignore patterns (same logic as loadFileTree)
			let effectivePatterns = ignorePatterns ?? LOCAL_IGNORE_DEFAULTS;

			if (honorGitignore) {
				try {
					const gitignorePath = path.join(dirPath, '.gitignore');
					const content = await fs.readFile(gitignorePath, 'utf-8');
					if (content) {
						effectivePatterns = [...effectivePatterns, ...parseGitignoreContent(content)];
					}
				} catch {
					// .gitignore may not exist or be readable — not an error
				}
			}

			// Local: use standard fs operations
			let totalSize = 0;
			let fileCount = 0;
			let folderCount = 0;

			const calculateSize = async (currentPath: string, depth: number = 0): Promise<void> => {
				// Limit recursion depth to match file tree loading
				if (depth >= 10) return;

				try {
					const entries = await fs.readdir(currentPath, { withFileTypes: true });

					for (const entry of entries) {
						if (shouldIgnore(entry.name, effectivePatterns)) {
							continue;
						}

						const fullPath = path.join(currentPath, entry.name);

						if (entry.isDirectory()) {
							folderCount++;
							await calculateSize(fullPath, depth + 1);
						} else if (entry.isFile()) {
							fileCount++;
							try {
								const stats = await fs.stat(fullPath);
								totalSize += stats.size;
							} catch {
								// Skip files we can't stat (permissions, etc.)
							}
						}
					}
				} catch {
					// Skip directories we can't read
				}
			};

			await calculateSize(dirPath);

			return {
				totalSize,
				fileCount,
				folderCount,
			};
		}
	);

	// Write content to file (supports SSH remote)
	ipcMain.handle(
		'fs:writeFile',
		async (_, filePath: string, content: string, sshRemoteId?: string) => {
			try {
				// SSH remote: dispatch to remote fs operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					const result = await writeFileRemote(filePath, content, sshConfig);
					if (!result.success) {
						throw new Error(result.error || 'Failed to write remote file');
					}
					return { success: true };
				}

				// Local: use standard fs operations
				await fs.writeFile(filePath, content, 'utf-8');
				return { success: true };
			} catch (error) {
				throw new Error(`Failed to write file: ${error}`);
			}
		}
	);

	// Write a base64 data URL to disk as binary (supports SSH remote). Used by
	// the image annotator's "save to file" flow, where the composited image is a
	// `data:image/...;base64,...` URL that must be written as raw bytes (the
	// plain `fs:writeFile` handler encodes content as UTF-8, which corrupts
	// binary payloads).
	ipcMain.handle(
		'fs:writeImageFile',
		async (_, filePath: string, dataUrl: string, sshRemoteId?: string) => {
			try {
				const commaIndex = dataUrl.indexOf(',');
				const base64 =
					commaIndex >= 0 && dataUrl.startsWith('data:') ? dataUrl.slice(commaIndex + 1) : dataUrl;
				const buffer = Buffer.from(base64, 'base64');

				// SSH remote: writeFileRemote accepts a Buffer and base64-encodes it
				// for safe transfer, decoding on the remote side.
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					const result = await writeFileRemote(filePath, buffer, sshConfig);
					if (!result.success) {
						throw new Error(result.error || 'Failed to write remote file');
					}
					return { success: true };
				}

				await fs.writeFile(filePath, buffer);
				return { success: true };
			} catch (error) {
				throw new Error(`Failed to write image file: ${error}`);
			}
		}
	);

	// Create a directory (supports SSH remote). Recursive so intermediate
	// parents are created as needed.
	ipcMain.handle('fs:mkdir', async (_, dirPath: string, sshRemoteId?: string) => {
		try {
			// SSH remote: dispatch to remote fs operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				const result = await mkdirRemote(dirPath, sshConfig, true);
				if (!result.success) {
					throw new Error(result.error || 'Failed to create remote directory');
				}
				return { success: true };
			}

			// Local: standard fs mkdir
			await fs.mkdir(dirPath, { recursive: true });
			return { success: true };
		} catch (error) {
			throw new Error(`Failed to create directory: ${error}`);
		}
	});

	// Rename a file or folder (supports SSH remote)
	ipcMain.handle('fs:rename', async (_, oldPath: string, newPath: string, sshRemoteId?: string) => {
		try {
			// SSH remote: dispatch to remote fs operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				const result = await renameRemote(oldPath, newPath, sshConfig);
				if (!result.success) {
					throw new Error(result.error || 'Failed to rename remote file');
				}
				return { success: true };
			}

			// Local: standard fs rename
			await fs.rename(oldPath, newPath);
			return { success: true };
		} catch (error) {
			throw new Error(`Failed to rename: ${error}`);
		}
	});

	// Copy a file or folder from an arbitrary source path into a destination path.
	// Used by drag-and-drop import of OS files/folders into the file tree. The
	// source is always a local OS path; the destination is local unless
	// `sshRemoteId` is set, in which case the source is uploaded to the remote
	// host over SSH (the file panel is showing a remote session).
	ipcMain.handle(
		'fs:copyPath',
		async (
			_,
			sourcePath: string,
			destPath: string,
			options?: { overwrite?: boolean; sshRemoteId?: string }
		) => {
			try {
				const overwrite = options?.overwrite ?? false;
				const sshRemoteId = options?.sshRemoteId;

				// SSH remote: dest lives on the remote host - upload the local source.
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					await uploadLocalPathToRemote(sourcePath, destPath, sshConfig, overwrite);
					return { success: true };
				}

				// `recursive: true` copies folders wholesale; for plain files it is a no-op.
				// `force`/`errorOnExist` encode the conflict decision the renderer already made.
				await fs.cp(sourcePath, destPath, {
					recursive: true,
					force: overwrite,
					errorOnExist: !overwrite,
				});
				return { success: true };
			} catch (error) {
				throw new Error(`Failed to copy: ${error}`);
			}
		}
	);

	// Delete a file or folder (with recursive option for folders, supports SSH remote)
	ipcMain.handle(
		'fs:delete',
		async (_, targetPath: string, options?: { recursive?: boolean; sshRemoteId?: string }) => {
			try {
				const sshRemoteId = options?.sshRemoteId;

				// SSH remote: dispatch to remote fs operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					const result = await deleteRemote(targetPath, sshConfig, options?.recursive ?? true);
					if (!result.success) {
						throw new Error(result.error || 'Failed to delete remote file');
					}
					return { success: true };
				}

				// Local: standard fs delete
				const stat = await fs.stat(targetPath);
				if (stat.isDirectory()) {
					await fs.rm(targetPath, { recursive: options?.recursive ?? true, force: true });
				} else {
					await fs.unlink(targetPath);
				}
				return { success: true };
			} catch (error) {
				throw new Error(`Failed to delete: ${error}`);
			}
		}
	);

	// Count items in a directory (for delete confirmation, supports SSH remote)
	ipcMain.handle('fs:countItems', async (_, dirPath: string, sshRemoteId?: string) => {
		try {
			// SSH remote: dispatch to remote fs operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				const result = await countItemsRemote(dirPath, sshConfig);
				if (!result.success || !result.data) {
					throw new Error(result.error || 'Failed to count remote items');
				}
				return result.data;
			}

			// Local: standard fs count
			let fileCount = 0;
			let folderCount = 0;

			const countRecursive = async (dir: string) => {
				const entries = await fs.readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					const resolved = await resolveDirentType(entry, fullPath);
					if (resolved.isDirectory) {
						folderCount++;
						await countRecursive(fullPath);
					} else {
						// Files, symlinks-to-files, and broken symlinks all count as files
						fileCount++;
					}
				}
			};

			await countRecursive(dirPath);
			return { fileCount, folderCount };
		} catch (error) {
			throw new Error(`Failed to count items: ${error}`);
		}
	});

	// Fetch image from URL and return as base64 data URL (avoids CORS issues)
	// Only allows http/https and blocks requests to private/internal networks (SSRF protection)
	ipcMain.handle('fs:fetchImageAsBase64', async (_, url: string) => {
		try {
			// Validate URL and enforce protocol whitelist
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new Error(`Invalid URL: ${url}`);
			}
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				throw new Error(`Protocol not allowed: ${parsed.protocol}`);
			}

			// Block requests to private/internal network addresses
			const hostname = parsed.hostname.toLowerCase();
			if (isPrivateHostname(hostname)) {
				throw new Error(`Requests to private/internal addresses are not allowed: ${hostname}`);
			}

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			// Validate response content-type is an image
			const contentType = response.headers.get('content-type') || '';
			if (!contentType.startsWith('image/')) {
				throw new Error(`Response is not an image: ${contentType}`);
			}

			const arrayBuffer = await response.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			const base64 = buffer.toString('base64');
			return `data:${contentType};base64,${base64}`;
		} catch (error) {
			void captureException(error);
			// Return null on failure - let caller handle gracefully
			logger.warn(`Failed to fetch image from ${url}: ${error}`, 'fs:fetchImageAsBase64');
			return null;
		}
	});

	// Start an OS-level file drag-out (drag a file from the file panel to Finder/
	// Explorer). Uses Electron's `webContents.startDrag`, which must run on the
	// sender's webContents and *replaces* the in-flight HTML5 drag - the renderer
	// gates this behind a modifier so the normal move/@mention drag is untouched.
	//
	// `paths` are absolute LOCAL paths that must already exist on disk: for remote
	// (SSH) files the renderer downloads to a temp file first and passes that. We
	// filter to existing paths so a stale/racing path can't make startDrag throw.
	// Fire-and-forget (`ipcMain.on`) so it attaches to the live drag gesture with
	// minimal latency.
	ipcMain.on('fs:startDragOut', (event, paths?: unknown) => {
		try {
			if (!Array.isArray(paths)) return;
			const existing = paths.filter(
				(p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p)
			);
			if (existing.length === 0) return;
			const icon = getDragOutIcon();
			// `file` for a single item, `files` for a batch - both are valid startDrag
			// shapes; passing the singular form for one item is the documented default.
			event.sender.startDrag(
				existing.length === 1
					? { file: existing[0], icon }
					: { file: existing[0], files: existing, icon }
			);
		} catch (error) {
			logger.warn(`Failed to start OS file drag-out: ${error}`, 'fs:startDragOut');
			void captureException(error);
		}
	});
}
