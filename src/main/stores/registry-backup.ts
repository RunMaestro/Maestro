/**
 * Registry backup: keep a copy of a stored list before an empty one replaces it.
 *
 * Two on-disk registries are the ONLY copy of what they hold. The group
 * registry (`maestro-groups.json`) carries every group's name, emoji and
 * collapsed state; agents reference groups by id alone. The session registry
 * (`maestro-sessions.json`) carries every agent, its tabs and its transcript
 * references. Empty either one and there is nothing on disk to rebuild it from.
 *
 * Both live under the configurable sync path, which may be a cloud folder that
 * has not finished mounting when the app starts. A read there answers "nothing
 * stored" rather than failing, so an empty write is not always the user's
 * intent - and emptying the registry is exactly what that failure produces.
 *
 * Deleting the last entry is still a legitimate action, so this does not block
 * the write. It keeps the outgoing registry first, which is what turns a
 * permanent loss into a recoverable one.
 */

import * as path from 'path';
import { logger } from '../utils/logger';
import { atomicWriteJson } from '../utils/atomic-json-store';

export interface RegistryBackupOptions<T> {
	/** What is on disk right now. Read by the caller, since each store reads differently. */
	existing: T[] | undefined | null;
	/** What is about to be written. */
	incoming: T[] | undefined | null;
	/** Path of the live store; the backup is written beside it. */
	storePath: string;
	/** Backup filename, written into the store's directory. */
	backupFilename: string;
	/** Logger category and the noun used in log lines. */
	label: string;
}

/**
 * Snapshot `existing` beside the store when `incoming` is empty and `existing`
 * is not. No-ops when the incoming registry still has entries or when there
 * was nothing stored to lose. A backup failure is logged and swallowed - a
 * snapshot that cannot be written must not stop the user's actual change from
 * being saved.
 */
export async function backupRegistryBeforeWipe<T>(
	options: RegistryBackupOptions<T>
): Promise<void> {
	const { existing, incoming, storePath, backupFilename, label } = options;

	if (incoming && incoming.length > 0) {
		return;
	}
	if (!existing || existing.length === 0) {
		return;
	}

	const backupPath = path.join(path.dirname(storePath), backupFilename);
	try {
		await atomicWriteJson(backupPath, {
			savedAt: new Date().toISOString(),
			reason: 'registry-emptied',
			entries: existing,
		});
		logger.warn(
			`${label} registry emptied (${existing.length} removed). Previous registry backed up to ${backupPath}`,
			label
		);
	} catch (err) {
		logger.warn(
			`Failed to back up ${label.toLowerCase()} before an empty write: ${(err as Error).message}`,
			label
		);
	}
}
