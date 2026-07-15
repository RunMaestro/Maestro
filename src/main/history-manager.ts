/**
 * History Manager for per-session history storage
 *
 * Migrates from a single global `maestro-history.json` file to per-session
 * history files stored in a dedicated `history/` subdirectory.
 *
 * Benefits:
 * - Higher limits: 5,000 entries per session (up from 1,000 global)
 * - Context passing: History files can be passed directly to AI agents
 * - Better isolation: Sessions don't pollute each other's history
 * - Simpler queries: No filtering needed when reading a session's history
 *
 * I/O is async (fs/promises) so reads/writes don't block the main process's
 * IPC and event loops. The cold-start migration path uses Promise.all where
 * step ordering allows; sequential reads/writes preserve ordering where step
 * N depends on step N-1's write being on disk. See PR-C 1.6.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';
import { atomicWriteJson, createKeyedWriteQueue } from './utils/atomic-json-store';
import { parseJsonWithBom, stripJsonBom } from '../shared/jsonUtils';
import { HistoryEntry } from '../shared/types';
import {
	HISTORY_VERSION,
	MAX_ENTRIES_PER_SESSION,
	HistoryFileData,
	MigrationMarker,
	PaginationOptions,
	PaginatedResult,
	sanitizeSessionId,
	paginateEntries,
	sortEntriesByTimestamp,
} from '../shared/history';

const LOG_CONTEXT = '[HistoryManager]';

/**
 * Best-effort fs.access: resolves true if the path is readable, false on
 * ENOENT. Other errors propagate to the caller (or are caught at the
 * outer try in the public method).
 */
async function pathExists(p: string): Promise<boolean> {
	try {
		await fsp.access(p, fs.constants.F_OK);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return false;
		throw err;
	}
}

function findFirstJsonObjectEnd(raw: string): number | null {
	const start = raw.search(/\S/);
	if (start === -1 || raw[start] !== '{') return null;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < raw.length; i++) {
		const char = raw[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
		}
	}

	return null;
}

function parseHistoryFileData(raw: string): { data: HistoryFileData; recovered: boolean } {
	const normalized = stripJsonBom(raw);
	try {
		return { data: JSON.parse(normalized) as HistoryFileData, recovered: false };
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;

		const firstObjectEnd = findFirstJsonObjectEnd(normalized);
		if (firstObjectEnd === null) throw error;

		const trailing = normalized.slice(firstObjectEnd).trim();
		if (trailing.length === 0) throw error;

		const data = JSON.parse(normalized.slice(0, firstObjectEnd)) as HistoryFileData;
		return { data, recovered: true };
	}
}

/**
 * HistoryManager handles per-session history storage with automatic migration
 * from the legacy single-file format.
 */
export class HistoryManager {
	private historyDir: string;
	private legacyFilePath: string;
	private migrationMarkerPath: string;
	private configDir: string;
	private watcher: fs.FSWatcher | null = null;
	/**
	 * Per-session write serialization. Every mutating op (add/delete/update/
	 * clear) runs through this so two callers never interleave a read-modify-
	 * write on the same history file. Combined with `atomicWriteJson`, this
	 * closes the concurrent-write corruption that silently wiped history for
	 * busy (high-frequency Cue) agents.
	 */
	private writeQueue = createKeyedWriteQueue();

	constructor() {
		this.configDir = app.getPath('userData');
		this.historyDir = path.join(this.configDir, 'history');
		this.legacyFilePath = path.join(this.configDir, 'maestro-history.json');
		this.migrationMarkerPath = path.join(this.configDir, 'history-migrated.json');
	}

	/**
	 * Initialize history manager - create directory and run migration if needed
	 */
	async initialize(): Promise<void> {
		// Ensure history directory exists
		await fsp.mkdir(this.historyDir, { recursive: true });
		logger.debug('Created history directory', LOG_CONTEXT);

		// Check if migration is needed
		if (await this.needsMigration()) {
			await this.migrateFromLegacy();
		}
	}

	/**
	 * Check if migration from legacy format is needed
	 */
	private async needsMigration(): Promise<boolean> {
		// If marker exists, migration was already done
		if (await pathExists(this.migrationMarkerPath)) {
			return false;
		}

		// If legacy file exists with entries, need to migrate
		if (await pathExists(this.legacyFilePath)) {
			try {
				const raw = await fsp.readFile(this.legacyFilePath, 'utf-8');
				const data = parseJsonWithBom<{ entries?: HistoryEntry[] }>(raw);
				return (data.entries?.length ?? 0) > 0;
			} catch {
				return false;
			}
		}

		return false;
	}

	/**
	 * Check if migration has been completed
	 */
	async hasMigrated(): Promise<boolean> {
		return pathExists(this.migrationMarkerPath);
	}

	/**
	 * Migrate entries from legacy single-file format to per-session files
	 */
	private async migrateFromLegacy(): Promise<void> {
		logger.info('Starting history migration from legacy format', LOG_CONTEXT);

		try {
			const raw = await fsp.readFile(this.legacyFilePath, 'utf-8');
			const legacyData = parseJsonWithBom<{ entries?: HistoryEntry[] }>(raw);
			const entries: HistoryEntry[] = legacyData.entries || [];

			// Group entries by sessionId (skip entries without sessionId)
			const entriesBySession = new Map<string, HistoryEntry[]>();
			let skippedCount = 0;

			for (const entry of entries) {
				const sessionId = entry.sessionId;
				if (sessionId) {
					if (!entriesBySession.has(sessionId)) {
						entriesBySession.set(sessionId, []);
					}
					entriesBySession.get(sessionId)!.push(entry);
				} else {
					// Skip orphaned entries - they can't be properly associated with a session
					skippedCount++;
				}
			}

			if (skippedCount > 0) {
				logger.info(`Skipped ${skippedCount} orphaned entries (no sessionId)`, LOG_CONTEXT);
			}

			// Write per-session files in parallel - independent writes to
			// distinct paths.
			const writes = Array.from(entriesBySession.entries()).map(
				async ([sessionId, sessionEntries]) => {
					const projectPath = sessionEntries[0]?.projectPath || '';
					const fileData: HistoryFileData = {
						version: HISTORY_VERSION,
						sessionId,
						projectPath,
						entries: sessionEntries.slice(0, MAX_ENTRIES_PER_SESSION),
					};
					const filePath = this.getSessionFilePath(sessionId);
					await atomicWriteJson(filePath, fileData);
					logger.debug(
						`Migrated ${sessionEntries.length} entries for session ${sessionId}`,
						LOG_CONTEXT
					);
				}
			);
			await Promise.all(writes);
			const sessionsMigrated = entriesBySession.size;

			// Migration-marker write must happen AFTER all per-session writes
			// have settled - otherwise a crash mid-migration could leave the
			// marker in place with partial data on disk. Sequential here is
			// load-bearing.
			const marker: MigrationMarker = {
				migratedAt: Date.now(),
				version: HISTORY_VERSION,
				legacyEntryCount: entries.length,
				sessionsMigrated,
			};
			await fsp.writeFile(this.migrationMarkerPath, JSON.stringify(marker, null, 2), 'utf-8');

			logger.info(
				`History migration complete: ${entries.length} entries -> ${sessionsMigrated} session files`,
				LOG_CONTEXT
			);
		} catch (error) {
			logger.error(`History migration failed: ${error}`, LOG_CONTEXT);
			throw error;
		}
	}

	/**
	 * Get file path for a session's history
	 */
	private getSessionFilePath(sessionId: string): string {
		const safeId = sanitizeSessionId(sessionId);
		return path.join(this.historyDir, `${safeId}.json`);
	}

	/**
	 * Read history for a specific session
	 */
	async getEntries(sessionId: string): Promise<HistoryEntry[]> {
		const filePath = this.getSessionFilePath(sessionId);
		try {
			const raw = await fsp.readFile(filePath, 'utf-8');
			const { data, recovered } = parseHistoryFileData(raw);
			if (recovered) {
				logger.warn(
					`Recovered concatenated history JSON for session ${sessionId}; rewriting clean file`,
					LOG_CONTEXT
				);
				// Serialize the cleanup rewrite against concurrent mutations so it
				// can't clobber an add that lands between our read and this write.
				await this.writeQueue.enqueue(sessionId, () => atomicWriteJson(filePath, data));
			}
			return data.entries || [];
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return []; // Cold-cache miss is expected
			// A malformed/truncated history file (e.g. a write interrupted by a crash
			// or power loss) surfaces as a JSON SyntaxError once recovery fails. That's
			// an expected, recoverable on-disk condition - not a code bug - so we degrade
			// gracefully to an empty history rather than reporting it to Sentry, where it
			// only piled up as non-actionable noise (MAESTRO-QA). Genuinely unexpected
			// read failures (permissions, I/O, etc.) are still captured below.
			if (error instanceof SyntaxError) {
				logger.warn(
					`Discarding unreadable history for session ${sessionId} (corrupt JSON): ${error}`,
					LOG_CONTEXT
				);
				return [];
			}
			logger.warn(`Failed to read history for session ${sessionId}: ${error}`, LOG_CONTEXT);
			captureException(error, { operation: 'history:read', sessionId });
			return [];
		}
	}

	/**
	 * Add an entry to a session's history
	 * @param maxEntries - Maximum entries to retain (defaults to MAX_ENTRIES_PER_SESSION).
	 *                     Pass the user's maxLogBuffer setting to unify the cap.
	 */
	async addEntry(
		sessionId: string,
		projectPath: string,
		entry: HistoryEntry,
		maxEntries?: number
	): Promise<void> {
		const filePath = this.getSessionFilePath(sessionId);
		const limit = maxEntries ?? MAX_ENTRIES_PER_SESSION;

		// Serialize per session so two concurrent adds (e.g. overlapping Cue
		// schedules) can't interleave their read-modify-write and clobber each
		// other. The atomic write below additionally protects cross-process
		// readers (and the CLI writer) from ever seeing a partial file.
		await this.writeQueue.enqueue(sessionId, async () => {
			let data: HistoryFileData;
			// Count of entries we read from a SUCCESSFULLY-parsed existing file.
			// -1 means "no trustworthy prior" (new file or corrupt-and-preserved),
			// which disables the shrink tripwire below for this write.
			let priorCount = -1;

			try {
				const raw = await fsp.readFile(filePath, 'utf-8');
				data = parseHistoryFileData(raw).data;
				priorCount = data.entries.length;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') {
					// New session - start with empty file.
					data = { version: HISTORY_VERSION, sessionId, projectPath, entries: [] };
				} else {
					// A readable-but-unparseable file is corrupt history. Do NOT
					// overwrite it with a fresh empty file - that's what silently
					// destroyed accumulated history. Preserve the bytes aside for
					// recovery, then start fresh so writes aren't blocked forever.
					await this.preserveCorruptFile(filePath, sessionId, error);
					data = { version: HISTORY_VERSION, sessionId, projectPath, entries: [] };
				}
			}

			// A file can parse as valid JSON yet still lack a usable `entries` array
			// (legacy/partial writes, hand-edited files, or `null`/non-object content).
			// The catch above only covers JSON.parse throwing, so guard the shape here
			// before unshift can throw "Cannot read properties of undefined". (MAESTRO-QK)
			if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
				data = { version: HISTORY_VERSION, sessionId, projectPath, entries: [] };
			}

			// Add to beginning (most recent first)
			data.entries.unshift(entry);

			// Trim to max entries
			if (data.entries.length > limit) {
				data.entries = data.entries.slice(0, limit);
			}

			// Shrink tripwire: addEntry only ever GROWS the list (or trims to
			// `limit`), so the result must hold at least `min(priorCount, limit)`
			// entries. A smaller count means a logic regression upstream tried to
			// destroy history through the add path - refuse the write and keep the
			// good on-disk file rather than clobber it. Only enforced when we have
			// a trustworthy prior (a clean parse of an existing file).
			if (priorCount >= 0 && data.entries.length < Math.min(priorCount, limit)) {
				const msg = `Refusing history write for session ${sessionId}: entry count would shrink ${priorCount} -> ${data.entries.length}`;
				logger.error(msg, LOG_CONTEXT);
				captureException(new Error(msg), {
					operation: 'history:shrinkGuard',
					sessionId,
					priorCount,
					newCount: data.entries.length,
				});
				return;
			}

			// Update projectPath if it changed
			data.projectPath = projectPath;

			try {
				await atomicWriteJson(filePath, data);
				logger.debug(`Added history entry for session ${sessionId}`, LOG_CONTEXT);
			} catch (error) {
				logger.error(`Failed to write history for session ${sessionId}: ${error}`, LOG_CONTEXT);
				captureException(error, { operation: 'history:write', sessionId });
			}
		});
	}

	/**
	 * Move a corrupt history file aside (rename to `${file}.corrupt-<ts>`) so
	 * its bytes survive for recovery instead of being silently overwritten.
	 * Best-effort: a failure here must not block the pending write.
	 */
	private async preserveCorruptFile(
		filePath: string,
		sessionId: string,
		cause: unknown
	): Promise<void> {
		const backupPath = `${filePath}.corrupt-${Date.now()}`;
		try {
			await fsp.rename(filePath, backupPath);
			logger.warn(
				`Corrupt history for session ${sessionId} preserved at ${backupPath}: ${cause}`,
				LOG_CONTEXT
			);
			captureException(cause instanceof Error ? cause : new Error(String(cause)), {
				operation: 'history:corrupt',
				sessionId,
				backupPath,
			});
		} catch (renameError) {
			logger.warn(
				`Failed to preserve corrupt history for session ${sessionId}: ${renameError}`,
				LOG_CONTEXT
			);
		}
	}

	/**
	 * Delete a specific entry from a session's history
	 */
	async deleteEntry(sessionId: string, entryId: string): Promise<boolean> {
		const filePath = this.getSessionFilePath(sessionId);

		return this.writeQueue.enqueue(sessionId, async () => {
			let raw: string;
			try {
				raw = await fsp.readFile(filePath, 'utf-8');
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') return false;
				return false;
			}

			try {
				const data = parseHistoryFileData(raw).data;
				const originalLength = data.entries.length;
				data.entries = data.entries.filter((e) => e.id !== entryId);

				if (data.entries.length === originalLength) {
					return false; // Entry not found
				}

				try {
					await atomicWriteJson(filePath, data);
					return true;
				} catch (writeError) {
					logger.error(
						`Failed to write history after delete for session ${sessionId}: ${writeError}`,
						LOG_CONTEXT
					);
					captureException(writeError, { operation: 'history:deleteWrite', sessionId, entryId });
					return false;
				}
			} catch {
				return false;
			}
		});
	}

	/**
	 * Update a specific entry in a session's history
	 */
	async updateEntry(
		sessionId: string,
		entryId: string,
		updates: Partial<HistoryEntry>
	): Promise<boolean> {
		const filePath = this.getSessionFilePath(sessionId);

		return this.writeQueue.enqueue(sessionId, async () => {
			let raw: string;
			try {
				raw = await fsp.readFile(filePath, 'utf-8');
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') return false;
				return false;
			}

			try {
				const data = parseHistoryFileData(raw).data;
				const index = data.entries.findIndex((e) => e.id === entryId);

				if (index === -1) {
					return false;
				}

				data.entries[index] = { ...data.entries[index], ...updates };
				try {
					await atomicWriteJson(filePath, data);
					return true;
				} catch (writeError) {
					logger.error(
						`Failed to write history after update for session ${sessionId}: ${writeError}`,
						LOG_CONTEXT
					);
					captureException(writeError, { operation: 'history:updateWrite', sessionId, entryId });
					return false;
				}
			} catch {
				return false;
			}
		});
	}

	/**
	 * Clear all history for a session
	 */
	async clearSession(sessionId: string): Promise<void> {
		const filePath = this.getSessionFilePath(sessionId);
		// Serialize against queued mutations so the unlink can't land between a
		// pending add's read and write (which would resurrect the file).
		await this.writeQueue.enqueue(sessionId, async () => {
			try {
				await fsp.unlink(filePath);
				logger.info(`Cleared history for session ${sessionId}`, LOG_CONTEXT);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') return; // Already gone is fine
				logger.error(`Failed to clear history for session ${sessionId}: ${error}`, LOG_CONTEXT);
				captureException(error, { operation: 'history:clear', sessionId });
			}
		});
	}

	/**
	 * List all sessions that have history files
	 */
	async listSessionsWithHistory(): Promise<string[]> {
		try {
			const files = await fsp.readdir(this.historyDir);
			return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return [];
			throw error;
		}
	}

	/**
	 * Get the file path for a session's history (for passing to AI as context).
	 * Returns the path if the file exists, null otherwise.
	 */
	async getHistoryFilePath(sessionId: string): Promise<string | null> {
		const filePath = this.getSessionFilePath(sessionId);
		return (await pathExists(filePath)) ? filePath : null;
	}

	/**
	 * Get all entries across all sessions (for cross-session views)
	 * Returns entries sorted by timestamp (most recent first)
	 * @deprecated Use getAllEntriesPaginated for large datasets
	 */
	async getAllEntries(limit?: number): Promise<HistoryEntry[]> {
		const sessions = await this.listSessionsWithHistory();
		// Parallel reads - independent files.
		const allEntriesArrays = await Promise.all(sessions.map((sid) => this.getEntries(sid)));
		const allEntries = allEntriesArrays.flat();
		const sorted = sortEntriesByTimestamp(allEntries);
		return limit ? sorted.slice(0, limit) : sorted;
	}

	/**
	 * Get all entries across all sessions with pagination support
	 * Returns entries sorted by timestamp (most recent first)
	 */
	async getAllEntriesPaginated(
		options?: PaginationOptions
	): Promise<PaginatedResult<HistoryEntry>> {
		const sessions = await this.listSessionsWithHistory();
		const allEntriesArrays = await Promise.all(sessions.map((sid) => this.getEntries(sid)));
		const allEntries = allEntriesArrays.flat();
		const sorted = sortEntriesByTimestamp(allEntries);
		return paginateEntries(sorted, options);
	}

	/**
	 * Get entries filtered by project path
	 * @deprecated Use getEntriesByProjectPathPaginated for large datasets
	 */
	async getEntriesByProjectPath(projectPath: string): Promise<HistoryEntry[]> {
		const sessions = await this.listSessionsWithHistory();
		const allEntriesArrays = await Promise.all(sessions.map((sid) => this.getEntries(sid)));
		const entries: HistoryEntry[] = [];
		for (const sessionEntries of allEntriesArrays) {
			if (sessionEntries.length > 0 && sessionEntries[0].projectPath === projectPath) {
				entries.push(...sessionEntries);
			}
		}
		return sortEntriesByTimestamp(entries);
	}

	/**
	 * Get entries filtered by project path with pagination support
	 */
	async getEntriesByProjectPathPaginated(
		projectPath: string,
		options?: PaginationOptions
	): Promise<PaginatedResult<HistoryEntry>> {
		const entries = await this.getEntriesByProjectPath(projectPath);
		return paginateEntries(entries, options);
	}

	/**
	 * Get entries for a specific session with pagination support
	 */
	async getEntriesPaginated(
		sessionId: string,
		options?: PaginationOptions
	): Promise<PaginatedResult<HistoryEntry>> {
		const entries = await this.getEntries(sessionId);
		return paginateEntries(entries, options);
	}

	/**
	 * Update sessionName for all entries matching a given agentSessionId.
	 * This is used when a tab is renamed to retroactively update past history entries.
	 */
	async updateSessionNameByClaudeSessionId(
		agentSessionId: string,
		sessionName: string
	): Promise<number> {
		const sessions = await this.listSessionsWithHistory();
		let updatedCount = 0;

		// Per session, run the read-modify-write through the per-session write
		// queue so it can't interleave with a concurrent addEntry on the same
		// file. Different sessions still proceed sequentially here (the outer
		// loop awaits each), which is fine for this infrequent rename path.
		for (const sessionId of sessions) {
			const filePath = this.getSessionFilePath(sessionId);
			await this.writeQueue.enqueue(sessionId, async () => {
				let raw: string;
				try {
					raw = await fsp.readFile(filePath, 'utf-8');
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === 'ENOENT') return; // file gone since listing - skip
					logger.warn(`Failed to read session ${sessionId}: ${error}`, LOG_CONTEXT);
					return;
				}

				try {
					const { data, recovered } = parseHistoryFileData(raw);
					let modified = recovered;
					let perSessionUpdates = 0;

					if (recovered) {
						logger.warn(
							`Recovered concatenated history JSON for session ${sessionId}; rewriting clean file`,
							LOG_CONTEXT
						);
					}

					for (const entry of data.entries) {
						if (entry.agentSessionId === agentSessionId && entry.sessionName !== sessionName) {
							entry.sessionName = sessionName;
							modified = true;
							perSessionUpdates++;
						}
					}

					if (modified) {
						await atomicWriteJson(filePath, data);
						updatedCount += perSessionUpdates;
						if (perSessionUpdates > 0) {
							logger.debug(
								`Updated ${perSessionUpdates} entries for agentSessionId ${agentSessionId} in session ${sessionId}`,
								LOG_CONTEXT
							);
						}
					}
				} catch (error) {
					logger.warn(
						`Failed to update sessionName in session ${sessionId}: ${error}`,
						LOG_CONTEXT
					);
					captureException(error, { operation: 'history:updateSessionName', sessionId });
				}
			});
		}

		return updatedCount;
	}

	/**
	 * Clear all sessions for a specific project
	 */
	async clearByProjectPath(projectPath: string): Promise<void> {
		const sessions = await this.listSessionsWithHistory();
		// Read all in parallel, then clear matching ones in parallel.
		const allEntriesArrays = await Promise.all(sessions.map((sid) => this.getEntries(sid)));
		const toDelete: string[] = [];
		sessions.forEach((sid, i) => {
			const entries = allEntriesArrays[i];
			if (entries.length > 0 && entries[0].projectPath === projectPath) {
				toDelete.push(sid);
			}
		});
		await Promise.all(toDelete.map((sid) => this.clearSession(sid)));
	}

	/**
	 * Clear all history (all session files)
	 */
	async clearAll(): Promise<void> {
		const sessions = await this.listSessionsWithHistory();
		await Promise.all(sessions.map((sid) => this.clearSession(sid)));
		logger.info('Cleared all history', LOG_CONTEXT);
	}

	/**
	 * Start watching the history directory for external changes.
	 * Dispatches events with the affected sessionId so renderers can
	 * decide whether to reload.
	 *
	 * Synchronous body: this is called once at app init, not a hot path,
	 * and callers (including tests) treat the watcher as available
	 * immediately after the call returns.
	 */
	startWatching(onExternalChange: (sessionId: string) => void): void {
		if (this.watcher) return; // Already watching

		// Ensure directory exists before watching. mkdirSync with recursive
		// is idempotent and only runs once per app lifetime.
		fs.mkdirSync(this.historyDir, { recursive: true });

		try {
			this.watcher = fs.watch(this.historyDir, (_eventType, filename) => {
				if (filename?.endsWith('.json')) {
					const sessionId = filename.replace('.json', '');
					logger.debug(`History file changed: ${filename}`, LOG_CONTEXT);
					onExternalChange(sessionId);
				}
			});

			// fs.watch emits 'error' when the watched directory becomes unavailable
			// (removed, permission change, network volume disconnect). Without a listener
			// the EventEmitter throws as an unhandled exception and crashes the main process.
			// Expected/recoverable codes get a quiet warn; everything else goes to Sentry
			// so we keep visibility into novel failure modes in production.
			this.watcher.on('error', (err) => {
				const code = (err as NodeJS.ErrnoException | undefined)?.code;
				if (code === 'ENOENT' || code === 'EPERM' || code === 'UNKNOWN') {
					logger.warn(`History watcher error (${code}): ${String(err)}`, LOG_CONTEXT);
					return;
				}
				void captureException(err, {
					operation: 'history:watch:error',
					historyDir: this.historyDir,
				});
				logger.warn(`History watcher error: ${String(err)}`, LOG_CONTEXT);
			});

			logger.info('Started watching history directory', LOG_CONTEXT);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void captureException(error, {
				operation: 'history:watch:start',
				historyDir: this.historyDir,
			});
			logger.warn(`Failed to start history watcher: ${message}`, LOG_CONTEXT);
			this.watcher = null;
		}
	}

	/**
	 * Stop watching the history directory.
	 */
	stopWatching(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
			logger.info('Stopped watching history directory', LOG_CONTEXT);
		}
	}

	/**
	 * Get the history directory path (for debugging/testing)
	 */
	getHistoryDir(): string {
		return this.historyDir;
	}

	/**
	 * Get the legacy file path (for debugging/testing)
	 */
	getLegacyFilePath(): string {
		return this.legacyFilePath;
	}
}

// Singleton instance
let historyManager: HistoryManager | null = null;

/**
 * Get the singleton HistoryManager instance
 */
export function getHistoryManager(): HistoryManager {
	if (!historyManager) {
		historyManager = new HistoryManager();
	}
	return historyManager;
}
