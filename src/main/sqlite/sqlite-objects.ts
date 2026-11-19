/**
 * SQLite Schema Objects
 *
 * What the viewer's table-list rail shows: every table, view, index, and
 * trigger in the main schema, then a row count and on-disk size per object.
 *
 * The listing and the measurements are separate calls on purpose. Listing
 * reads only `sqlite_master`, so it is instant on any database. Counting rows
 * and walking b-tree pages costs time proportional to the data, and
 * better-sqlite3 is synchronous: it runs on the main process, and nothing else
 * in the app moves while a statement does. So the measurements are bounded
 * twice over:
 *
 *   - A row count stops at `SQLITE_ROW_COUNT_CAP` and reports a lower bound
 *     (`100,000+`), the same converging-count idea the Parquet viewer uses.
 *   - `readSqliteObjectStats()` works through its list against a time budget
 *     and returns what it finished. The renderer asks again for the rest, so
 *     the event loop runs between batches and the rail fills in as it goes.
 *
 * Sizes come from SQLite's `dbstat` virtual table, which has to visit every
 * page of an object. That is unavoidable, so on a database larger than
 * `SQLITE_SIZE_SCAN_MAX_BYTES` sizes are not measured at all and the listing
 * says why.
 */

import type Database from 'better-sqlite3';

import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';
import type {
	SqliteObjectKind,
	SqliteObjectList,
	SqliteObjectStats,
	SqliteObjectSummary,
	SqliteTableType,
} from '../../shared/sqlite/types';
import { yieldToEventLoop } from '../utils/concurrency';
import { getSqliteDatabase } from './sqlite-database';

/** Rows counted before a count is reported as a lower bound. */
export const SQLITE_ROW_COUNT_CAP = 100_000;

/** Largest database whose objects are sized with a `dbstat` walk. */
export const SQLITE_SIZE_SCAN_MAX_BYTES = 1024 * 1024 * 1024;

/** Default time budget for one `readSqliteObjectStats()` batch. */
export const SQLITE_STATS_BUDGET_MS = 50;

const OBJECT_KINDS = new Set<string>(['table', 'view', 'index', 'trigger']);

interface MasterRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

interface TableListRow {
	schema: string;
	name: string;
	type: string;
	wr: number;
	strict: number;
}

/** What `PRAGMA table_list` knows about one table. */
interface TableFlavour {
	tableType: SqliteTableType;
	withoutRowid: boolean;
	strict: boolean;
}

/**
 * Table flavours from `PRAGMA table_list` (SQLite 3.37+). Falls back to
 * reading the `CREATE` text when the pragma fails, which it can on a schema
 * that references a module this build does not have.
 */
function readTableFlavours(db: Database.Database, rows: MasterRow[]): Map<string, TableFlavour> {
	const flavours = new Map<string, TableFlavour>();
	try {
		for (const row of db.prepare('PRAGMA main.table_list').all() as TableListRow[]) {
			if (row.type !== 'table' && row.type !== 'virtual' && row.type !== 'shadow') continue;
			flavours.set(row.name, {
				tableType: row.type,
				withoutRowid: row.wr === 1,
				strict: row.strict === 1,
			});
		}
		return flavours;
	} catch {
		// Expected on an older SQLite or an unloadable module; the SQL text is
		// enough to tell virtual and WITHOUT ROWID tables apart.
	}
	for (const row of rows) {
		if (row.type !== 'table') continue;
		const sql = row.sql ?? '';
		flavours.set(row.name, {
			tableType: /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql) ? 'virtual' : 'table',
			withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(sql),
			strict: /\)\s*(?:WITHOUT\s+ROWID\s*,\s*)?STRICT\b/i.test(sql),
		});
	}
	return flavours;
}

/** Every object in the main schema, unordered (callers group and sort). */
function readObjects(db: Database.Database): SqliteObjectSummary[] {
	const rows = (
		db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as MasterRow[]
	).filter((row) => OBJECT_KINDS.has(row.type));
	const flavours = readTableFlavours(db, rows);

	return rows.map((row) => {
		const kind = row.type as SqliteObjectKind;
		const summary: SqliteObjectSummary = {
			name: row.name,
			kind,
			tableName: row.tbl_name,
			internal: row.name.startsWith('sqlite_'),
			countable: kind === 'table',
			hasStorage: kind === 'index',
		};
		if (kind === 'table') {
			const flavour = flavours.get(row.name) ?? {
				tableType: 'table' as const,
				withoutRowid: false,
				strict: false,
			};
			summary.tableType = flavour.tableType;
			summary.withoutRowid = flavour.withoutRowid;
			summary.strict = flavour.strict;
			summary.internal = summary.internal || flavour.tableType === 'shadow';
			// A virtual table's rows live in its module (and its shadow tables),
			// never in a b-tree of its own.
			summary.hasStorage = flavour.tableType !== 'virtual';
		}
		return summary;
	});
}

/** Whether this SQLite build has the `dbstat` table sizes are measured with. */
function hasDbstat(db: Database.Database): boolean {
	try {
		db.prepare('SELECT 1 FROM dbstat LIMIT 0').all();
		return true;
	} catch {
		return false;
	}
}

/** List the tables, views, indexes, and triggers of an open database. */
export function listSqliteObjects(handle: string): SqliteObjectList {
	const { db, info } = getSqliteDatabase(handle);
	const objects = readObjects(db);
	if (info.fileBytes > SQLITE_SIZE_SCAN_MAX_BYTES) {
		return {
			objects,
			sizesAvailable: false,
			sizeNote:
				'Sizes are not measured on a database this large: it would mean reading every page.',
		};
	}
	if (!hasDbstat(db)) {
		return {
			objects,
			sizesAvailable: false,
			sizeNote: 'Sizes are unavailable: this SQLite build has no dbstat table.',
		};
	}
	return { objects, sizesAvailable: true };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Count rows up to the cap. A count that reaches it is a lower bound. */
function countRows(db: Database.Database, name: string): { rowCount: number; capped: boolean } {
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quoteSqliteIdentifier(name)} LIMIT ?)`)
		.get(SQLITE_ROW_COUNT_CAP + 1) as { n: number };
	const capped = row.n > SQLITE_ROW_COUNT_CAP;
	return { rowCount: capped ? SQLITE_ROW_COUNT_CAP : row.n, capped };
}

/** Bytes of pages one b-tree occupies, from `dbstat`'s per-object aggregate. */
function measureBytes(db: Database.Database, name: string): number {
	const row = db
		.prepare('SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = ? AND aggregate = TRUE')
		.get(name) as { bytes: number | null } | undefined;
	return row?.bytes ?? 0;
}

/** Measure one object. Failures are reported on the result, never thrown. */
function measureObject(
	db: Database.Database,
	object: SqliteObjectSummary | undefined,
	name: string,
	measureSizes: boolean
): SqliteObjectStats {
	const stats: SqliteObjectStats = {
		name,
		rowCount: null,
		rowCountCapped: false,
		sizeBytes: null,
	};
	if (!object) {
		stats.error = `No table, view, index, or trigger is named ${name}.`;
		return stats;
	}
	const problems: string[] = [];
	if (object.countable) {
		try {
			const counted = countRows(db, name);
			stats.rowCount = counted.rowCount;
			stats.rowCountCapped = counted.capped;
		} catch (error) {
			// A virtual table whose module this build lacks, a lock held by a
			// writer, a damaged page: the rail shows the reason on the row.
			problems.push(errorMessage(error));
		}
	}
	if (object.hasStorage && measureSizes) {
		try {
			stats.sizeBytes = measureBytes(db, name);
		} catch (error) {
			problems.push(errorMessage(error));
		}
	}
	if (problems.length > 0) stats.error = problems.join(' ');
	return stats;
}

/**
 * Measure row counts and sizes for the named objects, in order, until the
 * time budget runs out. Always measures at least one, so repeated calls with
 * the unfinished remainder always make progress. Names not in the schema come
 * back with an `error` rather than failing the batch.
 */
export function readSqliteObjectStats(
	handle: string,
	names: readonly string[],
	budgetMs: number = SQLITE_STATS_BUDGET_MS
): SqliteObjectStats[] {
	const { db, info } = getSqliteDatabase(handle);
	const byName = new Map(readObjects(db).map((object) => [object.name, object]));
	const measureSizes = info.fileBytes <= SQLITE_SIZE_SCAN_MAX_BYTES && hasDbstat(db);

	const started = Date.now();
	const results: SqliteObjectStats[] = [];
	for (const name of names) {
		if (results.length > 0 && Date.now() - started >= budgetMs) break;
		results.push(measureObject(db, byName.get(name), name, measureSizes));
	}
	return results;
}

/** Measure every named object, batch after batch, yielding between batches. */
export async function readAllSqliteObjectStats(
	handle: string,
	names: readonly string[]
): Promise<SqliteObjectStats[]> {
	const results: SqliteObjectStats[] = [];
	let remaining = [...names];
	while (remaining.length > 0) {
		const batch = readSqliteObjectStats(handle, remaining);
		results.push(...batch);
		remaining = remaining.slice(batch.length);
		if (remaining.length > 0) await yieldToEventLoop();
	}
	return results;
}
