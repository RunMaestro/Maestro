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
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';
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
const fsPromises = fs.promises;

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
		if (!(await this.fileExists(this.historyDir))) {
			await fsPromises.mkdir(this.historyDir, { recursive: true });
			logger.debug('Created history directory', LOG_CONTEXT);
		}

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
		if (await this.fileExists(this.migrationMarkerPath)) {
			return false;
		}

		// If legacy file exists with entries, need to migrate
		if (await this.fileExists(this.legacyFilePath)) {
			try {
				const data = JSON.parse(await fsPromises.readFile(this.legacyFilePath, 'utf-8'));
				return data.entries && data.entries.length > 0;
			} catch {
				return false;
			}
		}

		return false;
	}

	/**
	 * Check if migration has been completed
	 */
	hasMigrated(): boolean {
		return fs.existsSync(this.migrationMarkerPath);
	}

	/**
	 * Migrate entries from legacy single-file format to per-session files
	 */
	private async migrateFromLegacy(): Promise<void> {
		logger.info('Starting history migration from legacy format', LOG_CONTEXT);

		try {
			const legacyData = JSON.parse(await fsPromises.readFile(this.legacyFilePath, 'utf-8'));
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

			// Write per-session files
			let sessionsMigrated = 0;
			for (const [sessionId, sessionEntries] of entriesBySession) {
				const projectPath = sessionEntries[0]?.projectPath || '';
				const fileData: HistoryFileData = {
					version: HISTORY_VERSION,
					sessionId,
					projectPath,
					entries: sessionEntries.slice(0, MAX_ENTRIES_PER_SESSION),
				};
				const filePath = this.getSessionFilePath(sessionId);
				await fsPromises.writeFile(filePath, JSON.stringify(fileData, null, 2), 'utf-8');
				sessionsMigrated++;
				logger.debug(
					`Migrated ${sessionEntries.length} entries for session ${sessionId}`,
					LOG_CONTEXT
				);
			}

			// Write migration marker
			const marker: MigrationMarker = {
				migratedAt: Date.now(),
				version: HISTORY_VERSION,
				legacyEntryCount: entries.length,
				sessionsMigrated,
			};
			await fsPromises.writeFile(
				this.migrationMarkerPath,
				JSON.stringify(marker, null, 2),
				'utf-8'
			);

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

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await fsPromises.access(filePath, fs.constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Read history for a specific session
	 */
	async getEntries(sessionId: string): Promise<HistoryEntry[]> {
		const filePath = this.getSessionFilePath(sessionId);
		if (!(await this.fileExists(filePath))) {
			return [];
		}
		try {
			const data: HistoryFileData = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
			return data.entries || [];
		} catch (error) {
			logger.warn(`Failed to read history for session ${sessionId}: ${error}`, LOG_CONTEXT);
			captureException(error, { operation: 'history:read', sessionId });
			return [];
		}
	}

	/**
	 * Add an entry to a session's history
	 */
	async addEntry(sessionId: string, projectPath: string, entry: HistoryEntry): Promise<void> {
		const filePath = this.getSessionFilePath(sessionId);
		let data: HistoryFileData;

		if (await this.fileExists(filePath)) {
			try {
				data = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
			} catch {
				data = { version: HISTORY_VERSION, sessionId, projectPath, entries: [] };
			}
		} else {
			data = { version: HISTORY_VERSION, sessionId, projectPath, entries: [] };
		}

		// Add to beginning (most recent first)
		data.entries.unshift(entry);

		// Trim to max entries
		if (data.entries.length > MAX_ENTRIES_PER_SESSION) {
			data.entries = data.entries.slice(0, MAX_ENTRIES_PER_SESSION);
		}

		// Update projectPath if it changed
		data.projectPath = projectPath;

		try {
			await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
			logger.debug(`Added history entry for session ${sessionId}`, LOG_CONTEXT);
		} catch (error) {
			logger.error(`Failed to write history for session ${sessionId}: ${error}`, LOG_CONTEXT);
			captureException(error, { operation: 'history:write', sessionId });
		}
	}

	/**
	 * Delete a specific entry from a session's history
	 */
	async deleteEntry(sessionId: string, entryId: string): Promise<boolean> {
		const filePath = this.getSessionFilePath(sessionId);
		if (!(await this.fileExists(filePath))) {
			return false;
		}

		try {
			const data: HistoryFileData = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
			const originalLength = data.entries.length;
			data.entries = data.entries.filter((e) => e.id !== entryId);

			if (data.entries.length === originalLength) {
				return false; // Entry not found
			}

			try {
				await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
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
		if (!(await this.fileExists(filePath))) {
			return false;
		}

		try {
			const data: HistoryFileData = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
			const index = data.entries.findIndex((e) => e.id === entryId);

			if (index === -1) {
				return false;
			}

			data.entries[index] = { ...data.entries[index], ...updates };
			try {
				await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
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
	}

	/**
	 * Clear all history for a session
	 */
	async clearSession(sessionId: string): Promise<void> {
		const filePath = this.getSessionFilePath(sessionId);
		if (!(await this.fileExists(filePath))) {
			return;
		}
		try {
			await fsPromises.unlink(filePath);
			logger.info(`Cleared history for session ${sessionId}`, LOG_CONTEXT);
		} catch (error) {
			logger.error(`Failed to clear history for session ${sessionId}: ${error}`, LOG_CONTEXT);
			captureException(error, { operation: 'history:clear', sessionId });
		}
	}

	/**
	 * List all sessions that have history files
	 */
	async listSessionsWithHistory(): Promise<string[]> {
		try {
			if (!(await this.fileExists(this.historyDir))) {
				return [];
			}
			return (await fsPromises.readdir(this.historyDir))
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.replace('.json', ''));
		} catch (error) {
			logger.warn(`Failed to list sessions with history: ${error}`, LOG_CONTEXT);
			return [];
		}
	}

	/**
	 * Get the file path for a session's history (for passing to AI as context)
	 */
	getHistoryFilePath(sessionId: string): string | null {
		const filePath = this.getSessionFilePath(sessionId);
		return fs.existsSync(filePath) ? filePath : null;
	}

	/**
	 * Get all entries across all sessions (for cross-session views)
	 * Returns entries sorted by timestamp (most recent first)
	 * @deprecated Use getAllEntriesPaginated for large datasets
	 */
	async getAllEntries(limit?: number): Promise<HistoryEntry[]> {
		const sessions = await this.listSessionsWithHistory();
		const allEntriesArrays = await Promise.all(sessions.map((sessionId) => this.getEntries(sessionId)));
		const allEntries = allEntriesArrays.reduce<HistoryEntry[]>((acc, entries) => {
			acc.push(...entries);
			return acc;
		}, []);

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
		const allEntriesArrays = await Promise.all(sessions.map((sessionId) => this.getEntries(sessionId)));
		const allEntries = allEntriesArrays.reduce<HistoryEntry[]>((acc, entries) => {
			acc.push(...entries);
			return acc;
		}, []);

		const sorted = sortEntriesByTimestamp(allEntries);
		return paginateEntries(sorted, options);
	}

	/**
	 * Get entries filtered by project path
	 * @deprecated Use getEntriesByProjectPathPaginated for large datasets
	 */
	async getEntriesByProjectPath(projectPath: string): Promise<HistoryEntry[]> {
		const sessions = await this.listSessionsWithHistory();
		const sessionEntriesList = await Promise.all(sessions.map((sessionId) => this.getEntries(sessionId)));
		const entries: HistoryEntry[] = [];

		for (const sessionEntries of sessionEntriesList) {
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
		const sessions = await this.listSessionsWithHistory();
		const sessionEntriesList = await Promise.all(sessions.map((sessionId) => this.getEntries(sessionId)));
		const entries: HistoryEntry[] = [];

		for (const sessionEntries of sessionEntriesList) {
			if (sessionEntries.length > 0 && sessionEntries[0].projectPath === projectPath) {
				entries.push(...sessionEntries);
			}
		}

		const sorted = sortEntriesByTimestamp(entries);
		return paginateEntries(sorted, options);
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
		const sessionDataList = await Promise.all(
			sessions.map(async (sessionId) => {
				const filePath = this.getSessionFilePath(sessionId);
				try {
					const data: HistoryFileData = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
					return { sessionId, filePath, data };
				} catch (error) {
					logger.warn(`Failed to read session ${sessionId} while updating names: ${error}`, LOG_CONTEXT);
					captureException(error, { operation: 'history:updateSessionNameRead', sessionId });
					return null;
				}
			})
		);

		let updatedCount = 0;
		for (const sessionData of sessionDataList) {
			if (!sessionData) continue;
			const { sessionId, filePath, data } = sessionData;
			let modified = false;
			for (const entry of data.entries) {
				if (entry.agentSessionId === agentSessionId && entry.sessionName !== sessionName) {
					entry.sessionName = sessionName;
					modified = true;
					updatedCount++;
				}
			}
			if (modified) {
				try {
					await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
					logger.debug(
						`Updated ${updatedCount} entries for agentSessionId ${agentSessionId} in session ${sessionId}`,
						LOG_CONTEXT
					);
				} catch (error) {
					logger.warn(`Failed to write updates for session ${sessionId}: ${error}`, LOG_CONTEXT);
					captureException(error, { operation: 'history:updateSessionNameWrite', sessionId });
				}
				break; // Stop scanning once the target session is updated
			}
		}

		return updatedCount;
	}

	/**
	 * Clear all sessions for a specific project
	 */
	async clearByProjectPath(projectPath: string): Promise<void> {
		const sessions = await this.listSessionsWithHistory();
		for (const sessionId of sessions) {
			const entries = await this.getEntries(sessionId);
			if (entries.length > 0 && entries[0].projectPath === projectPath) {
				await this.clearSession(sessionId);
			}
		}
	}

	/**
	 * Clear all history (all session files)
	 */
	async clearAll(): Promise<void> {
		const sessions = await this.listSessionsWithHistory();
		for (const sessionId of sessions) {
			await this.clearSession(sessionId);
		}
		logger.info('Cleared all history', LOG_CONTEXT);
	}

	/**
	 * Start watching the history directory for external changes.
	 * Dispatches events with the affected sessionId so renderers can
	 * decide whether to reload.
	 */
	startWatching(onExternalChange: (sessionId: string) => void): void {
		if (this.watcher) return; // Already watching

		// Ensure directory exists before watching
		if (!fs.existsSync(this.historyDir)) {
			fs.mkdirSync(this.historyDir, { recursive: true });
		}

		this.watcher = fs.watch(this.historyDir, (_eventType, filename) => {
			if (filename?.endsWith('.json')) {
				const sessionId = filename.replace('.json', '');
				logger.debug(`History file changed: ${filename}`, LOG_CONTEXT);
				onExternalChange(sessionId);
			}
		});

		logger.info('Started watching history directory', LOG_CONTEXT);
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
