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
 * - deleteMany: Delete a batch of files/directories in one call (local & SSH remote)
 * - countItems: Count files and folders recursively (local & SSH remote)
 * - compressFolder: Zip a folder into its parent dir (local & SSH remote)
 * - fetchImageAsBase64: Fetch image from URL and return as base64
 * - downloadRemoteFile / downloadRemoteFolder: Fetch a remote file or folder to this machine
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import { existsSync, createWriteStream } from 'fs';
import archiver from 'archiver';
import * as chokidar from 'chokidar';

import { logger } from '../../utils/logger';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout';
import {
	shouldIgnore,
	parseGitignoreContent,
	LOCAL_IGNORE_DEFAULTS,
} from '../../../shared/globUtils';
import { isMediaFile } from '../../../shared/mediaTypes';
import { normalizeRootRelativePath } from '../../../shared/pathContainment';
import { isWindows } from '../../../shared/platformDetection';
import { createKeyedWriteQueue } from '../../../shared/keyedWriteQueue';
import { generateUUID } from '../../../shared/uuid';
import { formatSize } from '../../../shared/formatters';
import { buildParquetPreviewMarker, isParquetFile } from '../../../shared/parquet/preview';
import { buildSqlitePreviewMarker } from '../../../shared/sqlite/preview';
import { isSqliteDatabaseFile } from '../../sqlite/sqlite-detect';
import { getImageMimeType } from '../../../shared/gitUtils';
import { buildLocalMediaStreamUrl } from '../../media/media-stream';
import {
	readDirRemote,
	readFileRemote,
	readBinaryFileRemoteAsBase64,
	readFileRemoteAbortable,
	writeFileRemote,
	replaceFileRemoteIfUnchanged,
	mkdirRemote,
	statRemote,
	renameRemote,
	deleteRemote,
	deleteManyRemote,
	existsRemote,
	countItemsRemote,
	compressFolderRemote,
	listTreeRemote,
	sha256FileRemote,
	type ListTreeOptions,
} from '../../utils/remote-fs';
import type { RemoteCopyWatchResult, SshRemoteConfig } from '../../../shared/types';
import { resolveDirentType } from '../../utils/dirent-utils';
import { walkLocalFileTree } from '../../utils/file-tree-walk';
import { getDragOutIcon } from '../../utils/drag-out-icon';
import { getSshRemoteById } from '../../stores';
import {
	createRemoteCopyWriteBack,
	RemoteCopyTooLargeError,
	type RemoteCopyWriteBack,
	type RemoteCopyWriteBackEvent,
} from '../../utils/remote-copy-write-back';
import type { SafeSendFn } from '../../utils/safe-send';
import { captureException } from '../../utils/sentry';
import { mapWithConcurrency, LOCAL_FILE_DELETE_CONCURRENCY } from '../../utils/concurrency';
import { getHostDirectoryInfo } from '../../utils/host-directory';

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
 * Where `fs:downloadRemoteFile` / `fs:downloadRemoteFolder` put a fetched copy
 * when the caller names no destination: one temp folder per remote parent
 * folder, so two remote entries that share a name (`a/notes.pdf`,
 * `b/notes.pdf`) never overwrite each other's copy while one of them is open,
 * playing, or being dragged. The entry keeps its own name, which is what Finder
 * and the opener show.
 */
function remoteDownloadTempPath(sshRemoteId: string, remotePath: string): string {
	const name = path.posix.basename(remotePath);
	if (!isLocalPathSegment(name)) {
		throw new Error(`Refusing a remote name that is not one file name on this computer: ${name}`);
	}
	const folderKey = createHash('sha1')
		.update(`${sshRemoteId}\0${path.posix.dirname(remotePath)}`)
		.digest('hex')
		.slice(0, 12);
	const folder = path.join(os.tmpdir(), 'maestro-remote-downloads', folderKey);
	const dest = path.join(folder, name);
	// The join is checked as well, so the name rule is not the only thing
	// between a remote name and a path outside the folder.
	if (path.dirname(dest) !== folder || path.basename(dest) !== name) {
		throw new Error(`Refusing a remote name that is not one file name on this computer: ${name}`);
	}
	return dest;
}

/**
 * Whether a name off a POSIX remote is exactly one path segment on this
 * machine. A remote name can hold `\` and `C:`, which Windows reads as a
 * separator and a drive: a remote folder named `..\..\victim` would join to a
 * path outside the download folder. So Windows takes only a name
 * `normalizeRootRelativePath()` leaves as it is. Elsewhere those are ordinary
 * characters and the name is kept, so the copy is the file the remote listed.
 */
function isLocalPathSegment(name: string): boolean {
	if (name === '' || name === '.' || name === '..') return false;
	if (name.includes('/') || name.includes('\0')) return false;
	return !isWindows() || normalizeRootRelativePath(name) === name;
}

/**
 * A sibling of `localPath` to write into before it takes `localPath`'s place.
 * Same folder, because a rename cannot cross volumes; a fresh name each time,
 * so two downloads of one path never share it.
 */
function stagingPathFor(localPath: string): string {
	return path.join(path.dirname(localPath), `.maestro-part-${generateUUID()}`);
}

/** Read one remote file's bytes (binary-safe). */
async function readRemoteFileBytes(
	remotePath: string,
	sshConfig: SshRemoteConfig
): Promise<Buffer> {
	const result = await readBinaryFileRemoteAsBase64(remotePath, sshConfig);
	if (!result.success) {
		throw new Error(result.error || `Failed to download remote file: ${remotePath}`);
	}
	return Buffer.from(result.data ?? '', 'base64');
}

/**
 * Read one remote file (binary-safe) and put its bytes at a local path. The
 * bytes are written beside `localPath` and renamed over it, so the path never
 * names a half-written file: a reader gets the earlier copy or the new one, and
 * a failed download leaves the earlier copy as it was.
 */
async function downloadRemoteFileTo(
	remotePath: string,
	localPath: string,
	sshConfig: SshRemoteConfig
): Promise<Buffer> {
	const bytes = await readRemoteFileBytes(remotePath, sshConfig);
	await placeLocalFile(localPath, bytes);
	return bytes;
}

/**
 * Put `bytes` at a local path through a sibling and a rename, so the path never
 * names a half-written file, and a failed write leaves the earlier file as it was.
 */
async function placeLocalFile(localPath: string, bytes: Buffer): Promise<void> {
	const staged = stagingPathFor(localPath);
	try {
		await fs.writeFile(staged, bytes);
		await fs.rename(staged, localPath);
	} catch (error) {
		try {
			await fs.rm(staged, { force: true });
		} catch {
			// The download's own failure is the one to report.
		}
		throw error;
	}
}

/** The most files one folder download fetches; a bigger folder is refused, never cut short. */
export const REMOTE_FOLDER_DOWNLOAD_MAX_FILES = 2000;
/** The deepest a folder download walks (the tree listing's own default is 5). */
export const REMOTE_FOLDER_DOWNLOAD_MAX_DEPTH = 64;
/**
 * The most bytes one folder download fetches in all. Each file is read whole into memory, so a
 * bigger tree is refused (with its size) rather than copied; the callers fall back (a remote page
 * opens alone, a drag-out says why).
 */
export const REMOTE_FOLDER_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;
/** The largest one file in a folder download may be (it is read whole, and four run at once). */
export const REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Why a folder of `total` bytes (`atLeast`: a lower bound) is refused, or `null` when it fits. */
export function remoteFolderTooLarge(
	total: number,
	largest: { name: string; size: number } | null,
	atLeast = false
): string | null {
	const size = `${atLeast ? 'at least ' : ''}${formatSize(total)}`;
	if (largest && largest.size > REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES) {
		return (
			`The folder is too large to copy to this computer (${size}): ` +
			`${largest.name.slice(0, 200)} alone is ${formatSize(largest.size)}, over the ` +
			`${formatSize(REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES)} limit for one file`
		);
	}
	if (total > REMOTE_FOLDER_DOWNLOAD_MAX_BYTES) {
		return (
			`The folder is too large to copy to this computer (${size}; ` +
			`the limit is ${formatSize(REMOTE_FOLDER_DOWNLOAD_MAX_BYTES)})`
		);
	}
	return null;
}

/** Parallel SSH reads while downloading a folder. */
const REMOTE_FOLDER_DOWNLOAD_CONCURRENCY = 4;

/**
 * Put a finished folder at `dest`, replacing the copy there. Two renames, not a recursive delete
 * and a rename: the earlier copy moves aside whole and the new one takes its name, so a reader of
 * `dest` (a drag from another window) never meets a half-deleted folder, and a failed second
 * rename puts the earlier copy back. The earlier copy is deleted only once the new one is in place.
 */
export async function swapInFolder(staged: string, dest: string): Promise<void> {
	const retired = stagingPathFor(dest);
	let hadEarlier = false;
	try {
		await fs.rename(dest, retired);
		hadEarlier = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	try {
		await fs.rename(staged, dest);
	} catch (error) {
		if (hadEarlier) {
			try {
				await fs.rename(retired, dest);
			} catch (restoreError) {
				void captureException(restoreError, { action: 'remote-folder-copy.restore', dest });
			}
		}
		throw error;
	}
	if (hadEarlier) {
		try {
			await fs.rm(retired, { recursive: true, force: true });
		} catch (error) {
			// The new copy is in place; a leftover in the temp folder is only clutter.
			logger.warn(
				`Could not remove an earlier folder copy: ${retired}`,
				'fs:downloadRemoteFolder',
				{
					error: error instanceof Error ? error.message : String(error),
				}
			);
		}
	}
}

/** One folder download per local folder at a time: two never build the same copy at once. */
const remoteFolderDownloads = createKeyedWriteQueue();

/**
 * Download a remote directory tree to a local directory - the mirror of
 * {@link uploadDirToRemote}. One SSH listing, then each file read binary-safe.
 * The tree is built in a folder beside `localDir` and swapped in only when
 * every file is there, so `localDir` never holds part of a copy: a failed
 * download leaves the earlier copy as it was. The swap replaces the earlier
 * copy whole, so a file deleted on the remote does not linger. Refuses (throws)
 * a tree larger than {@link REMOTE_FOLDER_DOWNLOAD_MAX_FILES} or as deep as
 * {@link REMOTE_FOLDER_DOWNLOAD_MAX_DEPTH} rather than handing back a partial
 * folder, a tree with a subfolder it cannot read (the strict listing names it),
 * and any listed path that would land outside `localDir`.
 */
async function downloadRemoteDirToLocal(
	remoteDir: string,
	localDir: string,
	sshConfig: SshRemoteConfig
): Promise<number> {
	const listed = await listTreeRemote(
		remoteDir,
		{
			maxDepth: REMOTE_FOLDER_DOWNLOAD_MAX_DEPTH,
			maxFiles: REMOTE_FOLDER_DOWNLOAD_MAX_FILES,
			// A subfolder the walk cannot read fails the copy, naming it, before any byte is
			// fetched: a copy that silently lacks a subfolder is a wrong copy.
			strict: true,
			// Sizes come with the listing, so a tree too large to copy is refused before any read.
			withSizes: true,
		},
		sshConfig
	);
	if (!listed.success) {
		throw new Error(listed.error || `Failed to list remote folder: ${remoteDir}`);
	}
	if (listed.data!.truncated) {
		throw new Error(
			`The folder has more than ${REMOTE_FOLDER_DOWNLOAD_MAX_FILES} files, too many to copy to this computer`
		);
	}
	// A listed path is read on the remote exactly as listed, and lands here
	// segment for segment. One this machine would read as some other path is
	// refused, never rewritten into a different name.
	const toSegments = (rel: string): string[] => {
		const segments = rel.split('/');
		if (!segments.every(isLocalPathSegment)) {
			throw new Error(`Refusing a remote path outside the folder: ${rel}`);
		}
		return segments;
	};
	const dirs = listed.data!.directories.map(toSegments);
	// The listing stops at the depth limit without saying so. A folder that
	// deep may hold entries the listing never saw.
	if (dirs.some((segments) => segments.length >= REMOTE_FOLDER_DOWNLOAD_MAX_DEPTH)) {
		throw new Error(
			`The folder is nested ${REMOTE_FOLDER_DOWNLOAD_MAX_DEPTH} folders deep or more, too deep to copy to this computer`
		);
	}
	const remoteRoot = remoteDir.replace(/\/+$/, '');
	const sizes = listed.data!.fileSizes ?? [];
	const files = listed.data!.files.map((rel, i) => ({
		remote: `${remoteRoot}/${rel}`,
		segments: toSegments(rel),
		rel,
		size: sizes[i] ?? null,
	}));
	// Checked from the listing before any byte is fetched, for every size the remote reported.
	let listedTotal = 0;
	let largest: { name: string; size: number } | null = null;
	for (const file of files) {
		if (file.size === null) continue;
		listedTotal += file.size;
		if (!largest || file.size > largest.size) largest = { name: file.rel, size: file.size };
	}
	const tooLarge = remoteFolderTooLarge(listedTotal, largest);
	if (tooLarge) throw new Error(tooLarge);

	const staging = stagingPathFor(localDir);
	try {
		await fs.mkdir(staging, { recursive: true });
		for (const segments of dirs) {
			await fs.mkdir(path.join(staging, ...segments), { recursive: true });
		}
		// The first failure stops the rest from starting, and the reads already
		// running settle before the staging folder is removed under them.
		const failures: unknown[] = [];
		// Every file is checked again once its bytes are here, the same rule: a size the listing
		// could not report counts now, and a file that grew since the listing counts at its real
		// size, so neither slips past the budget.
		let fetchedTotal = listedTotal;
		// With a size still unknown, the running total is a lower bound.
		const someSizeUnknown = files.some((file) => file.size === null);
		await mapWithConcurrency(files, REMOTE_FOLDER_DOWNLOAD_CONCURRENCY, async (file) => {
			if (failures.length > 0) return;
			try {
				const local = path.join(staging, ...file.segments);
				await fs.mkdir(path.dirname(local), { recursive: true });
				const bytes = await readRemoteFileBytes(file.remote, sshConfig);
				fetchedTotal += bytes.length - (file.size ?? 0);
				const over = remoteFolderTooLarge(
					fetchedTotal,
					{ name: file.rel, size: bytes.length },
					someSizeUnknown
				);
				if (over) throw new Error(over);
				await fs.writeFile(local, bytes);
			} catch (error) {
				failures.push(error);
			}
		});
		if (failures.length > 0) throw failures[0];
		await swapInFolder(staging, localDir);
	} catch (error) {
		try {
			await fs.rm(staging, { recursive: true, force: true });
		} catch {
			// The download's own failure is the one to report.
		}
		throw error;
	}
	return files.length;
}

/**
 * Supported image file extensions for base64 encoding
 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];

/** Directory-size result shape shared by the local and SSH branches. */
interface DirectorySizeResult {
	totalSize: number;
	fileCount: number;
	folderCount: number;
}

/**
 * How long a settled `fs:directorySize` answer stays reusable.
 *
 * Deliberately short. This backs the Files panel footer ("N files, M folders,
 * 1.2 GB"), so a stale value is invisible for a moment and correct again on the
 * next refresh - whereas recomputing it for every caller in a refresh cycle
 * costs a full recursive stat of the working directory each time. The window
 * only has to outlive one burst of callers, not act as a real cache.
 */
const DIRECTORY_SIZE_CACHE_MS = 2_000;

/** How deep the Files panel's size walk goes: entries up to 10 levels below the root, in every mode. */
const DIRECTORY_SIZE_MAX_DEPTH = 10;

/**
 * Request budget for fs:fetchImageAsBase64. The renderer blocks a preview on
 * this, and the SSRF guard above only vets the host: a permitted host that
 * accepts the connection and then stalls would hang the handler forever.
 */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

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
/**
 * Pick a free `.zip` path for `basePath` (an extension-less path).
 *
 * Tries `<base>.zip` first, then `<base>-1.zip`, `<base>-2.zip`, ... until the
 * probe reports a free name. `exists` is injected so the same walk serves both
 * the local disk and an SSH remote.
 */
async function resolveUniqueZipPath(
	basePath: string,
	exists: (candidate: string) => Promise<boolean>
): Promise<string> {
	let candidate = `${basePath}.zip`;
	let suffix = 0;
	// Bounded so a filesystem that reports every name as taken (a permission
	// error surfacing as "exists", say) cannot spin forever.
	while (await exists(candidate)) {
		suffix++;
		if (suffix > 9999) {
			throw new Error(`Could not find an unused archive name for ${basePath}.zip`);
		}
		candidate = `${basePath}-${suffix}.zip`;
	}
	return candidate;
}

/** Outcome of one path in a `fs:deleteMany` batch. */
interface BulkDeleteResult {
	path: string;
	success: boolean;
	error?: string;
}

/**
 * Delete one local file or directory.
 *
 * Shared by `fs:delete` and `fs:deleteMany` so the two cannot drift on what
 * "delete" means. The `stat` is what decides between `rm` and `unlink`, and it
 * stays here rather than being folded into an unconditional `fs.rm(..., {
 * recursive })`: with `recursive: false` an explicit stat is what lets a
 * directory fail as a directory instead of surfacing as a bare `ERR_FS_EISDIR`.
 */
async function deleteLocalPath(targetPath: string, recursive: boolean): Promise<void> {
	const stat = await fs.stat(targetPath);
	if (stat.isDirectory()) {
		await fs.rm(targetPath, { recursive, force: true });
	} else {
		await fs.unlink(targetPath);
	}
}

/** The words for one write-back outcome, sent on the existing toast and flash channels. */
function announceWriteBack(
	safeSend: SafeSendFn | undefined,
	event: RemoteCopyWriteBackEvent
): void {
	if (!safeSend) return;
	const name = path.posix.basename(event.remotePath);
	if (event.kind === 'saved') {
		safeSend('remote:notifyCenterFlash', {
			message: 'Saved to the remote host',
			detail: name,
			color: 'green',
			duration: 2000,
		});
		return;
	}
	if (event.kind === 'unwatched') {
		safeSend('remote:notifyToast', {
			title: 'No longer saving to the remote host',
			message: `Maestro can no longer watch the copy of ${name} on this computer, so changes you save to it from now on stay here. Open the file again to start saving back.`,
			color: 'yellow',
			dismissible: true,
		});
		return;
	}
	if (event.kind === 'kept') {
		safeSend('remote:notifyToast', {
			title: 'Your change was kept',
			message: `${name} was opened again, so the copy now holds the remote file. Your change, which was not saved there, is kept at ${event.keptAt}.`,
			color: 'yellow',
			dismissible: true,
		});
		return;
	}
	safeSend('remote:notifyToast', {
		title:
			event.kind === 'conflict' ? 'Not saved to the remote host' : 'Save to the remote host failed',
		message:
			event.kind === 'conflict'
				? `${name} changed on the remote host since it was opened, so your change was not written there. Your version is kept at ${event.keptAt}. Later changes to this copy are not saved back: open the file again to start from the remote version.`
				: `${name}: ${event.message}. Your change is still in the copy on this computer.`,
		color: 'red',
		dismissible: true,
	});
}

function sshConfigOrThrow(sshRemoteId: string): SshRemoteConfig {
	const sshConfig = getSshRemoteById(sshRemoteId);
	if (!sshConfig) throw new Error(`SSH remote not found: ${sshRemoteId}`);
	return sshConfig;
}

/**
 * The write-back for remote copies opened in another app (`fs:watchRemoteCopy`).
 * Its watchers do not keep the app alive, and each watches one file.
 */
function createFilesystemWriteBack(safeSend: SafeSendFn | undefined): RemoteCopyWriteBack {
	return createRemoteCopyWriteBack({
		watchFile: (localPath, onChange, onError) => {
			const watcher = chokidar.watch(localPath, {
				ignoreInitial: true,
				persistent: false,
				// An app that saves by writing a sibling and renaming it over the file
				// still reads as one change to this path.
				atomic: true,
				awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
			});
			watcher.on('add', onChange);
			watcher.on('change', onChange);
			watcher.on('error', (error) => {
				logger.warn('Remote copy watcher failed', 'fs:watchRemoteCopy', {
					localPath,
					error: String(error),
				});
				onError(error);
			});
			return { close: () => watcher.close() };
		},
		statLocal: async (localPath) => {
			try {
				const stat = await fs.stat(localPath);
				return { size: stat.size, mtimeMs: stat.mtimeMs };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
				throw error;
			}
		},
		readLocal: (localPath) => fs.readFile(localPath),
		// `wx`: a kept version never replaces an earlier one.
		createLocal: (localPath, bytes) => fs.writeFile(localPath, bytes, { flag: 'wx' }),
		hashRemote: async (remotePath, sshRemoteId) => {
			const result = await sha256FileRemote(remotePath, sshConfigOrThrow(sshRemoteId));
			if (!result.success) throw new Error(result.error || 'The remote file could not be read');
			return result.data ?? null;
		},
		writeRemote: async (remotePath, bytes, sshRemoteId, expectedSha256) => {
			const result = await replaceFileRemoteIfUnchanged(
				remotePath,
				bytes,
				expectedSha256,
				sshConfigOrThrow(sshRemoteId)
			);
			if (result.success) return 'written';
			if (result.changed) return 'changed';
			throw new Error(result.error || 'The remote write failed');
		},
		notify: (event) => announceWriteBack(safeSend, event),
	});
}

let remoteCopyWriteBack: RemoteCopyWriteBack | null = null;

/**
 * On quit: send every opened remote copy's change not sent yet, then stop the
 * watches. Resolves when those writes are done; the quit path bounds the wait.
 */
export function flushRemoteCopyWriteBack(): Promise<void> {
	return remoteCopyWriteBack?.dispose() ?? Promise.resolve();
}

export interface FilesystemHandlerDependencies {
	/** Broadcast to the renderers: the write-back of a remote copy reports through it. */
	safeSend?: SafeSendFn;
}

export function registerFilesystemHandlers(deps: FilesystemHandlerDependencies = {}): void {
	void remoteCopyWriteBack?.dispose();
	remoteCopyWriteBack = createFilesystemWriteBack(deps.safeSend);
	const writeBack = remoteCopyWriteBack;

	// Get user home directory
	ipcMain.handle('fs:homeDir', () => {
		return os.homedir();
	});
	ipcMain.handle('fs:directoryInfo', (_event, input?: string) => getHostDirectoryInfo(input));

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

	// Walk a local directory tree in one round-trip.
	//
	// The renderer's own recursive walk needs an `fs:readDir` round-trip per
	// directory, so a large tree costs hundreds of them and each one waits its
	// turn on a renderer main thread that may be busy rendering a streaming
	// transcript. Doing the walk here keeps it at the ~100ms of real filesystem
	// work it always was. SSH trees have their own batched loader.
	ipcMain.handle(
		'fs:readDirTree',
		async (
			_,
			dirPath: string,
			options: {
				maxDepth: number;
				maxEntries?: number;
				ignorePatterns?: string[];
				honorGitignore?: boolean;
				expandedPaths?: string[];
			}
		) => walkLocalFileTree(dirPath, options)
	);

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
				// Parquet is binary, columnar, and routinely larger than RAM.
				// Reading it as text would corrupt it and blow up the IPC
				// payload for a file the viewer only ever reads a window of, so
				// hand back a marker and let the ParquetViewer query it through
				// the `parquet:*` handlers instead. Applies to remote files too:
				// the parquet reader fetches those into a local cache itself.
				if (isParquetFile(filePath)) {
					return buildParquetPreviewMarker(filePath);
				}

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
						return `data:${getImageMimeType(imgExt || '')};base64,${imgResult.data}`;
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

				// SQLite is binary, can be far larger than RAM, and may be a live
				// app database, so a proven one hands back a marker for the SQLite
				// viewer instead of its bytes. The extension only decides whether
				// to sniff; the 16-byte header decides (`.db` is not a format), and
				// a candidate that fails it falls through to the text read below,
				// which is the binary card it always got. Local only: remote
				// databases are out of scope, since a copied database is a stale
				// one. A vanished file throws ENOENT here and returns null below.
				if (await isSqliteDatabaseFile(filePath)) {
					return buildSqlitePreviewMarker(filePath);
				}

				// Local: use standard fs operations
				// Check if file is an image
				const ext = filePath.split('.').pop()?.toLowerCase();
				const isImage = IMAGE_EXTENSIONS.includes(ext || '');

				if (isImage) {
					// Read image as buffer and convert to base64 data URL
					const buffer = await fs.readFile(filePath);
					const base64 = buffer.toString('base64');
					return `data:${getImageMimeType(ext || '')};base64,${base64}`;
				} else if (isMediaFile(filePath)) {
					// Audio/video never gets inlined the way images do - a long
					// recording would blow up the IPC payload and pin the whole file
					// in the renderer heap for as long as the tab is open. Hand back a
					// stream URL instead; the <audio>/<video> element range-requests
					// the bytes over the maestro-media:// protocol. Remote files fall
					// through to the text read below and keep the existing binary
					// download path - there is no SSH-backed range server.
					//
					// Stat first so a missing file returns null like every other read
					// here. Minting the URL is pure string work, so without this a
					// deleted file handed back a perfectly valid URL, the protocol
					// 404'd, and the player blamed the codec for a file that was
					// simply gone.
					await fs.stat(filePath);
					return buildLocalMediaStreamUrl(filePath);
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
				// clicks an entry that resolved to a folder). Treat like ENOENT -
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
	// trees in 1-2 round-trips total instead of one per directory.
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

			if (localDestPath) {
				await downloadRemoteFileTo(remotePath, localDestPath, sshConfig);
				return { success: true, path: localDestPath };
			}
			const destPath = remoteDownloadTempPath(sshRemoteId, remotePath);
			// A copy opened in another app may hold a change the remote does not have
			// yet: it stays (the write is tried again), never replaced by a fetch. The
			// fetch runs in that copy's own queue, so no save of it interleaves.
			await writeBack.refetch(destPath, {
				download: () => readRemoteFileBytes(remotePath, sshConfig),
				place: async (bytes) => {
					await fs.mkdir(path.dirname(destPath), { recursive: true });
					await placeLocalFile(destPath, bytes);
				},
			});
			return { success: true, path: destPath };
		}
	);

	// Watch the copy `fs:downloadRemoteFile` fetched for a remote file (no
	// destination named), and write a change saved in another app back to the
	// remote file. The copy's path is derived here, never taken from the caller,
	// so only a fetched copy can be sent to the remote. Call it right after the
	// fetch: the copy's bytes now are what the remote held. A copy too large to
	// send back is not watched, and the answer says why, for the flash.
	ipcMain.handle(
		'fs:watchRemoteCopy',
		async (_, remotePath: string, sshRemoteId: string): Promise<RemoteCopyWatchResult> => {
			sshConfigOrThrow(sshRemoteId);
			const localPath = remoteDownloadTempPath(sshRemoteId, remotePath);
			try {
				await writeBack.watch({ localPath, remotePath, sshRemoteId });
			} catch (error) {
				if (!(error instanceof RemoteCopyTooLargeError)) throw error;
				return { path: localPath, savesBack: false, reason: error.message };
			}
			return { path: localPath, savesBack: true };
		}
	);

	// Download a remote SSH folder (its whole tree) to a temp folder on this
	// machine, for actions that must hand a real folder to the OS (the Files
	// panel's Option-drag out to Finder). Same temp layout as a single file.
	// Returns the local folder path and how many files it holds.
	ipcMain.handle('fs:downloadRemoteFolder', async (_, remotePath: string, sshRemoteId: string) => {
		const sshConfig = getSshRemoteById(sshRemoteId);
		if (!sshConfig) {
			throw new Error(`SSH remote not found: ${sshRemoteId}`);
		}
		const destPath = remoteDownloadTempPath(sshRemoteId, remotePath.replace(/\/+$/, ''));
		const fileCount = await remoteFolderDownloads.enqueue(destPath, () =>
			downloadRemoteDirToLocal(remotePath, destPath, sshConfig)
		);
		return { success: true, path: destPath, fileCount };
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

	// In-flight and just-settled directory-size walks, keyed by request. Scoped to
	// the registration rather than the module so a re-registration starts clean.
	const directorySizeCache = new Map<
		string,
		{ startedAt: number; result: Promise<DirectorySizeResult> }
	>();

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
			// SSH remote: the same walk rule (patterns, .gitignore, depth) over SSH, so
			// one tree gives the same counts and size wherever the agent runs.
			const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
			if (sshRemoteId && !sshConfig) {
				throw new Error(`SSH remote not found: ${sshRemoteId}`);
			}

			// The Files panel asks for this from several places that all fire inside
			// one refresh cycle (tree load, git refresh, auto-refresh tick), and the
			// answer is a full recursive stat of the working directory - the single
			// most expensive thing the main process does on a large repo. Collapse
			// those into one walk: a request that arrives while a matching walk is
			// still running joins it, and the settled answer is reused for a beat
			// afterwards so the back-to-back callers do not each pay for it.
			const cacheKey = `${sshRemoteId ?? ''}\u0000${dirPath}\u0000${honorGitignore ? 1 : 0}\u0000${(
				ignorePatterns ?? LOCAL_IGNORE_DEFAULTS
			).join('\u0001')}`;
			const cached = directorySizeCache.get(cacheKey);
			if (cached && Date.now() - cached.startedAt < DIRECTORY_SIZE_CACHE_MS) {
				return cached.result;
			}

			const pending = sshConfig ? computeRemoteDirectorySize(sshConfig) : computeDirectorySize();
			const now = Date.now();
			// Prune while we are here so a long-lived session cannot accumulate one
			// entry per directory the user ever opened.
			for (const [key, entry] of directorySizeCache) {
				if (now - entry.startedAt >= DIRECTORY_SIZE_CACHE_MS) directorySizeCache.delete(key);
			}
			directorySizeCache.set(cacheKey, { startedAt: now, result: pending });
			// A failed walk must not be cached: the next caller should retry, not
			// inherit the rejection for the rest of the TTL.
			pending.catch(() => directorySizeCache.delete(cacheKey));
			return pending;

			/**
			 * The local walk's rule on an SSH remote, in one round trip: the same
			 * patterns (with the root's .gitignore read on the remote), the same
			 * depth, and every surviving file's size. `listTreeRemote()` prunes by
			 * `find -name`; each path is then checked with `shouldIgnore()` too, the
			 * check the local walk makes, so a case the remote `find` does not fold
			 * is dropped as it is here.
			 */
			async function computeRemoteDirectorySize(
				remote: SshRemoteConfig
			): Promise<DirectorySizeResult> {
				let effectivePatterns = ignorePatterns ?? LOCAL_IGNORE_DEFAULTS;
				if (honorGitignore) {
					const gitignore = await readFileRemote(path.posix.join(dirPath, '.gitignore'), remote);
					if (gitignore.success && gitignore.data) {
						effectivePatterns = [...effectivePatterns, ...parseGitignoreContent(gitignore.data)];
					}
				}
				const listed = await listTreeRemote(
					dirPath,
					{
						maxDepth: DIRECTORY_SIZE_MAX_DEPTH,
						ignorePatterns: effectivePatterns,
						withSizes: true,
					},
					remote
				);
				if (!listed.success || !listed.data) {
					throw new Error(listed.error || 'Failed to get remote directory size');
				}
				const kept = (relative: string) =>
					!relative.split('/').some((name) => shouldIgnore(name, effectivePatterns));
				const { directories, files, fileSizes } = listed.data;
				let totalSize = 0;
				let fileCount = 0;
				files.forEach((file, index) => {
					if (!kept(file)) return;
					fileCount++;
					totalSize += fileSizes?.[index] ?? 0;
				});
				return { totalSize, fileCount, folderCount: directories.filter(kept).length };
			}

			async function computeDirectorySize(): Promise<DirectorySizeResult> {
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
						// .gitignore may not exist or be readable - not an error
					}
				}

				// Local: use standard fs operations
				let totalSize = 0;
				let fileCount = 0;
				let folderCount = 0;

				const calculateSize = async (currentPath: string, depth: number = 0): Promise<void> => {
					// Limit recursion depth to match file tree loading
					if (depth >= DIRECTORY_SIZE_MAX_DEPTH) return;

					try {
						const entries = await fs.readdir(currentPath, { withFileTypes: true });

						// Child paths by concatenation, not `path.join`. join() re-normalizes
						// the whole string every call, and a field trace attributed ~625ms of
						// main-process CPU in one 58-second window to this loop's joins alone.
						// `currentPath` is already a real path and a dirent name cannot
						// contain a separator, so the only thing join was fixing was the
						// trailing-separator seam - handled once per directory here.
						const childPrefix = currentPath.endsWith(path.sep)
							? currentPath
							: currentPath + path.sep;

						// Files are stat'd as a batch AFTER the directory listing rather than
						// one-at-a-time inside it. Awaiting each stat in turn leaves libuv's
						// threadpool idle between calls, which is why the same trace showed
						// 1.5s of main-thread time sitting in `stat` for a single walk.
						const filePaths: string[] = [];

						for (const entry of entries) {
							if (shouldIgnore(entry.name, effectivePatterns)) {
								continue;
							}

							// A symlink counts as its target, as the Files panel tree draws it
							// and as the remote walk (`find -L`) counts it; the depth bound
							// ends a link loop, as it does in the tree.
							const childPath = childPrefix + entry.name;
							const kind = entry.isSymbolicLink()
								? await resolveDirentType(entry, childPath)
								: { isDirectory: entry.isDirectory(), isFile: entry.isFile() };
							if (kind.isDirectory) {
								folderCount++;
								await calculateSize(childPath, depth + 1);
							} else if (kind.isFile) {
								fileCount++;
								filePaths.push(childPath);
							}
						}

						const sizes = await Promise.all(
							filePaths.map((filePath) =>
								// A file we cannot stat (permissions, a race with a delete)
								// contributes nothing rather than failing the whole walk.
								fs.stat(filePath).then(
									(stats) => stats.size,
									() => 0
								)
							)
						);
						for (const size of sizes) totalSize += size;
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

				await deleteLocalPath(targetPath, options?.recursive ?? true);
				return { success: true };
			} catch (error) {
				throw new Error(`Failed to delete: ${error}`);
			}
		}
	);

	// Delete a batch of files/folders in ONE IPC call (supports SSH remote).
	//
	// The renderer used to loop `fs:delete` per path, which serialized a full
	// round trip - plus a `stat` and the SSH handshake - behind every single
	// file. On a slow volume or a remote host that per-file latency is the whole
	// cost, and a 125-file multi-select took over 30 seconds (issue #1423).
	//
	// Unlike `fs:delete` this RESOLVES with a per-path outcome instead of
	// throwing on the first failure: a partial delete is the normal case for a
	// bulk operation (one locked or permission-denied file among many), and the
	// caller needs to know which paths survived so it can report and attribute
	// them rather than losing the whole batch to one bad entry.
	ipcMain.handle(
		'fs:deleteMany',
		async (
			_,
			targetPaths: string[],
			options?: { recursive?: boolean; sshRemoteId?: string }
		): Promise<{ results: BulkDeleteResult[] }> => {
			if (!Array.isArray(targetPaths) || targetPaths.length === 0) {
				return { results: [] };
			}

			const recursive = options?.recursive ?? true;
			const sshRemoteId = options?.sshRemoteId;

			// SSH remote: one `rm` for the whole batch rather than one per path.
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					// An unresolvable remote is a configuration failure, not a
					// per-path one - fail the call rather than reporting 125
					// identical path errors.
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				const remoteResults = await deleteManyRemote(targetPaths, sshConfig, recursive);
				return {
					results: remoteResults.map((result, index) => ({
						path: targetPaths[index],
						success: result.success,
						...(result.success ? {} : { error: result.error || 'Failed to delete remote file' }),
					})),
				};
			}

			// Local: overlap the deletes so per-file latency stops being additive.
			const results = await mapWithConcurrency(
				targetPaths,
				LOCAL_FILE_DELETE_CONCURRENCY,
				async (targetPath): Promise<BulkDeleteResult> => {
					try {
						await deleteLocalPath(targetPath, recursive);
						return { path: targetPath, success: true };
					} catch (error) {
						return {
							path: targetPath,
							success: false,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				}
			);

			return { results };
		}
	);

	// Compress a folder into a .zip sitting beside it in the parent directory.
	// The archive is named after the folder; when that name is taken the next
	// free `-N` suffix is used, so repeated compressions never clobber an
	// existing archive.
	ipcMain.handle(
		'fs:compressFolder',
		async (_, folderPath: string, options?: { sshRemoteId?: string }) => {
			const sshRemoteId = options?.sshRemoteId;
			const folderName = path.basename(folderPath.replace(/[\\/]+$/, ''));
			const parentDir = path.dirname(folderPath.replace(/[\\/]+$/, ''));

			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				// Remote paths are POSIX regardless of what the desktop runs on, so
				// join with '/' rather than path.join (which uses '\\' on Windows).
				const destPath = await resolveUniqueZipPath(
					`${parentDir.replace(/\\/g, '/')}/${folderName}`,
					async (candidate) => {
						const result = await existsRemote(candidate, sshConfig);
						if (!result.success) {
							throw new Error(result.error || 'Failed to check remote path');
						}
						return result.data === true;
					}
				);
				const result = await compressFolderRemote(folderPath, destPath, sshConfig);
				if (!result.success) {
					throw new Error(result.error || 'Failed to compress remote folder');
				}
				return { success: true, path: destPath, name: path.posix.basename(destPath) };
			}

			const destPath = await resolveUniqueZipPath(
				path.join(parentDir, folderName),
				async (candidate) => existsSync(candidate)
			);

			await new Promise<void>((resolve, reject) => {
				const output = createWriteStream(destPath);
				const archive = archiver('zip', { zlib: { level: 9 } });
				output.on('close', () => resolve());
				output.on('error', reject);
				archive.on('error', reject);
				archive.pipe(output);
				// Nest everything under the folder's own name so unzipping produces a
				// single folder rather than spraying its contents into the cwd.
				archive.directory(folderPath, folderName);
				void archive.finalize();
			});

			return { success: true, path: destPath, name: path.basename(destPath) };
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

			const response = await fetchWithTimeout(url, {}, IMAGE_FETCH_TIMEOUT_MS);
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
