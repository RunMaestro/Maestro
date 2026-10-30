/** Cue data-reader floor. No grants, authorization epochs or identities are changed. */
import type Database from 'better-sqlite3';

export const CUE_RECEIPT_READER_VERSION = 1;
const READER_FUNCTION = 'maestro_cue_receipt_reader';
export const CUE_RECEIPT_GUARDED_TABLES = [
	'cue_plugin_receipts',
	'cue_plugin_legacy_receipts',
	'cue_event_queue',
] as const;
type GuardedTable = (typeof CUE_RECEIPT_GUARDED_TABLES)[number];

export function registerCueReceiptReader(db: Database.Database): void {
	// SQL-recording unit fixtures do not implement native UDF registration.
	if (typeof db.function === 'function')
		db.function(READER_FUNCTION, () => CUE_RECEIPT_READER_VERSION);
}

export function cuePhysicalTable(db: Database.Database, name: GuardedTable): string {
	const row = db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(name) as
		| { type: string }
		| undefined;
	return row?.type === 'view' ? name + '_receipt_v1' : name;
}

/** Run only after the independent cutover checkpoint is durable. Old readers lack
 * the UDF and fail on receipt lookup AND queue restoration, before execution. */
export function installCueReceiptReaderFloor(db: Database.Database): void {
	registerCueReceiptReader(db);
	db.transaction(() => {
		for (const name of CUE_RECEIPT_GUARDED_TABLES) {
			const physical = name + '_receipt_v1';
			const viewSql = `CREATE VIEW "${name}" AS SELECT * FROM "${physical}" WHERE ${READER_FUNCTION}() = ${CUE_RECEIPT_READER_VERSION}`;
			const row = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name) as
				| { type: string; sql: string }
				| undefined;
			if (!row) throw Error('Cue schema unavailable for receipt transition');
			if (row.type === 'view') {
				if (row.sql !== viewSql) throw Error('Cue receipt reader floor changed');
				const backing = db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(physical) as
					| { type: string }
					| undefined;
				if (backing?.type !== 'table') throw Error('Cue receipt backing table missing');
				continue;
			}
			if (
				row.type !== 'table' ||
				db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(physical)
			)
				throw Error('Cue receipt transition conflicts with an existing schema');
			db.exec(`ALTER TABLE "${name}" RENAME TO "${physical}"`);
			db.exec(viewSql);
		}
	})();
}
