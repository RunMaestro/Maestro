/**
 * Stats Database Core Class
 *
 * Manages the SQLite database lifecycle: initialization, integrity checks,
 * corruption recovery, VACUUM scheduling, and connection management.
 *
 * CRUD operations are delegated to focused modules (query-events, auto-run,
 * session-lifecycle, aggregations, data-management).
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { logger } from '../utils/logger';
import type {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
	StatsTimeRange,
	StatsFilters,
	StatsAggregation,
} from '../../shared/stats-types';
import type {
	IntegrityCheckResult,
	BackupResult,
	CorruptionRecoveryResult,
	MigrationRecord,
} from './types';
import { LOG_CONTEXT } from './utils';
import { CREATE_META_TABLE_SQL } from './schema';
import {
	runMigrations,
	getMigrationHistory,
	getCurrentVersion,
	getTargetVersion,
	hasPendingMigrations,
} from './migrations';
import { insertQueryEvent, getQueryEvents, clearQueryEventCache } from './query-events';
import {
	insertAutoRunSession,
	updateAutoRunSession,
	getAutoRunSessions,
	insertAutoRunTask,
	getAutoRunTasks,
	clearAutoRunCache,
} from './auto-run';
import {
	recordSessionCreated,
	recordSessionClosed,
	getSessionLifecycleEvents,
	clearSessionLifecycleCache,
} from './session-lifecycle';
import { getAggregatedStats } from './aggregations';
import { clearOldData, exportToCsv } from './data-management';

/**
 * StatsDB manages the SQLite database for usage statistics.
 */
export class StatsDB {
	private db: Database.Database | null = null;
	private dbPath: string;
	private initialized = false;

	constructor() {
		this.dbPath = path.join(app.getPath('userData'), 'stats.db');
	}

	// ============================================================================
	// Database Accessor
	// ============================================================================

	/**
	 * Get the underlying database handle, throwing if not initialized.
	 * Replaces the repeated `if (!this.db) throw` guard clauses.
	 */
	get database(): Database.Database {
		if (!this.db) throw new Error('Database not initialized');
		return this.db;
	}

	// ============================================================================
	// Lifecycle
	// ============================================================================

	/**
	 * Initialize the database - create file, tables, and indexes.
	 *
	 * If the database is corrupted, this method will:
	 * 1. Backup the corrupted database file
	 * 2. Delete the corrupted file and any associated WAL/SHM files
	 * 3. Create a fresh database
	 */
	initialize(): void {
		if (this.initialized) {
			return;
		}

		try {
			const dir = path.dirname(this.dbPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			const dbExists = fs.existsSync(this.dbPath);

			if (dbExists) {
				const db = this.openWithCorruptionHandling();
				if (!db) {
					throw new Error('Failed to open or recover database');
				}
				this.db = db;
			} else {
				this.db = new Database(this.dbPath);
			}

			// Enable WAL mode for better concurrent access
			this.db.pragma('journal_mode = WAL');

			// Create the _meta table for internal key-value storage
			this.db.prepare(CREATE_META_TABLE_SQL).run();

			// Run migrations
			runMigrations(this.db);

			this.initialized = true;
			logger.info(`Stats database initialized at ${this.dbPath}`, LOG_CONTEXT);

			// Create daily backup (keeps last 7 days)
			this.createDailyBackupIfNeeded();

			// Schedule VACUUM to run weekly instead of on every startup
			this.vacuumIfNeededWeekly();
		} catch (error) {
			logger.error(`Failed to initialize stats database: ${error}`, LOG_CONTEXT);
			throw error;
		}
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
			this.initialized = false;

			// Clear all statement caches
			clearQueryEventCache();
			clearAutoRunCache();
			clearSessionLifecycleCache();

			logger.info('Stats database closed', LOG_CONTEXT);
		}
	}

	/**
	 * Check if database is initialized and ready
	 */
	isReady(): boolean {
		return this.initialized && this.db !== null;
	}

	/**
	 * Get the database file path
	 */
	getDbPath(): string {
		return this.dbPath;
	}

	/**
	 * Get the database file size in bytes.
	 */
	getDatabaseSize(): number {
		try {
			const stats = fs.statSync(this.dbPath);
			return stats.size;
		} catch {
			return 0;
		}
	}

	// ============================================================================
	// VACUUM
	// ============================================================================

	/**
	 * Run VACUUM on the database to reclaim unused space and optimize structure.
	 */
	vacuum(): { success: boolean; bytesFreed: number; error?: string } {
		if (!this.db) {
			return { success: false, bytesFreed: 0, error: 'Database not initialized' };
		}

		try {
			const sizeBefore = this.getDatabaseSize();
			logger.info(
				`Starting VACUUM (current size: ${(sizeBefore / 1024 / 1024).toFixed(2)} MB)`,
				LOG_CONTEXT
			);

			this.db.prepare('VACUUM').run();

			const sizeAfter = this.getDatabaseSize();
			const bytesFreed = sizeBefore - sizeAfter;

			logger.info(
				`VACUUM completed: ${(sizeBefore / 1024 / 1024).toFixed(2)} MB -> ${(sizeAfter / 1024 / 1024).toFixed(2)} MB (freed ${(bytesFreed / 1024 / 1024).toFixed(2)} MB)`,
				LOG_CONTEXT
			);

			return { success: true, bytesFreed };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`VACUUM failed: ${errorMessage}`, LOG_CONTEXT);
			return { success: false, bytesFreed: 0, error: errorMessage };
		}
	}

	/**
	 * Conditionally vacuum the database if it exceeds a size threshold.
	 *
	 * @param thresholdBytes - Size threshold in bytes (default: 100MB)
	 */
	vacuumIfNeeded(thresholdBytes: number = 100 * 1024 * 1024): {
		vacuumed: boolean;
		databaseSize: number;
		result?: { success: boolean; bytesFreed: number; error?: string };
	} {
		const databaseSize = this.getDatabaseSize();

		if (databaseSize < thresholdBytes) {
			logger.debug(
				`Database size (${(databaseSize / 1024 / 1024).toFixed(2)} MB) below vacuum threshold (${(thresholdBytes / 1024 / 1024).toFixed(2)} MB), skipping VACUUM`,
				LOG_CONTEXT
			);
			return { vacuumed: false, databaseSize };
		}

		logger.info(
			`Database size (${(databaseSize / 1024 / 1024).toFixed(2)} MB) exceeds vacuum threshold (${(thresholdBytes / 1024 / 1024).toFixed(2)} MB), running VACUUM`,
			LOG_CONTEXT
		);

		const result = this.vacuum();
		return { vacuumed: true, databaseSize, result };
	}

	/**
	 * Run VACUUM only if it hasn't been run in the last 7 days.
	 *
	 * Stores the last vacuum timestamp in the database's _meta table
	 * instead of an external file.
	 *
	 * @param intervalMs - Minimum time between vacuums (default: 7 days)
	 */
	private vacuumIfNeededWeekly(intervalMs: number = 7 * 24 * 60 * 60 * 1000): void {
		try {
			// Read last vacuum timestamp from _meta table
			const row = this.database
				.prepare("SELECT value FROM _meta WHERE key = 'last_vacuum_at'")
				.get() as { value: string } | undefined;

			const lastVacuum = row ? parseInt(row.value, 10) || 0 : 0;
			const now = Date.now();
			const timeSinceLastVacuum = now - lastVacuum;

			if (timeSinceLastVacuum < intervalMs) {
				const daysRemaining = ((intervalMs - timeSinceLastVacuum) / (24 * 60 * 60 * 1000)).toFixed(
					1
				);
				logger.debug(
					`Skipping VACUUM (last run ${((now - lastVacuum) / (24 * 60 * 60 * 1000)).toFixed(1)} days ago, next in ${daysRemaining} days)`,
					LOG_CONTEXT
				);
				return;
			}

			// Run VACUUM if database is large enough
			const result = this.vacuumIfNeeded();

			if (result.vacuumed) {
				// Update timestamp in _meta table
				this.database
					.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('last_vacuum_at', ?)")
					.run(String(now));
				logger.info('Updated VACUUM timestamp in _meta table', LOG_CONTEXT);
			}
		} catch (error) {
			// Non-fatal - log and continue
			logger.warn(`Failed to check/update VACUUM schedule: ${error}`, LOG_CONTEXT);
		}
	}

	// ============================================================================
	// Integrity & Corruption Handling
	// ============================================================================

	/**
	 * Check the integrity of the database using SQLite's PRAGMA integrity_check.
	 */
	checkIntegrity(): IntegrityCheckResult {
		if (!this.db) {
			return { ok: false, errors: ['Database not initialized'] };
		}

		try {
			const result = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;

			if (result.length === 1 && result[0].integrity_check === 'ok') {
				return { ok: true, errors: [] };
			}

			const errors = result.map((row) => row.integrity_check);
			return { ok: false, errors };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return { ok: false, errors: [errorMessage] };
		}
	}

	/**
	 * Create a backup of the current database file.
	 */
	backupDatabase(): BackupResult {
		try {
			if (!fs.existsSync(this.dbPath)) {
				return { success: false, error: 'Database file does not exist' };
			}

			const timestamp = Date.now();
			const backupPath = `${this.dbPath}.backup.${timestamp}`;

			fs.copyFileSync(this.dbPath, backupPath);

			logger.info(`Created database backup at ${backupPath}`, LOG_CONTEXT);
			return { success: true, backupPath };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to create database backup: ${errorMessage}`, LOG_CONTEXT);
			return { success: false, error: errorMessage };
		}
	}

	// ============================================================================
	// Daily Backup System
	// ============================================================================

	/**
	 * Create a daily backup if one hasn't been created today.
	 * Automatically rotates old backups to keep only the last 7 days.
	 */
	private createDailyBackupIfNeeded(): void {
		try {
			if (!fs.existsSync(this.dbPath)) {
				return;
			}

			const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
			const dailyBackupPath = `${this.dbPath}.daily.${today}`;

			// Check if today's backup already exists
			if (fs.existsSync(dailyBackupPath)) {
				logger.debug(`Daily backup already exists for ${today}`, LOG_CONTEXT);
				return;
			}

			// Create today's backup
			fs.copyFileSync(this.dbPath, dailyBackupPath);
			logger.info(`Created daily backup: ${dailyBackupPath}`, LOG_CONTEXT);

			// Rotate old backups (keep last 7 days)
			this.rotateOldBackups(7);
		} catch (error) {
			logger.warn(`Failed to create daily backup: ${error}`, LOG_CONTEXT);
		}
	}

	/**
	 * Remove daily backups older than the specified number of days.
	 */
	private rotateOldBackups(keepDays: number): void {
		try {
			const dir = path.dirname(this.dbPath);
			const baseName = path.basename(this.dbPath);
			const files = fs.readdirSync(dir);

			const cutoffDate = new Date();
			cutoffDate.setDate(cutoffDate.getDate() - keepDays);
			const cutoffStr = cutoffDate.toISOString().split('T')[0];

			let removedCount = 0;
			for (const file of files) {
				// Match daily backup pattern: stats.db.daily.YYYY-MM-DD
				const dailyMatch = file.match(new RegExp(`^${baseName}\\.daily\\.(\\d{4}-\\d{2}-\\d{2})$`));
				if (dailyMatch) {
					const backupDate = dailyMatch[1];
					if (backupDate < cutoffStr) {
						const fullPath = path.join(dir, file);
						fs.unlinkSync(fullPath);
						removedCount++;
						logger.debug(`Removed old daily backup: ${file}`, LOG_CONTEXT);
					}
				}
			}

			if (removedCount > 0) {
				logger.info(`Rotated ${removedCount} old daily backup(s)`, LOG_CONTEXT);
			}
		} catch (error) {
			logger.warn(`Failed to rotate old backups: ${error}`, LOG_CONTEXT);
		}
	}

	/**
	 * Get available daily backups sorted by date (newest first).
	 */
	getAvailableBackups(): Array<{ path: string; date: string; size: number }> {
		try {
			const dir = path.dirname(this.dbPath);
			const baseName = path.basename(this.dbPath);
			const files = fs.readdirSync(dir);
			const backups: Array<{ path: string; date: string; size: number }> = [];

			for (const file of files) {
				// Match daily backup pattern
				const dailyMatch = file.match(new RegExp(`^${baseName}\\.daily\\.(\\d{4}-\\d{2}-\\d{2})$`));
				if (dailyMatch) {
					const fullPath = path.join(dir, file);
					const stats = fs.statSync(fullPath);
					backups.push({
						path: fullPath,
						date: dailyMatch[1],
						size: stats.size,
					});
				}

				// Also include timestamp-based backups (legacy format)
				const timestampMatch = file.match(new RegExp(`^${baseName}\\.backup\\.(\\d+)$`));
				if (timestampMatch) {
					const fullPath = path.join(dir, file);
					const stats = fs.statSync(fullPath);
					const timestamp = parseInt(timestampMatch[1], 10);
					const date = new Date(timestamp).toISOString().split('T')[0];
					backups.push({
						path: fullPath,
						date: date,
						size: stats.size,
					});
				}
			}

			// Sort by date descending (newest first)
			return backups.sort((a, b) => b.date.localeCompare(a.date));
		} catch (error) {
			logger.warn(`Failed to list backups: ${error}`, LOG_CONTEXT);
			return [];
		}
	}

	/**
	 * Restore database from a backup file.
	 * Returns true if restoration was successful.
	 */
	restoreFromBackup(backupPath: string): boolean {
		try {
			if (!fs.existsSync(backupPath)) {
				logger.error(`Backup file does not exist: ${backupPath}`, LOG_CONTEXT);
				return false;
			}

			// Close current database if open
			if (this.db) {
				try {
					this.db.close();
				} catch {
					// Ignore errors closing database
				}
				this.db = null;
				this.initialized = false;
			}

			// Remove WAL and SHM files if they exist
			const walPath = `${this.dbPath}-wal`;
			const shmPath = `${this.dbPath}-shm`;
			if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
			if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

			// Remove current database if it exists
			if (fs.existsSync(this.dbPath)) {
				fs.unlinkSync(this.dbPath);
			}

			// Copy backup to main database path
			fs.copyFileSync(backupPath, this.dbPath);
			logger.info(`Restored database from backup: ${backupPath}`, LOG_CONTEXT);

			return true;
		} catch (error) {
			logger.error(`Failed to restore from backup: ${error}`, LOG_CONTEXT);
			return false;
		}
	}

	/**
	 * Handle a corrupted database by attempting to restore from the latest backup.
	 * If no backup is available, creates a fresh database.
	 */
	private recoverFromCorruption(): CorruptionRecoveryResult {
		logger.warn('Attempting to recover from database corruption...', LOG_CONTEXT);

		try {
			// Close current database if open
			if (this.db) {
				try {
					this.db.close();
				} catch {
					// Ignore errors closing corrupted database
				}
				this.db = null;
				this.initialized = false;
			}

			// First, backup the corrupted database for forensics
			if (fs.existsSync(this.dbPath)) {
				const timestamp = Date.now();
				const corruptedBackupPath = `${this.dbPath}.corrupted.${timestamp}`;
				try {
					fs.renameSync(this.dbPath, corruptedBackupPath);
					logger.warn(`Corrupted database moved to: ${corruptedBackupPath}`, LOG_CONTEXT);
				} catch {
					logger.error('Failed to backup corrupted database', LOG_CONTEXT);
					fs.unlinkSync(this.dbPath);
				}
			}

			// Delete WAL and SHM files
			const walPath = `${this.dbPath}-wal`;
			const shmPath = `${this.dbPath}-shm`;
			if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
			if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

			// Try to restore from the latest backup
			const backups = this.getAvailableBackups();
			for (const backup of backups) {
				logger.info(`Attempting to restore from backup: ${backup.path} (${backup.date})`, LOG_CONTEXT);

				// Try to validate the backup before restoring
				try {
					const testDb = new Database(backup.path, { readonly: true });
					const result = testDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
					testDb.close();

					if (result.length === 1 && result[0].integrity_check === 'ok') {
						// Backup is valid, restore it
						if (this.restoreFromBackup(backup.path)) {
							logger.info(`Successfully restored database from backup: ${backup.date}`, LOG_CONTEXT);
							return {
								recovered: true,
								backupPath: backup.path,
								restoredFromBackup: true,
							};
						}
					} else {
						logger.warn(`Backup ${backup.date} failed integrity check, trying next...`, LOG_CONTEXT);
					}
				} catch (error) {
					logger.warn(`Backup ${backup.date} is unreadable: ${error}, trying next...`, LOG_CONTEXT);
				}
			}

			// No valid backup found, will create fresh database
			logger.warn('No valid backup found, will create fresh database', LOG_CONTEXT);
			return {
				recovered: true,
				restoredFromBackup: false,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to recover from database corruption: ${errorMessage}`, LOG_CONTEXT);
			return {
				recovered: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Attempt to open and validate a database, handling corruption if detected.
	 */
	private openWithCorruptionHandling(): Database.Database | null {
		try {
			const db = new Database(this.dbPath);

			const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
			if (result.length === 1 && result[0].integrity_check === 'ok') {
				return db;
			}

			const errors = result.map((row) => row.integrity_check);
			logger.error(`Database integrity check failed: ${errors.join(', ')}`, LOG_CONTEXT);

			db.close();
		} catch (error) {
			logger.error(`Failed to open database: ${error}`, LOG_CONTEXT);
		}

		const recoveryResult = this.recoverFromCorruption();
		if (!recoveryResult.recovered) {
			logger.error('Database corruption recovery failed', LOG_CONTEXT);
			return null;
		}

		try {
			const db = new Database(this.dbPath);
			logger.info('Fresh database created after corruption recovery', LOG_CONTEXT);
			return db;
		} catch (error) {
			logger.error(`Failed to create fresh database after recovery: ${error}`, LOG_CONTEXT);
			return null;
		}
	}

	// ============================================================================
	// Migration Queries (delegated)
	// ============================================================================

	getMigrationHistory(): MigrationRecord[] {
		return getMigrationHistory(this.database);
	}

	getCurrentVersion(): number {
		return getCurrentVersion(this.database);
	}

	getTargetVersion(): number {
		return getTargetVersion();
	}

	hasPendingMigrations(): boolean {
		return hasPendingMigrations(this.database);
	}

	// ============================================================================
	// Query Events (delegated)
	// ============================================================================

	insertQueryEvent(event: Omit<QueryEvent, 'id'>): string {
		return insertQueryEvent(this.database, event);
	}

	getQueryEvents(range: StatsTimeRange, filters?: StatsFilters): QueryEvent[] {
		return getQueryEvents(this.database, range, filters);
	}

	// ============================================================================
	// Auto Run (delegated)
	// ============================================================================

	insertAutoRunSession(session: Omit<AutoRunSession, 'id'>): string {
		return insertAutoRunSession(this.database, session);
	}

	updateAutoRunSession(id: string, updates: Partial<AutoRunSession>): boolean {
		return updateAutoRunSession(this.database, id, updates);
	}

	getAutoRunSessions(range: StatsTimeRange): AutoRunSession[] {
		return getAutoRunSessions(this.database, range);
	}

	insertAutoRunTask(task: Omit<AutoRunTask, 'id'>): string {
		return insertAutoRunTask(this.database, task);
	}

	getAutoRunTasks(autoRunSessionId: string): AutoRunTask[] {
		return getAutoRunTasks(this.database, autoRunSessionId);
	}

	// ============================================================================
	// Session Lifecycle (delegated)
	// ============================================================================

	recordSessionCreated(event: Omit<SessionLifecycleEvent, 'id' | 'closedAt' | 'duration'>): string {
		return recordSessionCreated(this.database, event);
	}

	recordSessionClosed(sessionId: string, closedAt: number): boolean {
		return recordSessionClosed(this.database, sessionId, closedAt);
	}

	getSessionLifecycleEvents(range: StatsTimeRange): SessionLifecycleEvent[] {
		return getSessionLifecycleEvents(this.database, range);
	}

	// ============================================================================
	// Aggregations (delegated)
	// ============================================================================

	getAggregatedStats(range: StatsTimeRange): StatsAggregation {
		return getAggregatedStats(this.database, range);
	}

	// ============================================================================
	// Data Management (delegated)
	// ============================================================================

	clearOldData(olderThanDays: number) {
		if (!this.db) {
			return {
				success: false,
				deletedQueryEvents: 0,
				deletedAutoRunSessions: 0,
				deletedAutoRunTasks: 0,
				deletedSessionLifecycle: 0,
				error: 'Database not initialized',
			};
		}
		return clearOldData(this.database, olderThanDays);
	}

	exportToCsv(range: StatsTimeRange): string {
		return exportToCsv(this.database, range);
	}

	// ============================================================================
	// Timestamps
	// ============================================================================

	/**
	 * Get the earliest timestamp across all stats tables.
	 * Returns null if no stats data exists.
	 */
	getEarliestTimestamp(): number | null {
		try {
			// Query the minimum startTime from query_events table
			const queryResult = this.database
				.prepare('SELECT MIN(startTime) as earliest FROM query_events')
				.get() as { earliest: number | null } | undefined;

			// Query the minimum startTime from auto_run_sessions table
			const autoRunResult = this.database
				.prepare('SELECT MIN(startTime) as earliest FROM auto_run_sessions')
				.get() as { earliest: number | null } | undefined;

			// Query the minimum createdAt from session_lifecycle table
			const lifecycleResult = this.database
				.prepare('SELECT MIN(createdAt) as earliest FROM session_lifecycle')
				.get() as { earliest: number | null } | undefined;

			// Find the minimum across all tables
			const timestamps = [
				queryResult?.earliest,
				autoRunResult?.earliest,
				lifecycleResult?.earliest,
			].filter((t): t is number => t !== null && t !== undefined);

			if (timestamps.length === 0) {
				return null;
			}

			return Math.min(...timestamps);
		} catch (error) {
			logger.error(`Failed to get earliest timestamp: ${error}`, LOG_CONTEXT);
			return null;
		}
	}
}
