/**
 * What the viewer says after a write, shared by every surface that writes:
 * the table view (cell edit, insert, delete) and Query mode (a statement run
 * with editing on).
 */

import { formatCount, formatSize } from '../../../shared/formatters';
import type { SqliteBackup } from '../../../shared/sqlite/types';
import { notifyToast } from '../../stores/notificationStore';

/**
 * Say where the session's backup went, once: only the write that took it
 * carries `backup`. A toast, since the backup outlives the surface that wrote.
 */
export function announceSqliteBackup(backup: SqliteBackup | undefined): void {
	if (!backup) return;
	notifyToast({
		color: 'green',
		title: 'Database backed up before the first change',
		message: `${formatSize(backup.bytes)} copy saved to ${backup.path}`,
	});
}

/** "; the database's triggers and foreign-key actions changed 3 other rows", or nothing. */
export function sqliteOtherChangesText(otherChanges: number): string {
	if (otherChanges <= 0) return '';
	return `; the database's triggers and foreign-key actions changed ${formatCount(otherChanges)} other ${otherChanges === 1 ? 'row' : 'rows'}`;
}
