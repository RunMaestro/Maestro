// SQLite commands - `maestro-cli sqlite ...`, the CLI half of the SQLite viewer.
//
//   maestro-cli sqlite info <path> [--check <quick|full>] [--json]
//       -> the summary strip: page size and count, free pages, encoding,
//          journal mode, user_version, application_id, and the integrity flag
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
//   maestro-cli sqlite count <path> <object> [--filter <expr>] [--json]
//       -> the table view's footer count: how many rows the filter matches,
//          counted to the end
//   maestro-cli sqlite blob <path> <object> <column> (--rowid <id> | --offset <n>)
//                           [--sort <column>] [--desc] [--filter <expr>]
//                           --output <file> [--json]
//       -> the record view's Save to file: one BLOB cell written whole
//   maestro-cli sqlite query <path> <sql> [--param <name=value>]...
//                            [--param-number <name=value>]... [--param-null <name>]...
//                            [--plan] [--offset <n>] [--limit <n>]
//                            [--output <file> [--format <csv|jsonl>]]
//                            [--enable-editing [--dry-run]] [--json]
//       -> Query mode's Run: one read-only statement, its parameters bound, a
//          window of its result (or, with --plan, its query plan as a tree);
//          with --output, Query mode's Export: every row written to a file;
//          with --enable-editing, a statement that changes the database runs
//          once, behind the editing gate and the session's backup; with
//          --dry-run as well, Query mode's Dry run: tried and rolled back
//   maestro-cli sqlite history <path> [--forget <id>] [--clear] [--json]
//       -> Query mode's History rail: the statements run against the file,
//          newest first; --forget drops one, --clear drops them all
//   maestro-cli sqlite set <path> <table> <column> (--rowid <id> | --key <col=value>...)
//                          (--value <text> | --value-number <n> | --null)
//                          [--if-version <v>] --enable-editing [--json]
//       -> the table view's cell edit: one single-row UPDATE keyed on the
//          row's rowid or primary key; --enable-editing is the per-call
//          unlock, and the session's first change backs the file up first;
//          --if-version refuses it when the row changed since it was read
//   maestro-cli sqlite insert <path> <table> [--value <col=value>]...
//                             [--value-number <col=n>]... [--null <col>]...
//                             --enable-editing [--json]
//       -> the table view's Insert row: one INSERT, columns not given taking
//          their DEFAULT; a constraint failure is reported in SQLite's words
//   maestro-cli sqlite delete <path> <table> (--rowid <id> | --key <col=value>...)
//                             [--if-version <v>] --enable-editing [--json]
//       -> the record view's Delete row: one single-row DELETE keyed on the
//          row's rowid or primary key, with the rows foreign-key actions and
//          triggers changed beside it counted
//   maestro-cli sqlite undo <path> --step <json | @file> --enable-editing [--json]
//       -> the viewer's Undo: apply the `undo` step a set, insert, or delete
//          returned (a cell back, an inserted row removed, a deleted row put
//          back whole), refused when the row changed since
//
// The CLI links no native modules, so it cannot open a database itself. Each
// verb rides a WS message (`sqlite_read_summary`, `sqlite_list_objects`, `sqlite_read_schema`,
// `sqlite_read_rows`, `sqlite_count_rows`, `sqlite_save_blob`, `sqlite_run_query`,
// `sqlite_export_query`, `sqlite_query_history`, `sqlite_update_cell`,
// `sqlite_insert_row`, `sqlite_delete_row`, `sqlite_undo_edit`, `sqlite_run_transaction`) to the running
// app, which answers with the same functions the viewer's `sqlite:*` IPC calls.
// The app must be running, and the database is opened read-only there (only
// `set`, `insert`, `delete`, `undo`, `transaction`, and `query --enable-editing` write, through the viewer's own editing gate and backup); a
// BLOB or an export is written to `--output` by the app, so its bytes never
// ride the socket.

import * as fs from 'fs';

import { withMaestroClient } from '../services/maestro-client';
import { failFromError } from '../services/session-command';
import { ExitCode, exitWith } from '../exit-codes';
import { formatTextTable } from '../output/formatter';
import { resolveCliPath } from '../utils/parse';
import { formatCount, formatRelativeTime, formatSize } from '../../shared/formatters';
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
	SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE,
	formatSqliteEditability,
	formatSqliteForeignKey,
	formatSqliteIndexColumn,
	sqliteColumnTags,
	sqliteMissingSqlNote,
} from '../../shared/sqlite/schema';
import { formatSqliteCell } from '../../shared/sqlite/cells';
import {
	SQLITE_EXPORT_TIMEOUT_MS,
	SQLITE_QUERY_MAX_LIMIT,
	SQLITE_QUERY_TIMEOUT_MS,
	sqliteQueryBinding,
	sqliteQueryParameters,
	sqliteQueryRefusal,
	sqliteReadOnlyRefusal,
} from '../../shared/sqlite/query';
import { formatSqliteQueryHistoryOutcome } from '../../shared/sqlite/history';
import { formatSqliteDryRun, sqliteWriteChangesText } from '../../shared/sqlite/dryRun';
import { formatSqliteTransactionChanges } from '../../shared/sqlite/transaction';
import {
	formatSqliteQueryErrorExcerpt,
	formatSqliteQueryErrorPlace,
	sqliteQueryErrorLocation,
} from '../../shared/sqlite/queryError';
import {
	isTabularExportFormat,
	tabularExportFormatForPath,
	type TabularExportFormat,
} from '../../shared/tabularExport';
import {
	SQLITE_QUERY_PLAN_KIND_HINTS,
	formatSqliteQueryPlan,
	sqliteQueryPlanSteps,
} from '../../shared/sqlite/plan';
import { formatSqliteIntegrity, sqliteSummaryFacts } from '../../shared/sqlite/summary';
import type {
	SqliteBackup,
	SqliteBlobSaved,
	SqliteCellUpdateResult,
	SqliteDatabaseInfo,
	SqliteDatabaseSummary,
	SqliteDryRun,
	SqliteFilterProblem,
	SqliteIntegrityMode,
	SqliteIntegrityResult,
	SqliteObjectKind,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
	SqliteObjectSummary,
	SqliteParameterValue,
	SqliteParameterValues,
	SqliteQueryExported,
	SqliteQueryHistory,
	SqliteQueryHistoryEntry,
	SqliteQueryResult,
	SqliteRowCount,
	SqliteRowDeleteResult,
	SqliteRowInsertResult,
	SqliteRowsPage,
	SqliteCellValue,
	SqliteKeyValue,
	SqliteRowKey,
	SqliteTransactionScript,
	SqliteUndoResult,
	SqliteUndoStep,
} from '../../shared/sqlite/types';
import {
	SQLITE_QUERY_WRITE_UNDO_MESSAGE,
	sqliteUndoOutcome,
	sqliteUndoUnavailableMessage,
} from '../../shared/sqlite/undo';
import { sqliteNumberBindValue } from '../../shared/sqlite/filter';

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

interface SqliteInfoOptions {
	check?: string;
	json?: boolean;
}

interface SqliteSummaryReply {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	summary?: SqliteDatabaseSummary;
	integrity?: SqliteIntegrityResult | null;
}

/** A full integrity check of a big file takes a while; give it room. */
const SQLITE_INTEGRITY_TIMEOUT_MS = 10 * 60_000;

/**
 * `maestro-cli sqlite info <path>` - the database-wide facts the viewer's
 * summary strip shows, plus the integrity flag when `--check` asks for it.
 */
export async function sqliteInfo(file: string, options: SqliteInfoOptions): Promise<void> {
	const filePath = resolveCliPath(file);
	let check: SqliteIntegrityMode | null = null;
	if (options.check !== undefined) {
		if (options.check !== 'quick' && options.check !== 'full') {
			fail(`--check must be quick or full (got "${options.check}")`, options.json);
		}
		check = options.check;
	}

	let reply: SqliteSummaryReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteSummaryReply>(
				{ type: 'sqlite_read_summary', path: filePath, ...(check ? { integrity: check } : {}) },
				'sqlite_summary_result',
				check ? SQLITE_INTEGRITY_TIMEOUT_MS : SQLITE_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.summary) {
		fail(reply.error || `Could not read ${filePath}`, options.json);
	}

	const { database, summary } = reply;
	const integrity = reply.integrity ?? null;
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				fileBytes: database.fileBytes,
				...summary,
				integrity,
			})
		);
		// A damaged file is a finding, not a failed call: the reply still
		// printed, and the exit code lets a script branch on it.
		if (integrity && !integrity.ok) exitWith(ExitCode.GeneralError);
		return;
	}

	const rows = sqliteSummaryFacts(summary).map((fact) => [fact.label, fact.value]);
	rows.push(['SQLite', summary.sqliteVersion]);
	rows.push([
		'Integrity',
		integrity ? formatSqliteIntegrity(integrity) : 'not checked (pass --check quick)',
	]);
	const lines = [`${database.displayPath} (${formatSize(database.fileBytes)})`, ''];
	const width = Math.max(...rows.map(([label]) => label.length));
	lines.push(...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`));
	if (integrity && !integrity.ok) {
		lines.push('', 'Problems');
		lines.push(...integrity.problems.map((problem) => `  ${problem}`));
		if (integrity.truncated) lines.push('  (more problems not listed)');
	}
	console.log(lines.join('\n'));
	if (integrity && !integrity.ok) exitWith(ExitCode.GeneralError);
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

	if (schema.editability) {
		lines.push('', 'Editing', `  ${formatSqliteEditability(schema.editability)}`);
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

/** Rows as a text table, one line per row, each cell cut to one line. */
function rowsTable(columnNames: string[], rows: SqliteCellValue[][]): string {
	return formatTextTable(
		columnNames,
		rows.map((row) => row.map((cell) => cellText(formatSqliteCell(cell).text)))
	);
}

/**
 * Exit on filter text that did not parse or bind. The viewer underlines the
 * span; a terminal gets the span as a caret line under the text.
 */
function failOnFilterProblem(
	problem: SqliteFilterProblem,
	filterText: string | undefined,
	displayPath: string,
	json: boolean | undefined
): never {
	if (json) {
		console.log(
			JSON.stringify({
				success: false,
				error: problem.message,
				path: displayPath,
				filterProblem: problem,
			})
		);
		exitWith(ExitCode.GeneralError);
	}
	const marker = `${' '.repeat(problem.start)}${'^'.repeat(Math.max(1, problem.end - problem.start))}`;
	fail(`Filter problem: ${problem.message}\n  ${filterText ?? ''}\n  ${marker}`, false);
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
		failOnFilterProblem(page.filterProblem, options.filter, database.displayPath, options.json);
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
			rowsTable(
				page.columns.map((column) => column.name),
				page.rows
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

interface SqliteCountOptions {
	filter?: string;
	json?: boolean;
}

interface SqliteCountReply {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	count?: SqliteRowCount;
}

/**
 * `maestro-cli sqlite count <path> <object>` - how many rows of a table or
 * view the filter matches. The viewer's footer shows this count converging
 * (`1,204+`); the CLI waits for the settled number.
 */
export async function sqliteCount(
	file: string,
	name: string,
	options: SqliteCountOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	let reply: SqliteCountReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteCountReply>(
				{ type: 'sqlite_count_rows', path: filePath, name, filter: options.filter ?? null },
				'sqlite_count_result',
				SQLITE_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.count) {
		fail(reply.error || `Could not count rows of ${name} in ${filePath}`, options.json);
	}

	const { database, count } = reply;
	if (count.filterProblem) {
		failOnFilterProblem(count.filterProblem, options.filter, database.displayPath, options.json);
	}
	if (options.json) {
		console.log(JSON.stringify({ success: true, path: database.displayPath, ...count }));
		return;
	}
	const noun = count.filtered ? 'matching rows' : 'rows';
	console.log(
		`${count.name} in ${database.displayPath}: ${formatSqliteRowCount({
			rowCount: count.matched,
			rowCountCapped: !count.complete,
		})} ${noun} (${count.elapsedMs} ms).`
	);
}

interface SqliteBlobOptions {
	rowid?: string;
	offset?: string;
	sort?: string;
	desc?: boolean;
	filter?: string;
	output?: string;
	json?: boolean;
}

interface SqliteBlobReply {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	saved?: SqliteBlobSaved;
}

/**
 * `maestro-cli sqlite blob <path> <object> <column>` - write one BLOB cell to a
 * file, whole, the way the viewer's record view saves it. The row is named by
 * its rowid (`sqlite rows --json` lists them) or by its position, which means
 * what `sqlite rows --offset <n> --limit 1` with the same sort and filter shows.
 */
export async function sqliteBlob(
	file: string,
	name: string,
	column: string,
	options: SqliteBlobOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!options.output) fail('--output <file> is required', options.json);
	if ((options.rowid === undefined) === (options.offset === undefined)) {
		fail('Name the row with exactly one of --rowid <id> or --offset <n>', options.json);
	}
	if (options.rowid !== undefined && !/^-?\d+$/.test(options.rowid)) {
		fail(`--rowid must be a whole number (got "${options.rowid}")`, options.json);
	}
	if (options.rowid !== undefined && (options.sort || options.filter)) {
		fail('--sort and --filter place a row by --offset; a --rowid needs neither', options.json);
	}
	if (options.desc && !options.sort) fail('--desc needs --sort <column>', options.json);
	const offset =
		options.offset === undefined ? null : parseCount(options.offset, '--offset', 0, options.json);
	const sort = options.sort
		? { column: options.sort, direction: options.desc ? ('desc' as const) : ('asc' as const) }
		: null;
	const destPath = resolveCliPath(options.output);

	let reply: SqliteBlobReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteBlobReply>(
				{
					type: 'sqlite_save_blob',
					path: filePath,
					name,
					column,
					rowid: options.rowid ?? null,
					offset,
					sort,
					filter: options.filter ?? null,
					destPath,
				},
				'sqlite_blob_result',
				SQLITE_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.saved) {
		fail(reply.error || `Could not save ${column} of ${name} in ${filePath}`, options.json);
	}

	const { database, saved } = reply;
	if (options.json) {
		// `path` is the database, as for every sqlite verb; `output` is the file written.
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				output: saved.path,
				bytes: saved.bytes,
				rowid: saved.rowid,
			})
		);
		return;
	}
	const from = saved.rowid !== null ? `rowid ${saved.rowid}` : `row ${(offset ?? 0) + 1}`;
	console.log(
		`Saved ${column} of ${name} (${from}) to ${saved.path}: ${formatSize(saved.bytes)} (${saved.bytes} bytes).`
	);
}

interface SqliteQueryOptions {
	offset?: string;
	limit?: string;
	/** `name=value` pairs bound as TEXT. */
	param?: string[];
	/** `name=value` pairs bound as numbers. */
	paramNumber?: string[];
	/** Names bound as NULL. */
	paramNull?: string[];
	/** Show the statement's `EXPLAIN QUERY PLAN` instead of its rows. */
	plan?: boolean;
	/** Write every row to this file instead (Query mode's Export). */
	output?: string;
	/** `csv` or `jsonl`; default from `--output`'s extension. */
	format?: string;
	/**
	 * The per-call unlock: lift the read-only assertion for this one run, the
	 * way a tab's "Enable editing" lifts it in Query mode.
	 */
	enableEditing?: boolean;
	/** Query mode's Dry run: classify, try in a transaction, roll back. Needs `enableEditing`. */
	dryRun?: boolean;
	json?: boolean;
}

/**
 * The Query panel's value boxes, from flags: `--param name=value` (TEXT),
 * `--param-number name=value`, `--param-null name`. A name is a parameter's
 * label as the panel shows it (`:id`, `?1`) or the same without its sigil
 * (`id`, `1`). Throws a message naming the statement's parameters when a
 * flag names none of them, or names one twice.
 */
export function sqliteQueryParamsFromFlags(
	sql: string,
	options: Pick<SqliteQueryOptions, 'param' | 'paramNumber' | 'paramNull'>
): SqliteParameterValues {
	const { parameters } = sqliteQueryParameters(sql);
	const known = parameters.map((parameter) => parameter.label).join(', ') || 'none';
	const values: SqliteParameterValues = {};
	const assign = (name: string, value: SqliteParameterValue, flag: string) => {
		const parameter = parameters.find(
			(candidate) => candidate.label === name || candidate.label.slice(1) === name
		);
		if (!parameter) {
			throw new Error(`${flag} ${name}: the statement has no such parameter (it has: ${known})`);
		}
		if (values[parameter.label]) {
			throw new Error(`${parameter.label} is given more than once`);
		}
		values[parameter.label] = value;
	};
	const pairs = (flag: string, list: string[] | undefined, type: 'text' | 'number') => {
		for (const pair of list ?? []) {
			const equals = pair.indexOf('=');
			if (equals <= 0) throw new Error(`${flag} takes name=value (got "${pair}")`);
			assign(pair.slice(0, equals), { type, text: pair.slice(equals + 1) }, flag);
		}
	};
	pairs('--param', options.param, 'text');
	pairs('--param-number', options.paramNumber, 'number');
	for (const name of options.paramNull ?? [])
		assign(name, { type: 'null', text: '' }, '--param-null');
	return values;
}

interface SqliteQueryReply {
	type: string;
	success: boolean;
	error?: string;
	/** Where in the statement SQLite stopped, for a syntax error. */
	errorOffset?: number;
	database?: SqliteDatabaseInfo;
	result?: SqliteQueryResult;
}

/**
 * Fail a query run with its error, pointed at the statement the way the
 * Query panel underlines it: the line holding the error with carets under
 * the span (text), or `location` beside `error` (JSON). An error that names
 * no place is printed as it is.
 */
function failQuery(
	message: string,
	sql: string,
	offset: number | undefined,
	json: boolean | undefined
): never {
	const location = sqliteQueryErrorLocation(sql, message, offset);
	if (!location) return fail(message, json);
	if (json) {
		console.log(JSON.stringify({ success: false, error: message, location }));
	} else {
		console.error(
			[
				`Error: ${message}`,
				`${formatSqliteQueryErrorPlace(location)}:`,
				...formatSqliteQueryErrorExcerpt(sql, location),
			].join('\n')
		);
	}
	return exitWith(ExitCode.GeneralError);
}

/**
 * `maestro-cli sqlite query <path> <sql>` - run one read-only statement the
 * way the viewer's Query mode runs it (its own connection in a child process
 * in the app, stopped at the same timeout) and print a window of the result.
 * A statement that would write is refused, not run. With `--plan`, the
 * statement's `EXPLAIN QUERY PLAN` is shown as a tree instead (Query mode's
 * Plan toggle); `--offset` and `--limit` do not apply, since a plan is
 * shown whole. With `--output`, every row is written to that file as CSV or
 * JSON Lines instead (Query mode's Export), whole, by the app. With
 * `--enable-editing`, the read-only assertion is lifted for this one run, the
 * way a tab's "Enable editing" lifts it: a statement that changes the
 * database runs once, after the session's backup, and the reply says how
 * many rows it changed. With `--dry-run` as well, nothing is changed: the
 * reply says what kind of statement it is and what a trial run, rolled back,
 * changed (`formatSqliteDryRun()`).
 */
export async function sqliteQuery(
	file: string,
	sql: string,
	options: SqliteQueryOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!sql.trim()) fail('Give the statement to run, e.g. "SELECT * FROM users"', options.json);
	const plan = options.plan === true;
	if (options.output !== undefined && plan) {
		fail("--output writes the statement's rows; it does not take --plan", options.json);
	}
	if (options.format !== undefined && options.output === undefined) {
		fail('--format needs --output <file>', options.json);
	}
	if (options.format !== undefined && !isTabularExportFormat(options.format)) {
		fail(`--format must be csv or jsonl (got "${options.format}")`, options.json);
	}
	const editing = options.enableEditing === true;
	if (editing && options.output !== undefined) {
		fail('--output exports a read-only statement; it does not take --enable-editing', options.json);
	}
	const dryRun = options.dryRun === true;
	if (dryRun) {
		if (!editing) {
			fail('--dry-run tries a change and rolls it back; it needs --enable-editing', options.json);
		}
		if (plan) fail('--dry-run tries the statement itself; it does not take --plan', options.json);
		if (options.output !== undefined) {
			fail(
				'--dry-run changes nothing and exports nothing; it does not take --output',
				options.json
			);
		}
		if (options.offset !== undefined && options.offset !== '0') {
			fail('--dry-run reads the first rows only; it does not take --offset', options.json);
		}
	}
	// A plan is shown whole and an export writes every row: no window applies.
	const whole = plan || options.output !== undefined;
	const offset = whole ? 0 : parseCount(options.offset, '--offset', 0, options.json);
	const limit = whole
		? SQLITE_QUERY_MAX_LIMIT
		: parseCount(options.limit, '--limit', SQLITE_ROWS_DEFAULT_LIMIT, options.json);
	if (limit > SQLITE_QUERY_MAX_LIMIT) {
		fail(`--limit must be at most ${SQLITE_QUERY_MAX_LIMIT} (got ${limit})`, options.json);
	}
	let params: SqliteParameterValues;
	try {
		params = sqliteQueryParamsFromFlags(sql, options);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
	// A parameter with no value (or a Number that is not one) is settled here,
	// without the app, the way the panel settles it without a process.
	const { problem } = sqliteQueryBinding(sql, params);
	if (problem) fail(problem, options.json);
	if (options.output !== undefined) {
		const refusal = sqliteReadOnlyRefusal(sql);
		if (refusal) failQuery(refusal, sql, undefined, options.json);
		await exportSqliteQueryResult(filePath, sql, params, options);
		return;
	}

	// Settled here, without the app, the way the panel settles it without a process.
	const refusal = sqliteQueryRefusal(sql, { plan, editing });
	if (refusal) failQuery(refusal, sql, undefined, options.json);

	let reply: SqliteQueryReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteQueryReply>(
				{
					type: 'sqlite_run_query',
					path: filePath,
					sql,
					offset,
					limit,
					params,
					plan,
					...(editing ? { enableEditing: true } : {}),
					...(dryRun ? { dryRun: true } : {}),
				},
				'sqlite_query_result',
				// The app stops the run at its own timeout; leave room for the reply.
				// With editing, the session's first change also waits for the backup.
				(editing ? SQLITE_EXPORT_TIMEOUT_MS : 0) + SQLITE_QUERY_TIMEOUT_MS + 30_000
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.result) {
		if (reply.error) failQuery(reply.error, sql, reply.errorOffset, options.json);
		fail(`Could not run the query on ${filePath}`, options.json);
	}

	const { database, result } = reply;
	if (plan) {
		printSqliteQueryPlan(database, result, options.json);
		return;
	}
	if (options.json) {
		console.log(JSON.stringify({ success: true, path: database.displayPath, ...result }));
		return;
	}

	if (result.dryRun) {
		printSqliteDryRun(database, result, result.dryRun);
		return;
	}
	const lines: string[] = [`${result.statement} on ${database.displayPath}`];
	const { write } = result;
	if (write) {
		// "Changed 3 rows.", "Created table logs, index logs_at."
		const changed = sqliteWriteChangesText(write);
		lines.push(
			'',
			`${changed.charAt(0).toUpperCase()}${changed.slice(1)}.`,
			...writeNoteLines(database, write),
			SQLITE_QUERY_WRITE_UNDO_MESSAGE
		);
	}
	if (!result.returnsRows) {
		if (!write) lines.push('', 'The statement ran and returns no rows.');
	} else if (result.rows.length === 0) {
		lines.push('', offset > 0 ? `No rows past offset ${offset}.` : 'No rows.');
	} else {
		lines.push(
			'',
			rowsTable(
				result.columns.map((column) => column.name),
				result.rows
			)
		);
		const last = result.offset + result.rows.length;
		// A statement that changed the database runs once: its later rows are not read again.
		const more = write
			? '; it returned more, not shown (it runs once, so a later window cannot be read)'
			: `; more follow (--offset ${last})`;
		lines.push('', `Rows ${result.offset + 1}-${last}${result.hasMore ? more : ''}.`);
	}
	lines.push(`${result.elapsedMs} ms.`);
	console.log(lines.join('\n'));
}

/**
 * A `--dry-run` reply: what the statement is and what its trial changed
 * before it was rolled back (`formatSqliteDryRun()`, the Query panel's own
 * sentence), then any rows its `RETURNING` gave in the trial.
 */
function printSqliteDryRun(
	database: SqliteDatabaseInfo,
	result: SqliteQueryResult,
	dryRun: SqliteDryRun
): void {
	const lines: string[] = [
		`Dry run of ${result.statement} on ${database.displayPath}`,
		'',
		formatSqliteDryRun(dryRun),
	];
	if (result.returnsRows && result.rows.length > 0) {
		lines.push(
			'',
			'It would return:',
			rowsTable(
				result.columns.map((column) => column.name),
				result.rows
			)
		);
		if (result.hasMore) lines.push('', 'More rows would follow, not shown.');
	}
	if (dryRun.tried) lines.push(`${result.elapsedMs} ms.`);
	console.log(lines.join('\n'));
}

/**
 * A `--plan` reply: the tree the `sqlite3` shell draws, then one line on
 * each kind of costly step it holds (a full scan, a temporary sort). `--json`
 * adds the steps, tree guides included, beside the raw plan rows.
 */
function printSqliteQueryPlan(
	database: SqliteDatabaseInfo,
	result: SqliteQueryResult,
	json: boolean | undefined
): void {
	const steps = sqliteQueryPlanSteps(result.rows);
	if (json) {
		console.log(JSON.stringify({ success: true, path: database.displayPath, ...result, steps }));
		return;
	}
	const lines: string[] = [
		`Plan of ${result.statement} on ${database.displayPath}`,
		'',
		formatSqliteQueryPlan(steps),
	];
	const costly = (['scan', 'sort'] as const).filter((kind) =>
		steps.some((step) => step.kind === kind)
	);
	if (costly.length > 0) {
		lines.push('', ...costly.map((kind) => SQLITE_QUERY_PLAN_KIND_HINTS[kind]));
	}
	if (result.hasMore) lines.push('', `Only the first ${result.rows.length} steps are shown.`);
	lines.push('', `${result.elapsedMs} ms.`);
	console.log(lines.join('\n'));
}

interface SqliteExportReply {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	exported?: SqliteQueryExported;
}

const EXPORT_FORMAT_LABELS: Record<TabularExportFormat, string> = {
	csv: 'CSV',
	jsonl: 'JSON Lines',
};

/** `sqlite query --output`: the app writes every row of the statement to the file. */
async function exportSqliteQueryResult(
	filePath: string,
	sql: string,
	params: SqliteParameterValues,
	options: SqliteQueryOptions
): Promise<void> {
	const destPath = resolveCliPath(options.output ?? '');
	const format = isTabularExportFormat(options.format)
		? options.format
		: tabularExportFormatForPath(destPath);

	let reply: SqliteExportReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteExportReply>(
				{ type: 'sqlite_export_query', path: filePath, sql, params, destPath, format },
				'sqlite_export_result',
				// The app stops the export at its own timeout; leave room for the reply.
				SQLITE_EXPORT_TIMEOUT_MS + 30_000
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.exported) {
		fail(reply.error || `Could not export the query on ${filePath}`, options.json);
	}

	const { database, exported } = reply;
	if (options.json) {
		// `path` is the database, as for every sqlite verb; `output` is the file written.
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				output: exported.path,
				format: exported.format,
				rows: exported.rows,
				columns: exported.columns,
				bytes: exported.bytes,
				elapsedMs: exported.elapsedMs,
			})
		);
		return;
	}
	const rows = `${exported.rows} ${exported.rows === 1 ? 'row' : 'rows'}`;
	console.log(
		`Exported ${rows} (${exported.columns} ${exported.columns === 1 ? 'column' : 'columns'}) to ${exported.path} as ${EXPORT_FORMAT_LABELS[exported.format]}: ${formatSize(exported.bytes)}. ${exported.elapsedMs} ms.`
	);
}

interface SqliteHistoryOptions {
	/** Forget the entry with this id (or a unique start of it). */
	forget?: string;
	/** Forget every entry. */
	clear?: boolean;
	json?: boolean;
}

interface SqliteHistoryReply {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	history?: SqliteQueryHistory;
	removed?: number;
}

/** The characters of an entry id the text listing shows; `--forget` takes them. */
const HISTORY_ID_CHARS = 8;

/** One entry as the text listing shows it: id, age, outcome, then the statement and its values. */
function historyEntryLines(entry: SqliteQueryHistoryEntry): string[] {
	const facts = [
		entry.id.slice(0, HISTORY_ID_CHARS),
		formatRelativeTime(entry.ranAt),
		formatSqliteQueryHistoryOutcome(entry.outcome),
		...(entry.plan ? ['plan'] : []),
		...(entry.runs > 1 ? [`ran ${entry.runs} times`] : []),
	];
	const lines = [facts.join('  '), ...entry.sql.split('\n').map((line) => `    ${line}`)];
	for (const [label, value] of Object.entries(entry.params)) {
		lines.push(
			`    ${label} = ${value.type === 'null' ? 'NULL' : `${JSON.stringify(value.text)}${value.type === 'number' ? ' (number)' : ''}`}`
		);
	}
	if (!entry.outcome.ok) lines.push(`    ${entry.outcome.error}`);
	return lines;
}

/**
 * `maestro-cli sqlite history <path>` - the statements run against a
 * database, newest first, as Query mode's History rail lists them (runs
 * from the viewer and from `sqlite query` alike). `--forget <id>` drops one
 * entry and `--clear` drops them all; either prints what is left.
 */
export async function sqliteHistory(file: string, options: SqliteHistoryOptions): Promise<void> {
	const filePath = resolveCliPath(file);
	if (options.forget !== undefined && options.clear) {
		fail('Give --forget <id> or --clear, not both', options.json);
	}
	if (options.forget !== undefined && !options.forget.trim()) {
		fail('--forget takes an entry id (`sqlite history` lists them)', options.json);
	}

	let reply: SqliteHistoryReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteHistoryReply>(
				{
					type: 'sqlite_query_history',
					path: filePath,
					...(options.forget !== undefined ? { forget: options.forget.trim() } : {}),
					...(options.clear ? { clear: true } : {}),
				},
				'sqlite_history_result',
				SQLITE_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.history) {
		fail(reply.error || `Could not read the query history of ${filePath}`, options.json);
	}

	const { database, history } = reply;
	const removed = reply.removed ?? 0;
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				...(options.forget !== undefined || options.clear ? { removed } : {}),
				entries: history.entries,
			})
		);
		return;
	}

	const lines: string[] = [];
	if (options.forget !== undefined || options.clear) {
		lines.push(`Forgot ${removed} ${removed === 1 ? 'statement' : 'statements'}.`, '');
	}
	if (history.entries.length === 0) {
		lines.push(`No queries have run against ${database.displayPath}.`);
	} else {
		const count = history.entries.length;
		lines.push(
			`Query history of ${database.displayPath}: ${count} ${count === 1 ? 'statement' : 'statements'}, newest first.`
		);
		for (const entry of history.entries) lines.push('', ...historyEntryLines(entry));
	}
	console.log(lines.join('\n'));
}

interface SqliteSetOptions {
	rowid?: string;
	/** `column=value` pairs naming the row by its primary key, as TEXT. */
	key?: string[];
	/** `column=value` pairs naming the row by its primary key, as numbers. */
	keyNumber?: string[];
	/** The new value, as TEXT. */
	value?: string;
	/** The new value, as a number. */
	valueNumber?: string;
	/** Set the cell to NULL. */
	null?: boolean;
	/** The row's version from `sqlite rows --json`: change nothing if it moved on. */
	ifVersion?: string;
	/** The per-call unlock: without it nothing is written. */
	enableEditing?: boolean;
	json?: boolean;
}

/**
 * The row a `sqlite set` names, from flags: `--rowid <id>`, or one `--key`
 * / `--key-number column=value` per primary-key column. Throws a message on
 * a malformed flag, a column given twice, or both forms at once.
 */
export function sqliteRowKeyFromFlags(
	options: Pick<SqliteSetOptions, 'rowid' | 'key' | 'keyNumber'>
): SqliteRowKey {
	const keyFlags = [...(options.key ?? []), ...(options.keyNumber ?? [])];
	if ((options.rowid === undefined) === (keyFlags.length === 0)) {
		throw new Error(
			'Name the row with --rowid <id>, or with --key column=value for each key column'
		);
	}
	if (options.rowid !== undefined) {
		if (!/^-?\d+$/.test(options.rowid)) {
			throw new Error(`--rowid must be a whole number (got "${options.rowid}")`);
		}
		return { kind: 'rowid', rowid: options.rowid };
	}
	const values: Record<string, SqliteKeyValue> = {};
	const pairs = (flag: string, list: string[] | undefined, numeric: boolean) => {
		for (const pair of list ?? []) {
			const equals = pair.indexOf('=');
			if (equals <= 0) throw new Error(`${flag} takes column=value (got "${pair}")`);
			const column = pair.slice(0, equals);
			const text = pair.slice(equals + 1);
			if (Object.prototype.hasOwnProperty.call(values, column)) {
				throw new Error(`Key column ${column} is given more than once`);
			}
			if (!numeric) {
				values[column] = { type: 'text', text };
				continue;
			}
			const number = sqliteNumberBindValue(text.trim());
			if (number === null) throw new Error(`${flag} ${column}: "${text}" is not a number`);
			// The number parser reads text with a point or an exponent as a REAL.
			values[column] = { type: /[.eE]/.test(text) ? 'real' : 'integer', text: String(number) };
		}
	};
	pairs('--key', options.key, false);
	pairs('--key-number', options.keyNumber, true);
	return { kind: 'primary-key', values };
}

/** The new value a `sqlite set` writes, from exactly one of its value flags. */
export function sqliteCellValueFromFlags(
	options: Pick<SqliteSetOptions, 'value' | 'valueNumber' | 'null'>
): SqliteParameterValue {
	const given = [
		options.value !== undefined,
		options.valueNumber !== undefined,
		options.null === true,
	];
	if (given.filter(Boolean).length !== 1) {
		throw new Error('Give the new value with exactly one of --value, --value-number, or --null');
	}
	if (options.null) return { type: 'null', text: '' };
	if (options.valueNumber !== undefined) return { type: 'number', text: options.valueNumber };
	return { type: 'text', text: options.value ?? '' };
}

/**
 * `maestro-cli sqlite set <path> <table> <column>` - change one cell the way
 * the viewer's table view does: one parameterised UPDATE of the row named by
 * its rowid or primary key, in the app, refused unless `--enable-editing`
 * unlocks editing for this call (the tab's "Enable editing"). The first
 * change of a session backs the file up beside itself first.
 */
export async function sqliteSet(
	file: string,
	name: string,
	column: string,
	options: SqliteSetOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!options.enableEditing) fail(SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE, options.json);
	let row: SqliteRowKey;
	let value: SqliteParameterValue;
	try {
		row = sqliteRowKeyFromFlags(options);
		value = sqliteCellValueFromFlags(options);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	const { database, result } = await sendSqliteWrite<SqliteCellUpdateResult>(
		{
			type: 'sqlite_update_cell',
			path: filePath,
			name,
			column,
			row,
			value,
			...(options.ifVersion !== undefined ? { version: options.ifVersion } : {}),
		},
		'sqlite_update_result',
		`Could not change ${column} of ${name} in ${filePath}`,
		options.json
	);
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				name: result.name,
				column: result.column,
				columns: result.columns.map((entry) => entry.name),
				row: result.row,
				key: result.key,
				version: result.version,
				otherChanges: result.otherChanges,
				undo: result.undo,
				backup: result.backup ?? null,
				elapsedMs: result.elapsedMs,
			})
		);
		return;
	}
	const position = result.columns.findIndex((entry) => entry.name === result.column);
	const cell = position >= 0 ? formatSqliteCell(result.row[position] ?? null).text : '';
	const lines = [
		`Set ${result.column} of ${result.name} (${rowKeyText(result.key)}) to ${cell}.`,
		...writeNoteLines(database, result),
	];
	console.log(lines.join('\n'));
}

/** A row's key as a line names it: `rowid 42`, or `org = acme, name = ada`. */
function rowKeyText(key: SqliteRowKey): string {
	return key.kind === 'rowid'
		? `rowid ${key.rowid}`
		: Object.entries(key.values)
				.map(
					([keyColumn, keyValue]) => `${keyColumn} = ${keyValue === null ? 'NULL' : keyValue.text}`
				)
				.join(', ');
}

/**
 * What a write did beside its own row, where the session's backup went, and
 * how to undo it: the step `sqlite undo --step` takes, or why there is none.
 */
function writeNoteLines(
	database: SqliteDatabaseInfo,
	result: { otherChanges?: number; backup?: SqliteBackup; undo?: SqliteUndoStep | null }
): string[] {
	const lines: string[] = [];
	if (result.otherChanges) {
		lines.push(
			`The database's triggers and foreign-key actions changed ${formatCount(result.otherChanges)} other ${result.otherChanges === 1 ? 'row' : 'rows'}.`
		);
	}
	if (result.undo) {
		lines.push(`Undo step (give it to sqlite undo --step): ${JSON.stringify(result.undo)}`);
	} else if (result.undo === null) {
		lines.push(sqliteUndoUnavailableMessage(result.otherChanges ?? 0));
	}
	if (result.backup) {
		lines.push(
			`Backed up ${database.displayPath} before this first change: ${result.backup.path} (${formatSize(result.backup.bytes)}).`
		);
	}
	return lines;
}

/** Send one write verb's message and return its reply, or exit with its failure. */
async function sendSqliteWrite<T>(
	message: Record<string, unknown>,
	replyType: string,
	failure: string,
	json: boolean | undefined,
	// The first change of a session waits for the backup.
	timeoutMs = SQLITE_EXPORT_TIMEOUT_MS + 60_000
): Promise<{ database: SqliteDatabaseInfo; result: T }> {
	let reply: SqliteWriteReply<T>;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteWriteReply<T>>(
				{ ...message, enableEditing: true },
				replyType,
				timeoutMs
			)
		);
	} catch (error) {
		failFromError(error, json);
	}
	if (!reply.success || !reply.database || !reply.result) fail(reply.error || failure, json);
	return { database: reply.database, result: reply.result };
}

interface SqliteWriteReply<T> {
	type: string;
	success: boolean;
	error?: string;
	database?: SqliteDatabaseInfo;
	result?: T;
}

interface SqliteInsertOptions {
	/** `column=value` pairs, bound as TEXT. */
	value?: string[];
	/** `column=value` pairs, bound as numbers. */
	valueNumber?: string[];
	/** Columns set to NULL. */
	null?: string[];
	/** The per-call unlock: without it nothing is written. */
	enableEditing?: boolean;
	json?: boolean;
}

/**
 * The values a `sqlite insert` writes, keyed by column, from its repeatable
 * `--value`, `--value-number column=value` and `--null column` flags. Throws
 * a message on a malformed pair or a column given twice.
 */
export function sqliteInsertValuesFromFlags(
	options: Pick<SqliteInsertOptions, 'value' | 'valueNumber' | 'null'>
): Record<string, SqliteParameterValue> {
	const values: Record<string, SqliteParameterValue> = {};
	const assign = (column: string, value: SqliteParameterValue) => {
		if (Object.prototype.hasOwnProperty.call(values, column)) {
			throw new Error(`Column ${column} is given more than once`);
		}
		values[column] = value;
	};
	const pairs = (flag: string, list: string[] | undefined, type: 'text' | 'number') => {
		for (const pair of list ?? []) {
			const equals = pair.indexOf('=');
			if (equals <= 0) throw new Error(`${flag} takes column=value (got "${pair}")`);
			assign(pair.slice(0, equals), { type, text: pair.slice(equals + 1) });
		}
	};
	pairs('--value', options.value, 'text');
	pairs('--value-number', options.valueNumber, 'number');
	for (const column of options.null ?? []) {
		if (!column) throw new Error('--null takes a column name');
		assign(column, { type: 'null', text: '' });
	}
	return values;
}

/**
 * `maestro-cli sqlite insert <path> <table>` - add one row the way the
 * viewer's Insert row does: one parameterised INSERT, columns not given
 * taking their DEFAULT, in the app, refused unless `--enable-editing`
 * unlocks editing for this call. A constraint SQLite refuses the row on is
 * reported in SQLite's words.
 */
export async function sqliteInsert(
	file: string,
	name: string,
	options: SqliteInsertOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!options.enableEditing) fail(SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE, options.json);
	let values: Record<string, SqliteParameterValue>;
	try {
		values = sqliteInsertValuesFromFlags(options);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	const { database, result } = await sendSqliteWrite<SqliteRowInsertResult>(
		{ type: 'sqlite_insert_row', path: filePath, name, values },
		'sqlite_insert_result',
		`Could not insert a row into ${name} in ${filePath}`,
		options.json
	);
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				name: result.name,
				columns: result.columns.map((entry) => entry.name),
				row: result.row,
				key: result.key,
				version: result.version,
				otherChanges: result.otherChanges,
				undo: result.undo,
				backup: result.backup ?? null,
				elapsedMs: result.elapsedMs,
			})
		);
		return;
	}
	console.log(
		[
			`Inserted a row into ${result.name} (${rowKeyText(result.key)}):`,
			rowsTable(
				result.columns.map((entry) => entry.name),
				[result.row]
			),
			...writeNoteLines(database, result),
		].join('\n')
	);
}

interface SqliteDeleteOptions extends Pick<
	SqliteSetOptions,
	'rowid' | 'key' | 'keyNumber' | 'ifVersion'
> {
	/** The per-call unlock: without it nothing is written. */
	enableEditing?: boolean;
	json?: boolean;
}

/**
 * `maestro-cli sqlite delete <path> <table>` - remove one row the way the
 * record view's Delete row does: one parameterised DELETE of the row named by
 * its rowid or primary key, in the app, refused unless `--enable-editing`
 * unlocks editing for this call. Rows the database's foreign-key actions and
 * triggers changed as a result are counted.
 */
export async function sqliteDelete(
	file: string,
	name: string,
	options: SqliteDeleteOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!options.enableEditing) fail(SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE, options.json);
	let row: SqliteRowKey;
	try {
		row = sqliteRowKeyFromFlags(options);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	const { database, result } = await sendSqliteWrite<SqliteRowDeleteResult>(
		{
			type: 'sqlite_delete_row',
			path: filePath,
			name,
			row,
			...(options.ifVersion !== undefined ? { version: options.ifVersion } : {}),
		},
		'sqlite_delete_result',
		`Could not delete the row from ${name} in ${filePath}`,
		options.json
	);
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				name: result.name,
				key: result.key,
				otherChanges: result.otherChanges,
				undo: result.undo,
				backup: result.backup ?? null,
				elapsedMs: result.elapsedMs,
			})
		);
		return;
	}
	console.log(
		[
			`Deleted the row with ${rowKeyText(result.key)} from ${result.name}.`,
			...writeNoteLines(database, result),
		].join('\n')
	);
}

interface SqliteUndoOptions {
	/** The step a write returned (`undo` in its `--json`), as JSON, or `@file` holding it. */
	step?: string;
	/** The per-call unlock: without it nothing is written. */
	enableEditing?: boolean;
	json?: boolean;
}

/**
 * The step a `sqlite undo` applies, from `--step`: the JSON itself, or
 * `@path` naming a file that holds it. Throws a message when it is missing,
 * unreadable, or not a JSON object; main checks the rest.
 */
export function sqliteUndoStepFromFlag(step: string | undefined): SqliteUndoStep {
	if (!step) {
		throw new Error(
			'Give the undo step with --step: the `undo` a write printed with --json, or @file holding it'
		);
	}
	let text = step;
	if (step.startsWith('@')) {
		const stepPath = resolveCliPath(step.slice(1));
		try {
			text = fs.readFileSync(stepPath, 'utf8');
		} catch (error) {
			throw new Error(
				`Could not read the undo step from ${stepPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('--step is not JSON: give the `undo` object a write printed with --json');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('--step must be a JSON object: the `undo` a write printed with --json');
	}
	return parsed as SqliteUndoStep;
}

/**
 * `maestro-cli sqlite undo <path>` - take back one write the way the viewer's
 * Undo does: apply the `undo` step that `sqlite set`, `insert`, or `delete`
 * returned, as one single-row write in the app, refused unless
 * `--enable-editing` unlocks editing for this call. A row changed since the
 * write is refused, never overwritten.
 */
export async function sqliteUndo(file: string, options: SqliteUndoOptions): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!options.enableEditing) fail(SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE, options.json);
	let step: SqliteUndoStep;
	try {
		step = sqliteUndoStepFromFlag(options.step);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	const { database, result } = await sendSqliteWrite<SqliteUndoResult>(
		{ type: 'sqlite_undo_edit', path: filePath, step },
		'sqlite_undo_result',
		`Could not undo the change to ${filePath}`,
		options.json
	);
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				path: database.displayPath,
				name: result.name,
				kind: result.kind,
				key: result.key,
				otherChanges: result.otherChanges,
				backup: result.backup ?? null,
				elapsedMs: result.elapsedMs,
			})
		);
		return;
	}
	console.log(
		[
			`${sqliteUndoOutcome(step, result)}: ${rowKeyText(result.key)}.`,
			// The outcome already counts the other rows.
			...writeNoteLines(database, { backup: result.backup }),
		].join('\n')
	);
}

interface SqliteTransactionOptions {
	/** Commit when every statement ran (the default is to roll back). */
	commit?: boolean;
	/** Roll back at the end, whatever ran: see what the statements do, keep nothing. */
	rollback?: boolean;
	/** Rows to show per statement that returns rows. */
	limit?: string;
	/** The per-call unlock: without it nothing is written. */
	enableEditing?: boolean;
	json?: boolean;
}

/**
 * `maestro-cli sqlite transaction <path> <sql...>` - Query mode's explicit
 * transaction in one call, since the CLI has no tab to keep one open in:
 * Begin (the session's backup first), each statement in order inside it,
 * reads seeing the writes before them, then `--commit` or `--rollback`
 * (one of the two is required, so keeping the change is always a choice).
 * The first statement that fails stops it, and the transaction is rolled
 * back, as it is when SQLite refuses the Commit. Prints each statement's
 * outcome, any rows it returned, and how the transaction ended
 * (`sqliteTransactionEndReason()`); exits non-zero when anything failed.
 */
export async function sqliteTransaction(
	file: string,
	statements: string[],
	options: SqliteTransactionOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!options.enableEditing) fail(SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE, options.json);
	if (options.commit === options.rollback) {
		fail(
			'Say how the transaction ends: --commit keeps what it changed, --rollback discards it',
			options.json
		);
	}
	if (statements.length === 0 || statements.some((sql) => !sql.trim())) {
		fail(
			'Give each statement to run as its own argument, e.g. "UPDATE ..." "SELECT ..."',
			options.json
		);
	}
	const limit = parseCount(options.limit, '--limit', SQLITE_ROWS_DEFAULT_LIMIT, options.json);
	if (limit > SQLITE_QUERY_MAX_LIMIT) {
		fail(`--limit must be at most ${SQLITE_QUERY_MAX_LIMIT} (got ${limit})`, options.json);
	}
	// Settled here, without the app, the way the panel settles a run without a process.
	for (const [index, sql] of statements.entries()) {
		const refusal =
			sqliteQueryRefusal(sql, { editing: true }) ?? sqliteQueryBinding(sql, {}).problem;
		if (refusal) {
			if (!options.json) console.error(`Statement ${index + 1} is refused; nothing ran.`);
			failQuery(refusal, sql, undefined, options.json);
		}
	}

	const { database, result } = await sendSqliteWrite<SqliteTransactionScript>(
		{
			type: 'sqlite_run_transaction',
			path: filePath,
			statements,
			end: options.commit ? 'commit' : 'rollback',
			limit,
		},
		'sqlite_transaction_result',
		`Could not run the transaction on ${filePath}`,
		options.json,
		// The backup, then each statement at most the query timeout, then the end.
		SQLITE_EXPORT_TIMEOUT_MS + (statements.length + 1) * SQLITE_QUERY_TIMEOUT_MS + 60_000
	);
	if (options.json) {
		console.log(
			JSON.stringify({ success: result.failed === null, path: database.displayPath, ...result })
		);
		if (result.failed) exitWith(ExitCode.GeneralError);
		return;
	}

	const lines: string[] = [`Transaction on ${database.displayPath}`];
	for (const [index, step] of result.steps.entries()) {
		lines.push('', `${index + 1}. ${sqliteTransactionStepText(step)}`);
		if (step.returnsRows && step.rows.length > 0) {
			lines.push(
				rowsTable(
					step.columns.map((column) => column.name),
					step.rows
				)
			);
			if (step.hasMore) lines.push('More rows followed, not shown.');
		}
	}
	const { failed } = result;
	if (failed) {
		const sql = failed.index === null ? 'COMMIT' : statements[failed.index];
		const label = failed.index === null ? 'The Commit' : `Statement ${failed.index + 1}`;
		const location =
			failed.index === null
				? null
				: sqliteQueryErrorLocation(sql, failed.error, failed.errorOffset);
		lines.push('', `${label} failed: ${failed.error}`);
		if (location) {
			lines.push(
				`${formatSqliteQueryErrorPlace(location)}:`,
				...formatSqliteQueryErrorExcerpt(sql, location)
			);
		}
	}
	lines.push('', result.end.reason, ...writeNoteLines(database, { backup: result.begun.backup }));
	if (failed) {
		console.error(lines.join('\n'));
		exitWith(ExitCode.GeneralError);
	}
	console.log(lines.join('\n'));
}

/** "UPDATE changed 3 rows (and 2 other rows by triggers ...)", "SELECT returned 4 rows". */
function sqliteTransactionStepText(step: SqliteQueryResult): string {
	const inTransaction = step.inTransaction;
	if (inTransaction?.writes) {
		const others = inTransaction.otherChanges;
		return `${step.statement} changed ${formatCount(inTransaction.changes)} ${inTransaction.changes === 1 ? 'row' : 'rows'}${
			others > 0
				? `, and ${formatCount(others)} other ${others === 1 ? 'row' : 'rows'} by triggers and foreign-key actions`
				: ''
		}. Held so far: ${formatSqliteTransactionChanges(inTransaction.transaction)}.`;
	}
	if (!step.returnsRows) return `${step.statement} ran and returns no rows.`;
	const count = step.rows.length;
	return `${step.statement} returned ${formatCount(count)}${step.hasMore ? '+' : ''} ${count === 1 && !step.hasMore ? 'row' : 'rows'}.`;
}
