/**
 * Shared History Manager for cross-host history synchronization.
 *
 * Writes per-hostname JSONL files to <project>/.maestro/history/ so that
 * multiple Maestro instances (local or SSH-remote) can share history visibility.
 * The file format and the local reads and writes live in
 * `src/shared/maestro-lib/store/shared-history.ts`, which a headless
 * `maestro-cli host` uses too; this module adds the SSH half, the cache, and
 * the logging and Sentry policy.
 *
 * Each Maestro instance writes to its own file (history-<hostname>.jsonl) and
 * reads from all other files when loading history. This avoids write conflicts
 * entirely - each hostname owns its file exclusively.
 *
 * File format: one JSON object per line (JSONL), append-only.
 */

import * as os from 'os';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';
import { SHARED_HISTORY_DIR } from '../shared/maestro-paths';
import {
	appendSharedHistoryEntry,
	listSharedHistoryFiles,
	parseSharedHistoryJsonl,
	readSharedHistoryEntries,
	rotateSharedHistoryFile,
	sharedHistoryFilename,
	sharedHistoryLabelOf,
} from '../shared/maestro-lib/store/shared-history';
import { MAX_ENTRIES_PER_SESSION } from '../shared/history';
import type { HistoryEntry, SshRemoteConfig } from '../shared/types';
import {
	readFileRemote,
	writeFileRemote,
	mkdirRemote,
	listDirWithStatsRemote,
} from './utils/remote-fs';

const LOG_CONTEXT = '[SharedHistory]';

/** Cached hostname - resolved once per process */
const LOCAL_HOSTNAME = os.hostname();

/**
 * Node fs error codes we expect from a best-effort write into a user-chosen
 * project directory. The location may be permission-restricted (read-only
 * Dropbox / CloudStorage team folders), read-only, or simply not exist. These
 * are environmental, never a Maestro bug, so we keep the local warn but skip
 * Sentry to avoid telemetry noise (MAESTRO-FM).
 */
const EXPECTED_FS_ERROR_CODES = new Set([
	'EACCES',
	'EPERM',
	'EROFS',
	'ENOENT',
	'ENOTDIR',
	'ENOSPC',
]);

function isExpectedFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' && EXPECTED_FS_ERROR_CODES.has(code);
}

/**
 * Per-file cache of parsed shared-history entries keyed by `(host, dir, filename)`.
 *
 * SSH-shared history reads were dominated by re-fetching every JSONL file on
 * every navigation: each panel mount fired a fresh `readRemoteEntriesSsh()`
 * which spawned one SSH call to list the directory plus N more to `cat` each
 * file in full. With this cache, navigation back to an SSH-backed agent costs
 * exactly one bulk-stat SSH call (`listDirWithStatsRemote`), and the file
 * reads are skipped for any file whose `(size, mtime)` matches the prior
 * fetch. Appends and rewrites both change either size or mtime, so genuine
 * updates are picked up on the next call without manual invalidation.
 *
 * The local fs path is fast enough not to need this, but uses the same map
 * for symmetry / readability.
 */
interface CachedSharedFile {
	size: number;
	mtime: number;
	entries: HistoryEntry[];
}
const sharedFileCache = new Map<string, CachedSharedFile>();

function sharedCacheKey(scope: string, dir: string, filename: string): string {
	return `${scope}|${dir}|${filename}`;
}

function sshScopeKey(sshRemote: SshRemoteConfig): string {
	const user = sshRemote.username?.trim() || '';
	return `ssh:${user}@${sshRemote.host}:${sshRemote.port}`;
}

/** Test-only: clear the shared-history file cache between cases. */
export function __resetSharedHistoryCacheForTest(): void {
	sharedFileCache.clear();
}

/** Every other host's entries in one shared file's text, with a warning for lines that did not parse. */
function parseJsonl(content: string, sourceHostname: string): HistoryEntry[] {
	const { entries, malformedLines } = parseSharedHistoryJsonl(content, sourceHostname);
	if (malformedLines > 0) {
		logger.warn(
			`Skipped ${malformedLines} malformed JSONL line(s) from ${sourceHostname}`,
			LOG_CONTEXT
		);
	}
	return entries;
}

// ─── Local filesystem operations ────────────────────────────────────────────

/**
 * Append a history entry to the local shared history file.
 *
 * @param projectPath - Absolute path to the project root
 * @param entry - The history entry to write
 * @param maxEntries - Max entries to retain per file (for rotation)
 */
export function writeEntryLocal(
	projectPath: string,
	entry: HistoryEntry,
	maxEntries: number = MAX_ENTRIES_PER_SESSION
): void {
	let filePath: string;
	try {
		filePath = appendSharedHistoryEntry(projectPath, LOCAL_HOSTNAME, {
			...entry,
			hostname: LOCAL_HOSTNAME,
		});
		logger.debug(`Wrote shared history entry to ${filePath}`, LOG_CONTEXT);
	} catch (error) {
		logger.warn(`Failed to write local shared history: ${error}`, LOG_CONTEXT);
		// Best-effort cross-host sync write - the primary history store is
		// unaffected when this fails. Don't report expected filesystem errors
		// (permission-denied / missing-path on a user-chosen project dir) to
		// Sentry; only surface genuinely unexpected failures (MAESTRO-FM).
		if (!isExpectedFsError(error)) {
			captureException(error, { operation: 'sharedHistory:writeLocal', projectPath });
		}
		return;
	}
	rotateLocalFile(filePath, maxEntries);
}

/**
 * Cheap probe: does this project's local `.maestro/history/` directory
 * contain any JSONL files from hosts OTHER than the running machine?
 * Used by the history IPC handler to decide whether to bypass the
 * bucket-aggregate cache (the cache only fingerprints the per-session
 * file, so merged shared entries would otherwise be invisible to it).
 */
export function hasLocalSharedHistory(projectPath: string): boolean {
	try {
		return listSharedHistoryFiles(projectPath, LOCAL_HOSTNAME).length > 0;
	} catch {
		return false;
	}
}

/**
 * Read entries from all other hosts' JSONL files in the local project directory.
 * Excludes the local hostname's file (those entries come from the local store).
 *
 * @param projectPath - Absolute path to the project root
 * @param maxEntries - Max entries to read per file
 */
export function readRemoteEntriesLocal(
	projectPath: string,
	maxEntries: number = MAX_ENTRIES_PER_SESSION
): HistoryEntry[] {
	try {
		return readSharedHistoryEntries(projectPath, {
			excludeLabel: LOCAL_HOSTNAME,
			maxEntriesPerFile: maxEntries,
			onFileError: (file, error) => {
				void captureException(error);
				logger.warn(`Failed to read shared history file ${file}: ${error}`, LOG_CONTEXT);
			},
			onMalformedLines: (file, count) =>
				logger.warn(`Skipped ${count} malformed JSONL line(s) from ${file}`, LOG_CONTEXT),
		});
	} catch (error) {
		void captureException(error);
		logger.warn(`Failed to list shared history directory: ${error}`, LOG_CONTEXT);
		return [];
	}
}

// ─── SSH remote operations ──────────────────────────────────────────────────

/**
 * Append a history entry to the remote shared history file via SSH.
 * Fire-and-forget: failures are logged but never block the caller.
 *
 * @param remoteCwd - Working directory on the remote host
 * @param entry - The history entry to write
 * @param sshRemote - SSH remote configuration
 */
export async function writeEntryRemote(
	remoteCwd: string,
	entry: HistoryEntry,
	sshRemote: SshRemoteConfig
): Promise<void> {
	try {
		const remoteDir = `${remoteCwd}/${SHARED_HISTORY_DIR}`;

		// Ensure directory exists
		await mkdirRemote(remoteDir, sshRemote);

		const remotePath = `${remoteDir}/${sharedHistoryFilename(LOCAL_HOSTNAME)}`;
		const line = JSON.stringify({ ...entry, hostname: LOCAL_HOSTNAME }) + '\n';

		// Read existing content, append, and write back
		// (writeFileRemote overwrites, so we need to read first for append semantics)
		const existing = await readFileRemote(remotePath, sshRemote);
		const content = existing.success && existing.data ? existing.data + line : line;

		const result = await writeFileRemote(remotePath, content, sshRemote);
		if (!result.success) {
			logger.warn(`Failed to write remote shared history: ${result.error}`, LOG_CONTEXT);
		} else {
			logger.debug(`Wrote shared history entry to remote: ${remotePath}`, LOG_CONTEXT);
		}
	} catch (error) {
		logger.warn(`Failed to write remote shared history: ${error}`, LOG_CONTEXT);
		captureException(error, { operation: 'sharedHistory:writeRemote', remoteCwd });
	}
}

/**
 * Read entries from all other hosts' JSONL files on a remote host via SSH.
 * Excludes the local hostname's file.
 *
 * @param remoteCwd - Working directory on the remote host
 * @param sshRemote - SSH remote configuration
 * @param maxEntries - Max entries to read per file
 */
export async function readRemoteEntriesSsh(
	remoteCwd: string,
	sshRemote: SshRemoteConfig,
	maxEntries: number = MAX_ENTRIES_PER_SESSION
): Promise<HistoryEntry[]> {
	try {
		const remoteDir = `${remoteCwd}/${SHARED_HISTORY_DIR}`;

		// One SSH round-trip: list every *.jsonl in the dir with size + mtime.
		// `listDirWithStatsRemote` returns regular files only (skipping subdirs
		// and symlinks), so we don't need a separate isDirectory filter.
		const statsResult = await listDirWithStatsRemote(remoteDir, sshRemote, {
			nameSuffix: '.jsonl',
		});
		if (!statsResult.success || !statsResult.data) {
			// Directory doesn't exist yet - no shared history
			return [];
		}

		const ownFilename = sharedHistoryFilename(LOCAL_HOSTNAME);
		const historyFiles = statsResult.data.filter(
			(entry) => sharedHistoryLabelOf(entry.name) !== null && entry.name !== ownFilename
		);

		const scope = sshScopeKey(sshRemote);
		const allEntries: HistoryEntry[] = [];

		for (const file of historyFiles) {
			const cacheKey = sharedCacheKey(scope, remoteDir, file.name);
			const cached = sharedFileCache.get(cacheKey);

			let entries: HistoryEntry[];
			if (cached && cached.size === file.size && cached.mtime === file.mtime) {
				entries = cached.entries;
			} else {
				try {
					const fileResult = await readFileRemote(`${remoteDir}/${file.name}`, sshRemote);
					if (!fileResult.success || fileResult.data === undefined) {
						continue;
					}
					entries = parseJsonl(fileResult.data, sharedHistoryLabelOf(file.name) ?? file.name);
					sharedFileCache.set(cacheKey, {
						size: file.size,
						mtime: file.mtime,
						entries,
					});
				} catch (error) {
					void captureException(error);
					logger.warn(
						`Failed to read remote shared history file ${file.name}: ${error}`,
						LOG_CONTEXT
					);
					continue;
				}
			}

			const trimmed =
				entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
			allEntries.push(...trimmed);
		}

		return allEntries;
	} catch (error) {
		void captureException(error);
		logger.warn(`Failed to read remote shared history: ${error}`, LOG_CONTEXT);
		return [];
	}
}

// ─── File rotation ──────────────────────────────────────────────────────────

/**
 * Rotate a local JSONL file by keeping only the most recent N entries.
 * Only triggers when the file exceeds the limit.
 */
function rotateLocalFile(filePath: string, maxEntries: number): void {
	try {
		if (rotateSharedHistoryFile(filePath, maxEntries)) {
			logger.debug(`Rotated shared history file to ${maxEntries} entries`, LOG_CONTEXT);
		}
	} catch (error) {
		void captureException(error);
		logger.warn(`Failed to rotate shared history file: ${error}`, LOG_CONTEXT);
	}
}

/**
 * Get the local hostname used for shared history file naming.
 */
export function getLocalHostname(): string {
	return LOCAL_HOSTNAME;
}
