/**
 * Group registry backup. See `registry-backup.ts` for why this exists.
 *
 * The group rows carry every group's name, emoji and collapsed state; agents
 * reference groups by `groupId` alone, so an emptied registry leaves every
 * agent silently ungrouped with nothing on disk to rebuild the rows from.
 */

import { logger } from '../utils/logger';
import { backupRegistryBeforeWipe } from './registry-backup';
import type { Group } from '../../shared/types';

/** Filename written beside the live store when a non-empty registry is replaced by an empty one. */
export const GROUPS_BACKUP_FILENAME = 'maestro-groups.backup.json';

/** Minimal surface this module needs, so tests can pass a plain object. */
export interface GroupsBackupStore {
	get(key: 'groups', defaultValue: Group[]): Group[];
	readonly path: string;
}

/**
 * Snapshot the stored group registry when it is about to be replaced by an
 * empty one. Never throws: a store that cannot be read has nothing to
 * snapshot, and a snapshot that cannot be written must not block the write.
 */
export async function backupGroupsBeforeWipe(
	store: GroupsBackupStore,
	incoming: Group[] | undefined | null
): Promise<void> {
	if (incoming && incoming.length > 0) {
		return;
	}

	let existing: Group[];
	try {
		existing = store.get('groups', []);
	} catch (err) {
		// Also the case where a corrupt registry is about to be overwritten,
		// and there is no good copy to preserve.
		logger.warn(`Could not read groups before an empty write: ${(err as Error).message}`, 'Groups');
		return;
	}

	await backupRegistryBeforeWipe({
		existing,
		incoming,
		storePath: store.path,
		backupFilename: GROUPS_BACKUP_FILENAME,
		label: 'Groups',
	});
}
