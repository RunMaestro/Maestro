import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { CREATE_META_TABLE_SQL } from './schema';
import {
	getCurrentVersion,
	getMigrationHistory,
	getTargetVersion,
	hasPendingMigrations,
	runMigrations,
} from './migrations';
import { LOG_CONTEXT } from './utils';
import type {
	BackupResult,
	CorruptionRecoveryResult,
	IntegrityCheckResult,
	MigrationRecord,
} from './types';

export interface WorkGraphDBOptions {
	userDataPath?: string;
}

export class WorkGraphDB {
	private db: Database.Database | null = null;
	private dbPath: string;
	private initialized = false;
	private statementCache = new Map<string, Database.Statement>();

	constructor(options: WorkGraphDBOptions = {}) {
		const userDataPath = options.userDataPath ?? app.getPath('userData');
		this.dbPath = path.join(userDataPath, 'work-graph.db');
	}

	get database(): Database.Database {
		if (!this.db) throw new Error('Work Graph database not initialized');
		return this.db;
	}

	initialize(): void {
		if (this.initialized) {
			return;
		}

		try {
			const dir = path.dirname(this.dbPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			if (fs.existsSync(this.dbPath)) {
				const db = this.openWithCorruptionHandling();
				if (!db) {
					throw new Error('Failed to open or recover Work Graph database');
				}
				this.db = db;
			} else {
				this.db = new Database(this.dbPath);
			}

			this.db.pragma('journal_mode = WAL');
			this.db.pragma('foreign_keys = ON');
			this.db.prepare(CREATE_META_TABLE_SQL).run();
			runMigrations(this.db);

			this.initialized = true;
			logger.info(`Work Graph database initialized at ${this.dbPath}`, LOG_CONTEXT);
			this.createDailyBackupIfNeeded();
		} catch (error) {
			logger.error(`Failed to initialize Work Graph database: ${error}`, LOG_CONTEXT);
			throw error;
		}
	}

	close(): void {
		if (this.db) {
			this.clearStatementCache();
			this.db.close();
			this.db = null;
			this.initialized = false;
			logger.info('Work Graph database closed', LOG_CONTEXT);
		}
	}

	isReady(): boolean {
		return this.initialized && this.db !== null;
	}

	getDbPath(): string {
		return this.dbPath;
	}

	getStatement(sql: string): Database.Statement {
		const cached = this.statementCache.get(sql);
		if (cached) {
			return cached;
		}

		const statement = this.database.prepare(sql);
		this.statementCache.set(sql, statement);
		return statement;
	}

	clearStatementCache(): void {
		this.statementCache.clear();
	}

	checkIntegrity(): IntegrityCheckResult {
		if (!this.db) {
			return { ok: false, errors: ['Work Graph database not initialized'] };
		}

		try {
			const result = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;

			if (result.length === 1 && result[0].integrity_check === 'ok') {
				return { ok: true, errors: [] };
			}

			return { ok: false, errors: result.map((row) => row.integrity_check) };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return { ok: false, errors: [errorMessage] };
		}
	}

	backupDatabase(): BackupResult {
		try {
			if (!fs.existsSync(this.dbPath)) {
				return { success: false, error: 'Work Graph database file does not exist' };
			}

			const backupPath = `${this.dbPath}.backup.${Date.now()}`;
			this.safeBackupCopy(backupPath);
			logger.info(`Created Work Graph database backup at ${backupPath}`, LOG_CONTEXT);
			return { success: true, backupPath };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to create Work Graph database backup: ${errorMessage}`, LOG_CONTEXT);
			return { success: false, error: errorMessage };
		}
	}

	getAvailableBackups(): Array<{ path: string; date: string; size: number }> {
		try {
			const dir = path.dirname(this.dbPath);
			const baseName = path.basename(this.dbPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const files = fs.readdirSync(dir);
			const backups: Array<{ path: string; date: string; size: number }> = [];

			for (const file of files) {
				const dailyMatch = file.match(new RegExp(`^${baseName}\\.daily\\.(\\d{4}-\\d{2}-\\d{2})$`));
				if (dailyMatch) {
					const fullPath = path.join(dir, file);
					const stats = fs.statSync(fullPath);
					backups.push({ path: fullPath, date: dailyMatch[1], size: stats.size });
				}

				const timestampMatch = file.match(new RegExp(`^${baseName}\\.backup\\.(\\d+)$`));
				if (timestampMatch) {
					const fullPath = path.join(dir, file);
					const stats = fs.statSync(fullPath);
					const timestamp = parseInt(timestampMatch[1], 10);
					backups.push({
						path: fullPath,
						date: new Date(timestamp).toISOString().split('T')[0],
						size: stats.size,
					});
				}
			}

			return backups.sort((a, b) => b.date.localeCompare(a.date));
		} catch (error) {
			logger.warn(`Failed to list Work Graph backups: ${error}`, LOG_CONTEXT);
			return [];
		}
	}

	restoreFromBackup(backupPath: string): boolean {
		try {
			if (!fs.existsSync(backupPath)) {
				logger.error(`Work Graph backup file does not exist: ${backupPath}`, LOG_CONTEXT);
				return false;
			}

			this.close();
			this.removeWalFiles(this.dbPath);

			if (fs.existsSync(this.dbPath)) {
				fs.unlinkSync(this.dbPath);
			}

			fs.copyFileSync(backupPath, this.dbPath);
			logger.info(`Restored Work Graph database from backup: ${backupPath}`, LOG_CONTEXT);
			return true;
		} catch (error) {
			logger.error(`Failed to restore Work Graph database from backup: ${error}`, LOG_CONTEXT);
			return false;
		}
	}

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

	private safeBackupCopy(destPath: string): void {
		if (this.db) {
			this.db.pragma('wal_checkpoint(TRUNCATE)');
		}
		fs.copyFileSync(this.dbPath, destPath);
	}

	private createDailyBackupIfNeeded(): void {
		try {
			if (!fs.existsSync(this.dbPath)) {
				return;
			}

			const today = new Date().toISOString().split('T')[0];
			const dailyBackupPath = `${this.dbPath}.daily.${today}`;
			if (fs.existsSync(dailyBackupPath)) {
				logger.debug(`Work Graph daily backup already exists for ${today}`, LOG_CONTEXT);
				return;
			}

			this.safeBackupCopy(dailyBackupPath);
			logger.info(`Created Work Graph daily backup: ${dailyBackupPath}`, LOG_CONTEXT);
			this.rotateOldBackups(7);
		} catch (error) {
			logger.warn(`Failed to create Work Graph daily backup: ${error}`, LOG_CONTEXT);
		}
	}

	private rotateOldBackups(keepDays: number): void {
		try {
			const dir = path.dirname(this.dbPath);
			const baseName = path.basename(this.dbPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const cutoffDate = new Date();
			cutoffDate.setDate(cutoffDate.getDate() - keepDays);
			const cutoffStr = cutoffDate.toISOString().split('T')[0];
			let removedCount = 0;

			for (const file of fs.readdirSync(dir)) {
				const dailyMatch = file.match(new RegExp(`^${baseName}\\.daily\\.(\\d{4}-\\d{2}-\\d{2})$`));
				if (dailyMatch && dailyMatch[1] < cutoffStr) {
					fs.unlinkSync(path.join(dir, file));
					removedCount++;
					logger.debug(`Removed old Work Graph daily backup: ${file}`, LOG_CONTEXT);
				}
			}

			if (removedCount > 0) {
				logger.info(`Rotated ${removedCount} old Work Graph daily backup(s)`, LOG_CONTEXT);
			}
		} catch (error) {
			logger.warn(`Failed to rotate Work Graph backups: ${error}`, LOG_CONTEXT);
		}
	}

	private recoverFromCorruption(): CorruptionRecoveryResult {
		logger.warn('Attempting to recover from Work Graph database corruption...', LOG_CONTEXT);

		try {
			this.close();

			if (fs.existsSync(this.dbPath)) {
				const corruptedBackupPath = `${this.dbPath}.corrupted.${Date.now()}`;
				try {
					fs.renameSync(this.dbPath, corruptedBackupPath);
					logger.warn(
						`Corrupted Work Graph database moved to: ${corruptedBackupPath}`,
						LOG_CONTEXT
					);
				} catch {
					logger.error('Failed to backup corrupted Work Graph database', LOG_CONTEXT);
					fs.unlinkSync(this.dbPath);
				}
			}

			this.removeWalFiles(this.dbPath);

			for (const backup of this.getAvailableBackups()) {
				logger.info(`Attempting to restore Work Graph backup: ${backup.path}`, LOG_CONTEXT);
				this.removeWalFiles(backup.path);

				try {
					const testDb = new Database(backup.path, { readonly: true });
					const result = testDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
					testDb.close();

					if (
						result.length === 1 &&
						result[0].integrity_check === 'ok' &&
						this.restoreFromBackup(backup.path)
					) {
						return { recovered: true, backupPath: backup.path, restoredFromBackup: true };
					}
				} catch (error) {
					logger.warn(`Work Graph backup ${backup.path} is unreadable: ${error}`, LOG_CONTEXT);
				}
			}

			logger.warn('No valid Work Graph backup found, will create fresh database', LOG_CONTEXT);
			return { recovered: true, restoredFromBackup: false };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to recover Work Graph database: ${errorMessage}`, LOG_CONTEXT);
			return { recovered: false, error: errorMessage };
		}
	}

	private openWithCorruptionHandling(): Database.Database | null {
		this.removeWalFiles(this.dbPath);

		try {
			const db = new Database(this.dbPath);
			const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;

			if (result.length === 1 && result[0].integrity_check === 'ok') {
				return db;
			}

			logger.error(
				`Work Graph database integrity check failed: ${result.map((row) => row.integrity_check).join(', ')}`,
				LOG_CONTEXT
			);
			db.close();
		} catch (error) {
			logger.error(`Failed to open Work Graph database: ${error}`, LOG_CONTEXT);
		}

		const recoveryResult = this.recoverFromCorruption();
		if (!recoveryResult.recovered) {
			logger.error(
				'Work Graph database corruption recovery failed, creating fresh database',
				LOG_CONTEXT
			);
		}

		try {
			const db = new Database(this.dbPath);
			logger.info('Work Graph database opened after corruption recovery', LOG_CONTEXT);
			return db;
		} catch (error) {
			logger.error(`Failed to create Work Graph database after recovery: ${error}`, LOG_CONTEXT);
			return null;
		}
	}

	private removeWalFiles(dbFilePath: string): void {
		try {
			for (const sidecarPath of [`${dbFilePath}-wal`, `${dbFilePath}-shm`]) {
				if (fs.existsSync(sidecarPath)) {
					fs.unlinkSync(sidecarPath);
					logger.debug(`Removed stale Work Graph SQLite sidecar file: ${sidecarPath}`, LOG_CONTEXT);
				}
			}
		} catch (error) {
			logger.warn(
				`Failed to remove Work Graph SQLite sidecar files for ${dbFilePath}: ${error}`,
				LOG_CONTEXT
			);
		}
	}
}
