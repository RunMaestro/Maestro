import { describe, expect, it } from 'vitest';

import type { SqliteUndoStep } from '../../../shared/sqlite/types';
import {
	sqliteUndoLabel,
	sqliteUndoOutcome,
	sqliteUndoUnavailableMessage,
} from '../../../shared/sqlite/undo';

const restoreCell: SqliteUndoStep = {
	kind: 'restore-cell',
	name: 'users',
	column: 'email',
	row: { kind: 'rowid', rowid: '7' },
	version: 'AfterAfterAfterAfter_1',
	value: { type: 'text', text: 'old@example.com' },
};

describe('sqliteUndoLabel', () => {
	it('names what each step takes back', () => {
		expect(sqliteUndoLabel(restoreCell)).toBe('the edit of email in users');
		expect(
			sqliteUndoLabel({
				kind: 'remove-row',
				name: 'users',
				row: { kind: 'rowid', rowid: '12' },
				version: 'AfterAfterAfterAfter_1',
			})
		).toBe('the insert into users');
		expect(sqliteUndoLabel({ kind: 'restore-row', name: 'users', rowid: '7', values: {} })).toBe(
			'the delete from users'
		);
	});
});

describe('sqliteUndoUnavailableMessage', () => {
	it('says how many other rows changed and points at the backup', () => {
		expect(sqliteUndoUnavailableMessage(1)).toContain('also changed 1 other row,');
		const many = sqliteUndoUnavailableMessage(1204);
		expect(many).toContain('also changed 1,204 other rows');
		expect(many).toContain('The backup taken before the first change');
	});
});

describe('sqliteUndoOutcome', () => {
	const result = {
		name: 'users',
		kind: 'restore-cell' as const,
		key: { kind: 'rowid' as const, rowid: '7' },
		otherChanges: 0,
		elapsedMs: 3,
	};

	it('says what was undone and how long it took', () => {
		expect(sqliteUndoOutcome(restoreCell, result)).toBe('Undid the edit of email in users (3 ms)');
	});

	it('counts rows the undo itself made the database change', () => {
		expect(sqliteUndoOutcome(restoreCell, { ...result, otherChanges: 2 })).toBe(
			"Undid the edit of email in users (3 ms); the database's triggers and foreign-key actions changed 2 other rows"
		);
	});
});
