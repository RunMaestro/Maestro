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

import { logger } from '../../utils/logger';
import {
	readDirRemote,
	readFileRemote,
	writeFileRemote,
	statRemote,
	directorySizeRemote,
	renameRemote,
	deleteRemote,
	countItemsRemote,
} from '../../utils/remote-fs';
import { getSshRemoteById } from '../../stores';

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
			// Map remote entries to match local format (isFile derived from !isDirectory && !isSymlink)
			// Include full path for recursive directory scanning (e.g., document graph)
			// Use POSIX path joining for remote paths (always forward slashes)
			return result.data!.map((entry) => ({
				name: entry.name.normalize('NFC'),
				isDirectory: entry.isDirectory,
				isFile: !entry.isDirectory && !entry.isSymlink,
				// Preserve raw filesystem name in path for correct remote operations
				path: dirPath.endsWith('/') ? `${dirPath}${entry.name}` : `${dirPath}/${entry.name}`,
			}));
		}

		// Local: use standard fs operations
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		// Convert Dirent objects to plain objects for IPC serialization
		// Include full path for recursive directory scanning (e.g., document graph)
		return entries.map((entry: any) => ({
			name: entry.name.normalize('NFC'),
			isDirectory: entry.isDirectory(),
			isFile: entry.isFile(),
			// Preserve raw filesystem name in path for correct local operations
			path: path.join(dirPath, entry.name),
		}));
	});

	// Read file contents (supports SSH remote, with image base64 encoding)
	ipcMain.handle('fs:readFile', async (_, filePath: string, sshRemoteId?: string) => {
		try {
			// SSH remote: dispatch to remote fs operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				const result = await readFileRemote(filePath, sshConfig);
				if (!result.success) {
					throw new Error(result.error || 'Failed to read remote file');
				}
				// For images over SSH, we'd need to base64 encode on remote and decode here
				// For now, return raw content (text files work, binary images may have issues)
				const ext = filePath.split('.').pop()?.toLowerCase();
				const isImage = IMAGE_EXTENSIONS.includes(ext || '');
				if (isImage) {
					// The remote readFile returns raw bytes as string - convert to base64 data URL
					const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
					const base64 = Buffer.from(result.data!, 'binary').toString('base64');
					return `data:${mimeType};base64,${base64}`;
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
			throw new Error(`Failed to read file: ${error}`);
		}
	});

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
		} catch (error) {
			throw new Error(`Failed to get file stats: ${error}`);
		}
	});

	// Calculate total size of a directory recursively
	// Respects the same ignore patterns as loadFileTree (node_modules, __pycache__)
	ipcMain.handle('fs:directorySize', async (_, dirPath: string, sshRemoteId?: string) => {
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
					// Skip common ignore patterns (same as loadFileTree)
					if (entry.name === 'node_modules' || entry.name === '__pycache__') {
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
	});

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
					if (entry.isDirectory()) {
						folderCount++;
						await countRecursive(path.join(dir, entry.name));
					} else {
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
			// Return null on failure - let caller handle gracefully
			logger.warn(`Failed to fetch image from ${url}: ${error}`, 'fs:fetchImageAsBase64');
			return null;
		}
	});
}
