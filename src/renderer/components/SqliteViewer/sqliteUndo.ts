/**
 * The viewer's Undo of the last write, its pure half: what the table view
 * reports after each write, and the chord that undoes it.
 *
 * Every write returns its own inverse (`undo` on its result,
 * `SqliteUndoStep`), captured in main inside the write's transaction, so the
 * viewer only remembers the last one and hands it back to
 * `window.maestro.sqlite.undoEdit()`. One level: the last write of this tab's
 * editing session, gone when the tab locks.
 */

import type { SqliteUndoStep } from '../../../shared/sqlite/types';

/** The last write the tab made, as its result described it. */
export interface SqliteLastWrite {
	/** How to take it back; null when its triggers or foreign-key actions changed other rows. */
	undo: SqliteUndoStep | null;
	/** Rows the database changed beside the written one. */
	otherChanges: number;
}

/** Undo the last write: Cmd+Z (Ctrl+Z off macOS), outside a text field. */
export const SQLITE_UNDO_KEYS = ['Meta', 'z'];

/** Whether a keydown is SQLITE_UNDO_KEYS (Ctrl for Cmd off macOS); Shift is redo, never this. */
export function isSqliteUndoChord(event: {
	key: string;
	altKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
}): boolean {
	return (
		event.key.toLowerCase() === 'z' &&
		(event.metaKey || event.ctrlKey) &&
		!event.altKey &&
		!event.shiftKey
	);
}
