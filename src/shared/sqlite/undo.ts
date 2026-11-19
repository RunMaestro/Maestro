/**
 * The words around undoing one write to a SQLite table, shared by the viewer
 * (SqliteUndoControl) and `maestro-cli sqlite undo`, so both describe the
 * same step the same way. The step itself is `SqliteUndoStep`
 * (./types.ts), returned by each write and applied by `undoSqliteEdit()` in
 * src/main/sqlite/sqlite-row-edit.ts.
 */

import { formatCount } from '../formatters';
import type { SqliteUndoResult, SqliteUndoStep } from './types';

/** What a step takes back: `the edit of email in users`, `the insert into users`. */
export function sqliteUndoLabel(step: SqliteUndoStep): string {
	switch (step.kind) {
		case 'restore-cell':
			return `the edit of ${step.column} in ${step.name}`;
		case 'remove-row':
			return `the insert into ${step.name}`;
		case 'restore-row':
			return `the delete from ${step.name}`;
	}
}

/**
 * Why a write returned no undo step: its triggers or foreign-key actions
 * changed other rows, which putting its own row back would not restore.
 */
export function sqliteUndoUnavailableMessage(otherChanges: number): string {
	const rows = `${formatCount(otherChanges)} other ${otherChanges === 1 ? 'row' : 'rows'}`;
	return `The last change cannot be undone here: the database's triggers or foreign-key actions also changed ${rows}, which putting this one row back would not restore. The backup taken before the first change has the file as it was then.`;
}

/** The outcome of an undo, as the viewer's status line and the CLI print it. */
export function sqliteUndoOutcome(step: SqliteUndoStep, result: SqliteUndoResult): string {
	const others =
		result.otherChanges > 0
			? `; the database's triggers and foreign-key actions changed ${formatCount(result.otherChanges)} other ${result.otherChanges === 1 ? 'row' : 'rows'}`
			: '';
	return `Undid ${sqliteUndoLabel(step)} (${result.elapsedMs} ms)${others}`;
}
