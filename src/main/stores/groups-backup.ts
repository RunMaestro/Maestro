/**
 * Group registry backup.
 *
 * The group registry (`maestro-groups.json`) is the ONLY copy of a group's
 * name, emoji and collapsed state. Agents reference groups by `groupId`, so
 * when the registry is emptied the ids survive and point at rows that no longer
 * exist: every agent silently becomes ungrouped and there is nothing on disk to
 * rebuild the rows from.
 *
 * That registry also lives under the configurable sync path, which may be a
 * cloud folder that has not finished mounting when the app starts. A read there
 * answers "no groups" rather than failing, so an empty write is not always the
 * user's intent - and emptying the registry is exactly what the failure mode
 * produces.
 *
 * Deleting the last group is still a legitimate action, so this does not block
 * the write. It keeps the outgoing registry first, which is what turns a
 * permanent loss into a recoverable one.
 */

import * as path from 'path';
import { logger } from '../utils/logger';
import { atomicWriteJson } from '../utils/atomic-json-store';
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
 * empty one.
 *
 * No-ops in the two cases that carry no risk: the incoming registry still has
 * groups in it, or there was nothing stored to lose. A backup failure is
 * logged and swallowed - a snapshot that cannot be written must not stop the
 * user's actual change from being saved.
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
		// The store could not be read, so there is nothing to snapshot. This is
		// also the case where a corrupt registry is about to be overwritten, and
		// there is no good copy to preserve.
		logger.warn(`Could not read groups before an empty write: ${(err as Error).message}`, 'Groups');
		return;
	}

	if (!existing || existing.length === 0) {
		return;
	}

	const backupPath = path.join(path.dirname(store.path), GROUPS_BACKUP_FILENAME);
	try {
		await atomicWriteJson(backupPath, {
			savedAt: new Date().toISOString(),
			reason: 'group-registry-emptied',
			groups: existing,
		});
		logger.warn(
			`Group registry emptied (${existing.length} group(s) removed). Previous registry backed up to ${backupPath}`,
			'Groups'
		);
	} catch (err) {
		logger.warn(
			`Failed to back up groups before an empty write: ${(err as Error).message}`,
			'Groups'
		);
	}
}
