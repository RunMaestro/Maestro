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

import { logger } from '../utils/logger';
import {
	backupRegistryBeforeWipe as backupRegistry,
	type RegistryBackupOptions as LibRegistryBackupOptions,
} from '../../shared/maestro-lib/store/io';

export interface RegistryBackupOptions<T> extends Omit<LibRegistryBackupOptions<T>, 'now'> {
	/** Logger category and the noun used in log lines. */
	label: string;
}

/**
 * Snapshot `existing` beside the store when `incoming` is empty and `existing`
 * is not. No-ops when the incoming registry still has entries or when there
 * was nothing stored to lose. A backup failure is logged and swallowed - a
 * snapshot that cannot be written must not stop the user's actual change from
 * being saved.
 *
 * The decision and the write live in the library (`store/io.ts`), shared with
 * the headless runtime; this wrapper only reports the outcome to the log.
 */
export async function backupRegistryBeforeWipe<T>(
	options: RegistryBackupOptions<T>
): Promise<void> {
	const { label, ...backup } = options;
	const outcome = await backupRegistry(backup);
	if (outcome.status === 'backed-up') {
		logger.warn(
			`${label} registry emptied (${outcome.count} removed). Previous registry backed up to ${outcome.path}`,
			label
		);
	} else if (outcome.status === 'failed') {
		logger.warn(
			`Failed to back up ${label.toLowerCase()} before an empty write: ${outcome.error.message}`,
			label
		);
	}
}
