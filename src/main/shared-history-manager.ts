/**
 * Shared History Manager for cross-host history synchronization.
 *
 * Writes per-hostname JSONL files to <project>/.maestro/history/ so that
 * multiple Maestro instances (local or SSH-remote) can share history visibility.
 *
 * Each Maestro instance writes to its own file (history-<hostname>.jsonl) and
 * reads from all other files when loading history. This avoids write conflicts
 * entirely — each hostname owns its file exclusively.
 *
 * File format: one JSON object per line (JSONL), append-only.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';
import { SHARED_HISTORY_DIR } from '../shared/maestro-paths';
import { MAX_ENTRIES_PER_SESSION } from '../shared/history';
import type { HistoryEntry, SshRemoteConfig } from '../shared/types';
import { readFileRemote, writeFileRemote, readDirRemote, mkdirRemote } from './utils/remote-fs';

const LOG_CONTEXT = '[SharedHistory]';

/** Cached hostname — resolved once per process */
const LOCAL_HOSTNAME = os.hostname();

/**
 * Build the JSONL filename for a given hostname.
 */
function historyFilename(hostname: string): string {
	// Sanitize hostname for filesystem safety
	const safe = hostname.replace(/[^a-zA-Z0-9._-]/g, '_');
	return `history-${safe}.jsonl`;
}

/**
 * Parse a JSONL string into HistoryEntry objects.
 * Skips malformed lines with a warning instead of failing entirely.
 */
function parseJsonl(content: string, sourceHostname: string): HistoryEntry[] {
	const entries: HistoryEntry[] = [];
	const lines = content.split('\n');

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		try {
			const entry = JSON.parse(trimmed) as HistoryEntry;
			// Ensure hostname is set (backfill from filename if missing)
			if (!entry.hostname) {
				entry.hostname = sourceHostname;
			}
			entries.push(entry);
		} catch {
			logger.warn(`Skipping malformed JSONL line from ${sourceHostname}`, LOG_CONTEXT);
		}
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
	try {
		const dir = path.join(projectPath, SHARED_HISTORY_DIR);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		const filePath = path.join(dir, historyFilename(LOCAL_HOSTNAME));
		const line = JSON.stringify({ ...entry, hostname: LOCAL_HOSTNAME }) + '\n';

		fs.appendFileSync(filePath, line, 'utf-8');

		// Rotate if over limit
		rotateLocalFile(filePath, maxEntries);

		logger.debug(`Wrote shared history entry to ${filePath}`, LOG_CONTEXT);
	} catch (error) {
		logger.warn(`Failed to write local shared history: ${error}`, LOG_CONTEXT);
		captureException(error, { operation: 'sharedHistory:writeLocal', projectPath });
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
	const dir = path.join(projectPath, SHARED_HISTORY_DIR);
	if (!fs.existsSync(dir)) {
		return [];
	}

	const allEntries: HistoryEntry[] = [];
	const ownFilename = historyFilename(LOCAL_HOSTNAME);

	try {
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.startsWith('history-') && f.endsWith('.jsonl') && f !== ownFilename);

		for (const file of files) {
			try {
				const content = fs.readFileSync(path.join(dir, file), 'utf-8');
				// Extract hostname from filename: history-<hostname>.jsonl
				const hostname = file.replace(/^history-/, '').replace(/\.jsonl$/, '');
				const entries = parseJsonl(content, hostname);
				// Take only the last N entries (most recent = end of file in JSONL)
				const trimmed =
					entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
				allEntries.push(...trimmed);
			} catch (error) {
				logger.warn(`Failed to read shared history file ${file}: ${error}`, LOG_CONTEXT);
			}
		}
	} catch (error) {
		logger.warn(`Failed to list shared history directory: ${error}`, LOG_CONTEXT);
	}

	return allEntries;
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

		const remotePath = `${remoteDir}/${historyFilename(LOCAL_HOSTNAME)}`;
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
		const dirResult = await readDirRemote(remoteDir, sshRemote);

		if (!dirResult.success || !dirResult.data) {
			// Directory doesn't exist yet — no shared history
			return [];
		}

		const ownFilename = historyFilename(LOCAL_HOSTNAME);
		const historyFiles = dirResult.data.filter(
			(entry) =>
				entry.name.startsWith('history-') &&
				entry.name.endsWith('.jsonl') &&
				!entry.isDirectory &&
				entry.name !== ownFilename
		);

		const allEntries: HistoryEntry[] = [];

		for (const file of historyFiles) {
			try {
				const fileResult = await readFileRemote(`${remoteDir}/${file.name}`, sshRemote);
				if (fileResult.success && fileResult.data) {
					const hostname = file.name.replace(/^history-/, '').replace(/\.jsonl$/, '');
					const entries = parseJsonl(fileResult.data, hostname);
					const trimmed =
						entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
					allEntries.push(...trimmed);
				}
			} catch (error) {
				logger.warn(
					`Failed to read remote shared history file ${file.name}: ${error}`,
					LOG_CONTEXT
				);
			}
		}

		return allEntries;
	} catch (error) {
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
		const content = fs.readFileSync(filePath, 'utf-8');
		const lines = content.split('\n').filter((l) => l.trim());

		if (lines.length <= maxEntries) return;

		// Keep the most recent entries (end of file = most recent)
		const trimmed = lines.slice(lines.length - maxEntries);
		fs.writeFileSync(filePath, trimmed.join('\n') + '\n', 'utf-8');

		logger.debug(
			`Rotated shared history file: ${lines.length} -> ${trimmed.length} entries`,
			LOG_CONTEXT
		);
	} catch (error) {
		logger.warn(`Failed to rotate shared history file: ${error}`, LOG_CONTEXT);
	}
}

/**
 * Get the local hostname used for shared history file naming.
 */
export function getLocalHostname(): string {
	return LOCAL_HOSTNAME;
}
