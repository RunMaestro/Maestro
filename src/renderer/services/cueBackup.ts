/**
 * Cue backup IPC service.
 *
 * Wraps window.maestro.cueBackup.* with consistent error handling. Read
 * methods return safe defaults on failure; write methods rethrow so the UI
 * can surface failures via toast.
 */

import type {
	CueBackupDiffStatusMap,
	CueBackupManifest,
	CueBackupRestoreResult,
	CueBackupSummary,
} from '../../shared/cue-backup-types';
import { createIpcMethod } from './ipcWrapper';

export const cueBackupService = {
	create(): Promise<CueBackupSummary> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.create(),
			errorContext: 'CueBackup create',
			rethrow: true,
		});
	},

	list(): Promise<CueBackupSummary[]> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.list(),
			errorContext: 'CueBackup list',
			defaultValue: [] as CueBackupSummary[],
		});
	},

	inspect(filePath: string): Promise<CueBackupManifest | null> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.inspect(filePath),
			errorContext: 'CueBackup inspect',
			defaultValue: null as CueBackupManifest | null,
		});
	},

	readFile(filePath: string, workspaceId: string, relativePath: string): Promise<string | null> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.readFile(filePath, workspaceId, relativePath),
			errorContext: 'CueBackup readFile',
			defaultValue: null,
		});
	},

	readLive(cwd: string, relativePath: string): Promise<string | null> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.readLive(cwd, relativePath),
			errorContext: 'CueBackup readLive',
			defaultValue: null,
		});
	},

	restoreFile(filePath: string, workspaceId: string, relativePath: string): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.restoreFile(filePath, workspaceId, relativePath),
			errorContext: 'CueBackup restoreFile',
			rethrow: true,
		});
	},

	restoreAll(filePath: string): Promise<CueBackupRestoreResult> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.restoreAll(filePath),
			errorContext: 'CueBackup restoreAll',
			rethrow: true,
		});
	},

	getDiffStatus(filePath: string): Promise<CueBackupDiffStatusMap> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.getDiffStatus(filePath),
			errorContext: 'CueBackup getDiffStatus',
			defaultValue: {} as CueBackupDiffStatusMap,
		});
	},

	delete(filePath: string): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cueBackup.delete(filePath),
			errorContext: 'CueBackup delete',
			rethrow: true,
		});
	},
};
