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
import { atomicWriteFile, createKeyedWriteQueue } from './utils/atomic-json-store';
import { parseJsonWithBom, stripJsonBom } from '../shared/jsonUtils';
import { HistoryEntry } from '../shared/types';
import {
	HISTORY_VERSION,
	HISTORY_JSONL_EXT,
	HISTORY_LEGACY_JSON_EXT,
	MAX_ENTRIES_PER_SESSION,
	resolveHistoryEntryLimit,
	parseHistoryJsonl,
	serializeHistoryEntryLine,
	trimHistoryEntriesToLimit,
	HistoryFileData,
	MigrationMarker,
	PaginationOptions,
	PaginatedResult,
	sanitizeSessionId,
	paginateEntries,
	sortEntriesByTimestamp,
	normalizeHistoryEntries,
} from '../shared/history';

/**
 * How many appends a session may take before we re-check its file against the
 * entry cap.
 *
 * Rotation is the only remaining read-modify-write on the add path, so it must
 * be rare: checking on every append would reintroduce exactly the whole-file
 * rewrite that JSONL exists to remove. Overshoot is bounded by this number
 * (a file may briefly hold up to `limit + ROTATION_CHECK_APPENDS` entries),
 * which is invisible to readers because they trim on the way out.
 */
const ROTATION_CHECK_APPENDS = 500;

const LOG_CONTEXT = '[HistoryManager]';

/**
 * Error codes that mean "this machine cannot watch right now", not "Maestro is
 * broken". ENOENT/EPERM/UNKNOWN are the directory going away or turning
 * unreadable; EMFILE/ENFILE/ENOSPC are OS resource ceilings (fd limit, and on
 * Linux the inotify `max_user_watches` cap, which surfaces as ENOSPC rather
 * than a disk-space error).
 *
 * Watching only powers live refresh when another process edits history on disk;
 * the caller already degrades to a null watcher and history keeps working, so
 * these are best-effort failures and reporting them to Sentry is pure noise.
 *
 * Deliberately NOT shared with `isExpectedSessionReadError` in
 * ipc/handlers/agentSessions.ts, which excludes EMFILE on purpose: an EMFILE
 * while *reading* a session file can mean a real fd leak worth reporting.
 */
const EXPECTED_WATCH_ERROR_CODES = new Set([
	'ENOENT',
	'EPERM',
	'UNKNOWN',
	'EMFILE',
	'ENFILE',
	'ENOSPC',
]);

function isExpectedWatchError(code: string | undefined): boolean {
	return typeof code === 'string' && EXPECTED_WATCH_ERROR_CODES.has(code);
}

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
	/**
	 * Resolves the user's per-session entry cap (`maxLogBuffer`). Set once at
	 * startup by the main process so fire-and-forget writers - Cue notify,
	 * Cue command, Cue agent runs - trim to the SAME cap the IPC path uses.
	 * When each writer picked its own limit, the smallest one won on disk and
	 * silently destroyed entries the user had asked to keep.
	 */
	private maxEntriesResolver: (() => number) | null = null;
	/**
	 * Appends taken per session since its file was last checked against the cap.
	 * In-memory on purpose: losing the counter on restart only costs one extra
	 * rotation check, and persisting it would reintroduce a per-append write.
	 */
	private appendsSinceRotationCheck = new Map<string, number>();

	constructor() {
		this.configDir = app.getPath('userData');
		this.historyDir = path.join(this.configDir, 'history');
		this.legacyFilePath = path.join(this.configDir, 'maestro-history.json');
		this.migrationMarkerPath = path.join(this.configDir, 'history-migrated.json');
	}

	/**
	 * Point the manager at the user's `maxLogBuffer` setting. Call before
	 * `initialize()` so the migration path honours it too.
	 */
	setMaxEntriesResolver(resolver: () => number): void {
		this.maxEntriesResolver = resolver;
	}

	/**
	 * The entry cap for a write: an explicit argument wins, then the user's
	 * setting, then the built-in fallback.
	 */
	private resolveMaxEntries(explicit?: number): number {
		if (explicit !== undefined) return resolveHistoryEntryLimit(explicit);
		if (!this.maxEntriesResolver) return MAX_ENTRIES_PER_SESSION;
		try {
			return resolveHistoryEntryLimit(this.maxEntriesResolver());
		} catch {
			// A settings-store read should never take history writes down.
			return MAX_ENTRIES_PER_SESSION;
		}
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
			const migrationLimit = this.resolveMaxEntries();
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
					// Legacy order is newest-first; JSONL is append order, so the
					// kept slice is reversed on the way to disk.
					const kept = sessionEntries.slice(0, migrationLimit).reverse();
					const filePath = this.getSessionFilePath(sessionId);
					await atomicWriteFile(filePath, kept.map(serializeHistoryEntryLine).join(''));
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
	 * Path to a session's JSONL history file (the current format).
	 */
	private getSessionFilePath(sessionId: string): string {
		const safeId = sanitizeSessionId(sessionId);
		return path.join(this.historyDir, `${safeId}${HISTORY_JSONL_EXT}`);
	}

	/**
	 * Path to a session's legacy single-object `.json` file. Only present until
	 * the session is migrated on first touch.
	 */
	private getLegacySessionFilePath(sessionId: string): string {
		const safeId = sanitizeSessionId(sessionId);
		return path.join(this.historyDir, `${safeId}${HISTORY_LEGACY_JSON_EXT}`);
	}

	/**
	 * Convert a session's legacy `.json` file to JSONL, once.
	 *
	 * The legacy array is newest-first and JSONL is append order (oldest first),
	 * so the entries are reversed on the way out. The legacy file is renamed to
	 * `.json.migrated` rather than deleted: this is the user's memory, and a
	 * one-time format change is not worth a destructive step. Returns the
	 * migrated entries in file order, or null when there was nothing to migrate.
	 */
	private async migrateSessionToJsonl(sessionId: string): Promise<HistoryEntry[] | null> {
		const legacyPath = this.getLegacySessionFilePath(sessionId);
		const jsonlPath = this.getSessionFilePath(sessionId);

		let raw: string;
		try {
			raw = await fsp.readFile(legacyPath, 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}

		let legacyEntries: HistoryEntry[];
		try {
			legacyEntries = parseHistoryFileData(raw).data.entries || [];
		} catch (error) {
			// Unreadable legacy file: preserve it and let the session start clean
			// on JSONL rather than blocking every future write on a bad parse.
			await this.preserveCorruptFile(legacyPath, sessionId, error);
			return null;
		}

		// Legacy order is newest-first; JSONL is oldest-first.
		const fileOrder = [...legacyEntries].reverse();
		const serialized = fileOrder.map(serializeHistoryEntryLine).join('');

		await atomicWriteFile(jsonlPath, serialized);
		try {
			await fsp.rename(legacyPath, `${legacyPath}.migrated`);
		} catch (renameError) {
			// The JSONL file is already in place, so a failed rename only risks a
			// duplicate migration on the next read - not data loss.
			logger.warn(
				`Migrated history for session ${sessionId} but could not retire the legacy file: ${renameError}`,
				LOG_CONTEXT
			);
		}

		logger.info(
			`Migrated history for session ${sessionId} to JSONL (${fileOrder.length} entries)`,
			LOG_CONTEXT
		);
		return fileOrder;
	}

	/**
	 * Read a session's history in FILE order (oldest first). Migrates a legacy
	 * `.json` session on first touch. Internal: callers that face the rest of
	 * the app want newest-first, which is what `getEntries` returns.
	 */
	private async readEntriesInFileOrder(sessionId: string): Promise<HistoryEntry[]> {
		const filePath = this.getSessionFilePath(sessionId);
		let raw: string;
		try {
			raw = await fsp.readFile(filePath, 'utf-8');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT') {
				logger.warn(`Failed to read history for session ${sessionId}: ${error}`, LOG_CONTEXT);
				captureException(error, { operation: 'history:read', sessionId });
				return [];
			}
			// No JSONL file yet: this is either a brand-new session or one that
			// still has a legacy `.json` to migrate.
			try {
				return (await this.migrateSessionToJsonl(sessionId)) ?? [];
			} catch (migrateError) {
				logger.warn(
					`Failed to migrate history for session ${sessionId}: ${migrateError}`,
					LOG_CONTEXT
				);
				captureException(migrateError, { operation: 'history:migrateJsonl', sessionId });
				return [];
			}
		}

		const { entries, malformedLines } = parseHistoryJsonl(stripJsonBom(raw));
		if (malformedLines > 0) {
			// One bad line is the expected cost of a write interrupted by a crash
			// or power loss, and it costs exactly that one entry. More than one
			// means something else is writing this file wrongly - worth knowing,
			// but never a reason to discard the entries that DID parse.
			logger.warn(
				`Skipped ${malformedLines} malformed history line(s) for session ${sessionId}`,
				LOG_CONTEXT
			);
			if (malformedLines > 1) {
				captureException(
					new Error(`History file for session ${sessionId} had ${malformedLines} bad lines`),
					{ operation: 'history:malformedLines', sessionId, malformedLines }
				);
			}
		}
		return entries;
	}

	/**
	 * Read history for a specific session, newest first.
	 *
	 * The newest-first contract predates JSONL (the legacy file stored entries
	 * that way) and several callers still rely on it, so the file-order array is
	 * reversed here rather than at each call site.
	 */
	async getEntries(sessionId: string): Promise<HistoryEntry[]> {
		const entries = await this.readEntriesInFileOrder(sessionId);
		// Re-map legacy cross-agent consults (written as AUTO before the AGENT
		// type existed) so no consumer has to special-case them. Applied here
		// rather than in the file-order reader because the trim/prune paths write
		// what they read back to disk, and a read is not the moment to rewrite
		// entries the user has not touched.
		return normalizeHistoryEntries(entries.reverse());
	}

	/**
	 * Add an entry to a session's history
	 * @param maxEntries - Maximum entries to retain. Omit to use the user's
	 *                     maxLogBuffer setting (see setMaxEntriesResolver).
	 */
	async addEntry(
		sessionId: string,
		projectPath: string,
		entry: HistoryEntry,
		maxEntries?: number
	): Promise<void> {
		const filePath = this.getSessionFilePath(sessionId);
		const limit = this.resolveMaxEntries(maxEntries);

		// Serialize per session so an append can't interleave with a rotation
		// (the one remaining read-modify-write on this path).
		await this.writeQueue.enqueue(sessionId, async () => {
			// A session still on the legacy format must be converted before its
			// first append, or the appended line would be tacked onto a JSON
			// object and make the file unreadable.
			await this.ensureJsonlFile(sessionId);

			// The file-level projectPath of the old format is gone, so each line
			// must carry its own - `getEntriesByProjectPath` filters on it.
			const record: HistoryEntry = entry.projectPath ? entry : { ...entry, projectPath };

			try {
				// O_APPEND: the kernel seeks to EOF as part of the write, so two
				// processes (app + maestro-cli) appending at once cannot overwrite
				// each other's bytes. There is no read step here, which is what
				// removes the cross-process lost-update race the old
				// read-modify-write had.
				await fsp.appendFile(filePath, serializeHistoryEntryLine(record), 'utf-8');
				logger.debug(`Added history entry for session ${sessionId}`, LOG_CONTEXT);
			} catch (error) {
				logger.error(`Failed to write history for session ${sessionId}: ${error}`, LOG_CONTEXT);
				captureException(error, { operation: 'history:write', sessionId });
				return;
			}

			await this.maybeRotate(sessionId, limit);
		});
	}

	/**
	 * Ensure a JSONL file exists for this session, migrating a legacy `.json`
	 * first if one is present. Cheap on the steady-state path (one `access`).
	 */
	private async ensureJsonlFile(sessionId: string): Promise<void> {
		if (await pathExists(this.getSessionFilePath(sessionId))) return;
		try {
			await this.migrateSessionToJsonl(sessionId);
		} catch (error) {
			logger.warn(
				`Failed to migrate history for session ${sessionId} before append: ${error}`,
				LOG_CONTEXT
			);
			captureException(error, { operation: 'history:migrateJsonl', sessionId });
		}
	}

	/**
	 * Trim a session's file back to `limit`, but only every
	 * `ROTATION_CHECK_APPENDS` appends.
	 *
	 * Must be called from inside the session's write-queue slot: it reads the
	 * whole file and replaces it, so an append landing in between would be lost.
	 */
	private async maybeRotate(sessionId: string, limit: number): Promise<void> {
		// The first append of an app run always checks, so a cap the user just
		// LOWERED takes effect on the next entry instead of up to 500 later.
		const prior = this.appendsSinceRotationCheck.get(sessionId);
		const sinceCheck = (prior ?? 0) + 1;
		if (prior !== undefined && sinceCheck < ROTATION_CHECK_APPENDS) {
			this.appendsSinceRotationCheck.set(sessionId, sinceCheck);
			return;
		}
		this.appendsSinceRotationCheck.set(sessionId, 0);

		const filePath = this.getSessionFilePath(sessionId);
		try {
			const raw = await fsp.readFile(filePath, 'utf-8');
			const { entries } = parseHistoryJsonl(stripJsonBom(raw));
			const trimmed = trimHistoryEntriesToLimit(entries, limit);
			if (trimmed.length === entries.length) return;

			// Shrink tripwire, carried over from the old read-modify-write path:
			// rotation may only ever land ON the cap. Anything smaller means the
			// limit or the parse went wrong, and silently discarding the user's
			// memory is the exact failure this guard exists to prevent.
			if (trimmed.length < Math.min(entries.length, limit)) {
				const msg = `Refusing history rotation for session ${sessionId}: ${entries.length} -> ${trimmed.length} (limit ${limit})`;
				logger.error(msg, LOG_CONTEXT);
				captureException(new Error(msg), {
					operation: 'history:shrinkGuard',
					sessionId,
					priorCount: entries.length,
					newCount: trimmed.length,
				});
				return;
			}

			await atomicWriteFile(filePath, trimmed.map(serializeHistoryEntryLine).join(''));
			logger.debug(
				`Rotated history for session ${sessionId}: ${entries.length} -> ${trimmed.length}`,
				LOG_CONTEXT
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			logger.warn(`Failed to rotate history for session ${sessionId}: ${error}`, LOG_CONTEXT);
			captureException(error, { operation: 'history:rotate', sessionId });
		}
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
		return this.rewriteEntries(sessionId, 'delete', entryId, (entries) => {
			const remaining = entries.filter((e) => e.id !== entryId);
			return remaining.length === entries.length ? null : remaining;
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
		return this.rewriteEntries(sessionId, 'update', entryId, (entries) => {
			const index = entries.findIndex((e) => e.id === entryId);
			if (index === -1) return null;
			const next = [...entries];
			next[index] = { ...next[index], ...updates };
			return next;
		});
	}

	/**
	 * Read-modify-rewrite a session's JSONL file under its write-queue slot.
	 *
	 * Deletes and edits are rare and user-initiated, so they can afford the full
	 * rewrite that appends deliberately avoid. `mutate` returns null to mean
	 * "nothing matched", which skips the write entirely.
	 */
	private async rewriteEntries(
		sessionId: string,
		operation: 'delete' | 'update',
		entryId: string,
		mutate: (entries: HistoryEntry[]) => HistoryEntry[] | null
	): Promise<boolean> {
		return this.writeQueue.enqueue(sessionId, async () => {
			const entries = await this.readEntriesInFileOrder(sessionId);
			if (entries.length === 0) return false;

			const next = mutate(entries);
			if (next === null) return false;

			try {
				await atomicWriteFile(
					this.getSessionFilePath(sessionId),
					next.map(serializeHistoryEntryLine).join('')
				);
				return true;
			} catch (writeError) {
				logger.error(
					`Failed to write history after ${operation} for session ${sessionId}: ${writeError}`,
					LOG_CONTEXT
				);
				captureException(writeError, {
					operation: `history:${operation}Write`,
					sessionId,
					entryId,
				});
				return false;
			}
		});
	}

	/**
	 * Clear all history for a session
	 */
	async clearSession(sessionId: string): Promise<void> {
		// Serialize against queued mutations so the unlink can't land between a
		// pending append and its rotation check (which would resurrect the file).
		await this.writeQueue.enqueue(sessionId, async () => {
			this.appendsSinceRotationCheck.delete(sessionId);
			// Remove the legacy file too, or the next read would "migrate" the
			// history the user just cleared back into place.
			const paths = [this.getSessionFilePath(sessionId), this.getLegacySessionFilePath(sessionId)];
			for (const filePath of paths) {
				try {
					await fsp.unlink(filePath);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === 'ENOENT') continue; // Already gone is fine
					logger.error(`Failed to clear history for session ${sessionId}: ${error}`, LOG_CONTEXT);
					captureException(error, { operation: 'history:clear', sessionId });
				}
			}
			logger.info(`Cleared history for session ${sessionId}`, LOG_CONTEXT);
		});
	}

	/**
	 * List all sessions that have history files.
	 *
	 * Covers both formats and de-duplicates, so a session mid-migration (JSONL
	 * written, legacy not yet retired) is not reported twice.
	 */
	async listSessionsWithHistory(): Promise<string[]> {
		try {
			const files = await fsp.readdir(this.historyDir);
			const sessionIds = new Set<string>();
			for (const file of files) {
				if (file.endsWith(HISTORY_JSONL_EXT)) {
					sessionIds.add(file.slice(0, -HISTORY_JSONL_EXT.length));
				} else if (file.endsWith(HISTORY_LEGACY_JSON_EXT)) {
					sessionIds.add(file.slice(0, -HISTORY_LEGACY_JSON_EXT.length));
				}
			}
			return Array.from(sessionIds);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return [];
			throw error;
		}
	}

	/**
	 * Get the file path for a session's history (for passing to AI as context).
	 * Returns the path if the file exists, null otherwise. Migrates a legacy
	 * session first so the caller always receives a JSONL path.
	 */
	async getHistoryFilePath(sessionId: string): Promise<string | null> {
		const filePath = this.getSessionFilePath(sessionId);
		if (await pathExists(filePath)) return filePath;
		await this.ensureJsonlFile(sessionId);
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
	 *
	 * BEST EFFORT, deliberately. Relabelling old entries is a nicety over the
	 * authoritative name the provider's own session metadata holds, so a session
	 * whose file cannot be read or written is logged and skipped rather than
	 * failing the whole rename. Two consequences follow for callers: the returned
	 * count is the number of entries actually REWRITTEN, so a tab with no history
	 * yet (its `agentSessionId` is stamped at the start of a turn, while the entry
	 * carrying it is written at the end) and a tab already carrying this name both
	 * return 0; and a partial run still returns a nonzero count. Do NOT read the
	 * count as "the rename persisted" - it answers only "how many old labels
	 * changed".
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
			await this.writeQueue.enqueue(sessionId, async () => {
				try {
					const entries = await this.readEntriesInFileOrder(sessionId);
					let perSessionUpdates = 0;

					for (const entry of entries) {
						if (entry.agentSessionId === agentSessionId && entry.sessionName !== sessionName) {
							entry.sessionName = sessionName;
							perSessionUpdates++;
						}
					}

					if (perSessionUpdates > 0) {
						await atomicWriteFile(
							this.getSessionFilePath(sessionId),
							entries.map(serializeHistoryEntryLine).join('')
						);
						updatedCount += perSessionUpdates;
						logger.debug(
							`Updated ${perSessionUpdates} entries for agentSessionId ${agentSessionId} in session ${sessionId}`,
							LOG_CONTEXT
						);
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

		try {
			// Ensure directory exists before watching. mkdirSync with recursive
			// is idempotent and only runs once per app lifetime. It is INSIDE the
			// try because it fails with the same OS-ceiling codes fs.watch does
			// (EMFILE, ENOSPC, EACCES); left outside, one of those would bypass
			// isExpectedWatchError entirely, propagate to the caller in
			// main/index.ts, and report as a history initialization failure - the
			// exact Sentry noise this guard exists to stop.
			fs.mkdirSync(this.historyDir, { recursive: true });

			this.watcher = fs.watch(this.historyDir, (_eventType, filename) => {
				if (filename?.endsWith(HISTORY_JSONL_EXT) || filename?.endsWith(HISTORY_LEGACY_JSON_EXT)) {
					const sessionId = filename.endsWith(HISTORY_JSONL_EXT)
						? filename.slice(0, -HISTORY_JSONL_EXT.length)
						: filename.slice(0, -HISTORY_LEGACY_JSON_EXT.length);
					logger.debug(`History file changed: ${filename}`, LOG_CONTEXT);
					onExternalChange(sessionId);
				}
			});

			// fs.watch emits 'error' when the watched directory becomes unavailable
			// (removed, permission change, network volume disconnect). Without a listener
			// the EventEmitter throws as an unhandled exception and crashes the main process.
			// Expected/recoverable codes get a quiet warn; everything else goes to Sentry
			// so we keep visibility into novel failure modes in production.
			const watcher = this.watcher;
			watcher.on('error', (err) => {
				// Node documents an FSWatcher as unusable once it emits 'error', and
				// says not to call methods on it from the handler - so drop the
				// reference rather than close() it. Without this the dead watcher
				// keeps failing the `if (this.watcher) return` guard above and live
				// refresh never comes back for the rest of the session. Compare
				// identity so a late error from a previous watcher cannot clear a
				// replacement that has already been installed.
				if (this.watcher === watcher) this.watcher = null;

				const code = (err as NodeJS.ErrnoException | undefined)?.code;
				if (isExpectedWatchError(code)) {
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
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (!isExpectedWatchError(code)) {
				void captureException(error, {
					operation: 'history:watch:start',
					historyDir: this.historyDir,
				});
			}
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
