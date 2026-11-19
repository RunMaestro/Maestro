// SQLite commands - `maestro-cli sqlite ...`, the CLI half of the SQLite viewer.
//
//   maestro-cli sqlite tables <path> [--internal] [--json]
//       -> the table-list rail: tables, views, indexes, and triggers, with row
//          counts and on-disk sizes
//   maestro-cli sqlite schema <path> <object> [--kind <kind>] [--json]
//       -> the schema pane: columns with type, affinity, nullability, default,
//          primary key and foreign-key targets, index key columns, CREATE SQL
//   maestro-cli sqlite rows <path> <object> [--offset <n>] [--limit <n>]
//                           [--sort <column>] [--desc] [--filter <expr>] [--json]
//       -> the table view: one LIMIT/OFFSET window of rows, filtered and
//          sorted in SQLite
//
// The CLI links no native modules, so it cannot open a database itself. Each
// verb rides a WS message (`sqlite_list_objects`, `sqlite_read_schema`,
// `sqlite_read_rows`) to the running app, which answers with the same
// functions the viewer's `sqlite:*` IPC calls. The app must be running, and
// the database is opened read-only there.

import { withMaestroClient } from '../services/maestro-client';
import { failFromError } from '../services/session-command';
import { ExitCode, exitWith } from '../exit-codes';
import { formatTextTable } from '../output/formatter';
import { resolveCliPath } from '../utils/parse';
import { formatSize } from '../../shared/formatters';
import {
	SQLITE_OBJECT_KINDS,
	SQLITE_OBJECT_KIND_LABELS,
	formatSqliteRowCount,
	groupSqliteObjects,
	sqliteObjectTags,
} from '../../shared/sqlite/objects';
import {
	SQLITE_INDEX_ORIGIN_LABELS,
	formatSqliteColumnReferences,
	formatSqliteForeignKey,
	formatSqliteIndexColumn,
	sqliteColumnTags,
	sqliteMissingSqlNote,
} from '../../shared/sqlite/schema';
import { formatSqliteCell } from '../../shared/sqlite/cells';
import type {
	SqliteDatabaseInfo,
	SqliteObjectKind,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
	SqliteObjectSummary,
	SqliteRowsPage,
} from '../../shared/sqlite/types';

/** Counting and sizing a large database takes a while; give it room. */
const SQLITE_TIMEOUT_MS = 2 * 60_000;

interface SqliteTablesOptions {
	internal?: boolean;
	json?: boolean;
}

interface SqliteObjectsReply {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	list?: SqliteObjectList;
	stats?: SqliteObjectStats[];
}

function fail(message: string, json: boolean | undefined): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(ExitCode.GeneralError);
}

/** One rail row as a text-table row: name, rows, size, and the detail column. */
function objectRow(object: SqliteObjectSummary, stats: SqliteObjectStats | undefined): string[] {
	const detail: string[] = [];
	if (object.kind === 'index' || object.kind === 'trigger') detail.push(`on ${object.tableName}`);
	detail.push(...sqliteObjectTags(object));
	if (object.internal) detail.push('internal');
	if (stats?.error) detail.push(`error: ${stats.error}`);
	return [
		object.name,
		formatSqliteRowCount(stats) ?? '',
		stats?.sizeBytes !== null && stats?.sizeBytes !== undefined ? formatSize(stats.sizeBytes) : '',
		detail.join(', '),
	];
}

/**
 * `maestro-cli sqlite tables <path>` - list a database's schema objects with
 * their row counts and sizes, grouped the way the viewer's rail groups them.
 */
export async function sqliteTables(file: string, options: SqliteTablesOptions): Promise<void> {
	const filePath = resolveCliPath(file);
	let reply: SqliteObjectsReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteObjectsReply>(
				{ type: 'sqlite_list_objects', path: filePath },
				'sqlite_objects_result',
				SQLITE_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.list || !reply.stats) {
		fail(reply.error || `Could not read ${filePath}`, options.json);
	}

	const { database, list, stats } = reply;
	const includeInternal = options.internal === true;
	const statsByName = new Map(stats.map((entry) => [entry.name, entry]));
	const groups = groupSqliteObjects(list.objects, includeInternal);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				fileBytes: database.fileBytes,
				sizesAvailable: list.sizesAvailable,
				...(list.sizeNote ? { sizeNote: list.sizeNote } : {}),
				objects: groups.flatMap((group) =>
					group.objects.map((object) => ({ ...object, ...statsByName.get(object.name) }))
				),
			})
		);
		return;
	}

	const lines: string[] = [`${database.displayPath} (${formatSize(database.fileBytes)})`];
	for (const group of groups) {
		if (group.objects.length === 0) continue;
		lines.push('', `${SQLITE_OBJECT_KIND_LABELS[group.kind]} (${group.objects.length})`);
		const table = formatTextTable(
			['NAME', 'ROWS', 'SIZE', 'DETAIL'],
			group.objects.map((object) => objectRow(object, statsByName.get(object.name)))
		);
		lines.push(...table.split('\n').map((line) => `  ${line}`));
	}
	const hidden = list.objects.filter((object) => object.internal).length;
	if (!includeInternal && hidden > 0) {
		lines.push('', `${hidden} internal object(s) hidden; pass --internal to list them.`);
	}
	if (list.sizeNote) lines.push('', list.sizeNote);
	console.log(lines.join('\n'));
}

interface SqliteSchemaOptions {
	kind?: string;
	json?: boolean;
}

interface SqliteSchemaReply {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	schema?: SqliteObjectSchema;
}

/** Schema metadata only, so this answers fast; the timeout covers a slow open. */
const SQLITE_SCHEMA_TIMEOUT_MS = 30_000;

/** The schema pane as text: columns or index keys, foreign keys, then the SQL. */
function formatSchemaText(database: SqliteDatabaseInfo, schema: SqliteObjectSchema): string {
	const lines: string[] = [`${schema.name} (${schema.kind}) in ${database.displayPath}`];
	if (schema.kind === 'index' || schema.kind === 'trigger') lines.push(`on ${schema.tableName}`);

	if (schema.columns.length > 0) {
		lines.push('', `Columns (${schema.columns.length})`);
		const table = formatTextTable(
			['NAME', 'TYPE', 'AFFINITY', 'PK', 'DEFAULT', 'REFERENCES', 'CONSTRAINTS'],
			schema.columns.map((column) => [
				column.name,
				column.declaredType,
				column.affinity,
				column.primaryKeyPosition > 0 ? String(column.primaryKeyPosition) : '',
				column.defaultValue ?? '',
				formatSqliteColumnReferences(column),
				sqliteColumnTags(column).join(', '),
			])
		);
		lines.push(...table.split('\n').map((line) => `  ${line}`));
	}

	if (schema.foreignKeys.length > 0) {
		lines.push('', `Foreign keys (${schema.foreignKeys.length})`);
		lines.push(...schema.foreignKeys.map((key) => `  ${formatSqliteForeignKey(key)}`));
	}

	if (schema.index) {
		const traits = [
			schema.index.unique ? 'unique' : null,
			schema.index.partial ? 'partial' : null,
			`from ${SQLITE_INDEX_ORIGIN_LABELS[schema.index.origin]}`,
		].filter((trait): trait is string => trait !== null);
		lines.push('', `Key columns (${schema.index.columns.length}): ${traits.join(', ')}`);
		const table = formatTextTable(
			['COLUMN', 'ORDER', 'COLLATION'],
			schema.index.columns.map((column) => [
				formatSqliteIndexColumn(column),
				column.descending ? 'DESC' : 'ASC',
				column.collation,
			])
		);
		lines.push(...table.split('\n').map((line) => `  ${line}`));
	}

	if (schema.error) lines.push('', `Columns could not be read: ${schema.error}`);

	lines.push('', 'SQL');
	const missing = sqliteMissingSqlNote(schema);
	if (missing) lines.push(`  ${missing}`);
	else lines.push(...(schema.sql ?? '').split('\n').map((line) => `  ${line}`));
	return lines.join('\n');
}

/**
 * `maestro-cli sqlite schema <path> <object>` - one object's structure, the
 * way the viewer's schema pane shows it.
 */
export async function sqliteSchema(
	file: string,
	name: string,
	options: SqliteSchemaOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	let kind: SqliteObjectKind | undefined;
	if (options.kind !== undefined) {
		kind = SQLITE_OBJECT_KINDS.find((entry) => entry === options.kind);
		if (!kind) {
			fail(
				`--kind must be one of ${SQLITE_OBJECT_KINDS.join(', ')} (got "${options.kind}")`,
				options.json
			);
		}
	}

	let reply: SqliteSchemaReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteSchemaReply>(
				{ type: 'sqlite_read_schema', path: filePath, name, ...(kind ? { kind } : {}) },
				'sqlite_schema_result',
				SQLITE_SCHEMA_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.schema) {
		fail(reply.error || `Could not read ${name} in ${filePath}`, options.json);
	}

	if (options.json) {
		console.log(
			JSON.stringify({ success: true, path: reply.database.displayPath, ...reply.schema })
		);
		return;
	}
	console.log(formatSchemaText(reply.database, reply.schema));
}

interface SqliteRowsOptions {
	offset?: string;
	limit?: string;
	sort?: string;
	desc?: boolean;
	filter?: string;
	json?: boolean;
}

interface SqliteRowsReply {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	page?: SqliteRowsPage;
}

/** Rows printed when `--limit` is not given: one screen, not one page of the grid. */
const SQLITE_ROWS_DEFAULT_LIMIT = 50;

/** Widest a cell prints in the text table; `--json` carries the full value. */
const SQLITE_ROWS_CELL_WIDTH = 60;

function parseCount(value: string | undefined, flag: string, fallback: number, json?: boolean) {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		fail(`${flag} must be a non-negative whole number (got "${value}")`, json);
	}
	return parsed;
}

/** One cell as one line of a text table. */
function cellText(text: string): string {
	const line = text.replace(/\s+/g, ' ');
	return line.length > SQLITE_ROWS_CELL_WIDTH
		? `${line.slice(0, SQLITE_ROWS_CELL_WIDTH - 1)}…`
		: line;
}

/**
 * `maestro-cli sqlite rows <path> <object>` - one window of a table's or
 * view's rows, the way the viewer's table view pages and sorts them.
 */
export async function sqliteRows(
	file: string,
	name: string,
	options: SqliteRowsOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	const offset = parseCount(options.offset, '--offset', 0, options.json);
	const limit = parseCount(options.limit, '--limit', SQLITE_ROWS_DEFAULT_LIMIT, options.json);
	if (options.desc && !options.sort) fail('--desc needs --sort <column>', options.json);
	const sort = options.sort
		? { column: options.sort, direction: options.desc ? ('desc' as const) : ('asc' as const) }
		: null;

	let reply: SqliteRowsReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteRowsReply>(
				{
					type: 'sqlite_read_rows',
					path: filePath,
					name,
					offset,
					limit,
					sort,
					filter: options.filter ?? null,
				},
				'sqlite_rows_result',
				SQLITE_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.page) {
		fail(reply.error || `Could not read rows of ${name} in ${filePath}`, options.json);
	}

	const { database, page } = reply;
	if (page.filterProblem) {
		// The viewer underlines the span; a terminal gets the span as a caret line.
		const problem = page.filterProblem;
		const filterText = options.filter ?? '';
		if (options.json) {
			console.log(
				JSON.stringify({
					success: false,
					error: problem.message,
					path: database.displayPath,
					filterProblem: problem,
				})
			);
			exitWith(ExitCode.GeneralError);
		}
		const marker = `${' '.repeat(problem.start)}${'^'.repeat(Math.max(1, problem.end - problem.start))}`;
		fail(`Filter problem: ${problem.message}\n  ${filterText}\n  ${marker}`, false);
	}
	if (options.json) {
		console.log(JSON.stringify({ success: true, path: database.displayPath, ...page }));
		return;
	}

	const lines: string[] = [`${page.name} in ${database.displayPath}`];
	if (page.rows.length === 0) {
		const none = page.filtered ? 'No matching rows' : 'No rows';
		lines.push('', offset > 0 ? `${none} past offset ${offset}.` : `${none}.`);
	} else {
		lines.push(
			'',
			formatTextTable(
				page.columns.map((column) => column.name),
				page.rows.map((row) => row.map((cell) => cellText(formatSqliteCell(cell).text)))
			)
		);
		const first = page.offset + 1;
		const last = page.offset + page.rows.length;
		lines.push(
			'',
			`${page.filtered ? 'Matching rows' : 'Rows'} ${first}-${last}${page.hasMore ? `; more follow (--offset ${last})` : ''}.`
		);
	}
	lines.push(
		page.orderedBy.length > 0
			? `Ordered by ${page.orderedBy.join(', ')}.`
			: 'Not ordered: rows come back in the order SQLite scans them.'
	);
	console.log(lines.join('\n'));
}
