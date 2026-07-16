/**
 * Preload API for Cue backup operations
 *
 * Exposes window.maestro.cueBackup.* - create, list, inspect, read file
 * (from zip or live disk), restore single file, restore everything, delete.
 */

import { ipcRenderer } from 'electron';
import type {
	CueBackupDiffStatusMap,
	CueBackupManifest,
	CueBackupRestoreResult,
	CueBackupSummary,
} from '../../shared/cue-backup-types';

export function createCueBackupApi() {
	return {
		create: (): Promise<CueBackupSummary> => ipcRenderer.invoke('cueBackup:create'),

		list: (): Promise<CueBackupSummary[]> => ipcRenderer.invoke('cueBackup:list'),

		inspect: (filePath: string): Promise<CueBackupManifest> =>
			ipcRenderer.invoke('cueBackup:inspect', { filePath }),

		readFile: (
			filePath: string,
			workspaceId: string,
			relativePath: string
		): Promise<string | null> =>
			ipcRenderer.invoke('cueBackup:readFile', { filePath, workspaceId, relativePath }),

		readLive: (cwd: string, relativePath: string): Promise<string | null> =>
			ipcRenderer.invoke('cueBackup:readLive', { cwd, relativePath }),

		restoreFile: (filePath: string, workspaceId: string, relativePath: string): Promise<void> =>
			ipcRenderer.invoke('cueBackup:restoreFile', { filePath, workspaceId, relativePath }),

		restoreAll: (filePath: string): Promise<CueBackupRestoreResult> =>
			ipcRenderer.invoke('cueBackup:restoreAll', { filePath }),

		getDiffStatus: (filePath: string): Promise<CueBackupDiffStatusMap> =>
			ipcRenderer.invoke('cueBackup:getDiffStatus', { filePath }),

		delete: (filePath: string): Promise<void> =>
			ipcRenderer.invoke('cueBackup:delete', { filePath }),
	};
}

export type CueBackupApi = ReturnType<typeof createCueBackupApi>;
