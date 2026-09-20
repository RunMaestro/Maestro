/**
 * Session registry backup. See `registry-backup.ts` for why this exists.
 *
 * `maestro-sessions.json` is every agent, its tabs and its transcript
 * references. It is the larger blast radius of the two registries, and it is
 * emptied by the same mechanism: a bootstrap read that came back empty because
 * the sync folder had not mounted, followed by a first flush that wrote that
 * emptiness back as truth.
 */

import { backupRegistryBeforeWipe } from './registry-backup';
import type { StoredSession } from './types';

/** Filename written beside the live store when a non-empty registry is replaced by an empty one. */
export const SESSIONS_BACKUP_FILENAME = 'maestro-sessions.backup.json';

/**
 * Snapshot the stored session registry when it is about to be replaced by an
 * empty one. The caller hands in what it already read for its own diff, so
 * this never reads the store a second time.
 */
export function backupSessionsBeforeWipe(
	existing: StoredSession[] | undefined | null,
	incoming: StoredSession[] | undefined | null,
	storePath: string
): Promise<void> {
	return backupRegistryBeforeWipe({
		existing,
		incoming,
		storePath,
		backupFilename: SESSIONS_BACKUP_FILENAME,
		label: 'Sessions',
	});
}
