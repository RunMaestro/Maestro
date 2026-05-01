import type Database from 'better-sqlite3';

export interface IntegrityCheckResult {
	ok: boolean;
	errors: string[];
}

export interface BackupResult {
	success: boolean;
	backupPath?: string;
	error?: string;
}

export interface CorruptionRecoveryResult {
	recovered: boolean;
	backupPath?: string;
	restoredFromBackup?: boolean;
	error?: string;
}

export interface Migration {
	version: number;
	description: string;
	up: (db: Database.Database) => void;
}

export interface MigrationRecord {
	version: number;
	description: string;
	appliedAt: number;
	status: 'success' | 'failed';
	errorMessage?: string;
}

export interface MigrationRecordRow {
	version: number;
	description: string;
	applied_at: number;
	status: 'success' | 'failed';
	error_message: string | null;
}
