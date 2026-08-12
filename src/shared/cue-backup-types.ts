/**
 * Cue backup - shared types between main and renderer.
 *
 * A backup is a zip file capturing every workspace's `.maestro/cue.yaml`
 * plus the contents of `.maestro/prompts/` so that Cue configuration can
 * be snapshot and restored independently of the project's own VCS.
 */

export const CUE_BACKUP_MANIFEST_VERSION = 1;

export interface CueBackupAgentRef {
	id: string;
	name: string;
	toolType: string;
}

export interface CueBackupFileEntry {
	/**
	 * Path inside the backup workspace, always forward-slash separated.
	 * Examples: `cue.yaml`, `prompts/codex-review.md`.
	 */
	relativePath: string;
	/** Size in bytes of the file as captured. */
	size: number;
}

export interface CueBackupWorkspaceEntry {
	/** Stable id used as the directory name inside the zip (hash of cwd). */
	id: string;
	/** Absolute working directory at the moment the backup was created. */
	cwd: string;
	/** Agents that pointed at this workspace when the backup was taken. */
	agents: CueBackupAgentRef[];
	/** Captured files for this workspace. */
	files: CueBackupFileEntry[];
}

export interface CueBackupManifest {
	version: number;
	createdAt: string;
	/** Maestro app version, recorded for forward-compat debugging. */
	appVersion?: string;
	workspaces: CueBackupWorkspaceEntry[];
}

export interface CueBackupSummary {
	/** Absolute path to the zip file. */
	filePath: string;
	/** File name (no directory). */
	fileName: string;
	/** Bytes on disk. */
	size: number;
	/** Manifest read from the zip. */
	manifest: CueBackupManifest;
}

export interface CueBackupRestoreResult {
	written: number;
	skipped: Array<{ workspaceId: string; relativePath: string; reason: string }>;
}

/**
 * Per-file diff status comparing a backup file against its live counterpart:
 *  - `unchanged`  - live file exists and matches the backup byte-for-byte;
 *                   the UI should hide Diff/Restore for these.
 *  - `changed`    - live file exists but differs.
 *  - `missing-live` - no live file at the original path; restore would
 *                     recreate it, diff would show the backup as additions.
 */
export type CueBackupFileDiffStatus = 'unchanged' | 'changed' | 'missing-live';

/**
 * Status map keyed by `${workspaceId}::${relativePath}`. Flat keys avoid the
 * nested-record marshalling cost across the IPC bridge.
 */
export type CueBackupDiffStatusMap = Record<string, CueBackupFileDiffStatus>;

export function cueBackupStatusKey(workspaceId: string, relativePath: string): string {
	return `${workspaceId}::${relativePath}`;
}
