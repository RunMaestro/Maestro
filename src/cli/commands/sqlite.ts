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
//                            [--plan] [--offset <n>] [--limit <n>] [--json]
//       -> Query mode's Run: one read-only statement, its parameters bound, a
//          window of its result (or, with --plan, its query plan as a tree)
//
// The CLI links no native modules, so it cannot open a database itself. Each
// verb rides a WS message (`sqlite_read_summary`, `sqlite_list_objects`, `sqlite_read_schema`,
// `sqlite_read_rows`, `sqlite_count_rows`, `sqlite_save_blob`, `sqlite_run_query`) to the running
// app, which answers with the same functions the viewer's `sqlite:*` IPC calls.
// The app must be running, and the database is opened read-only there; a
// BLOB is written to `--output` by the app, so its bytes never ride the socket.

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
import {
	SQLITE_QUERY_MAX_LIMIT,
	SQLITE_QUERY_TIMEOUT_MS,
	sqliteQueryBinding,
	sqliteQueryParameters,
} from '../../shared/sqlite/query';
import {
	SQLITE_QUERY_PLAN_KIND_HINTS,
	formatSqliteQueryPlan,
	sqliteQueryPlanSteps,
} from '../../shared/sqlite/plan';
import { formatSqliteIntegrity, sqliteSummaryFacts } from '../../shared/sqlite/summary';
import type {
	SqliteBlobSaved,
	SqliteDatabaseInfo,
	SqliteDatabaseSummary,
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
	SqliteQueryResult,
	SqliteRowCount,
	SqliteRowsPage,
	SqliteCellValue,
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
	database?: SqliteDatabaseInfo;
	result?: SqliteQueryResult;
}

/**
 * `maestro-cli sqlite query <path> <sql>` - run one read-only statement the
 * way the viewer's Query mode runs it (its own connection in a child process
 * in the app, stopped at the same timeout) and print a window of the result.
 * A statement that would write is refused, not run. With `--plan`, the
 * statement's `EXPLAIN QUERY PLAN` is shown as a tree instead (Query mode's
 * Plan toggle); `--offset` and `--limit` do not apply, since a plan is
 * shown whole.
 */
export async function sqliteQuery(
	file: string,
	sql: string,
	options: SqliteQueryOptions
): Promise<void> {
	const filePath = resolveCliPath(file);
	if (!sql.trim()) fail('Give the statement to run, e.g. "SELECT * FROM users"', options.json);
	const plan = options.plan === true;
	const offset = plan ? 0 : parseCount(options.offset, '--offset', 0, options.json);
	const limit = plan
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

	let reply: SqliteQueryReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<SqliteQueryReply>(
				{ type: 'sqlite_run_query', path: filePath, sql, offset, limit, params, plan },
				'sqlite_query_result',
				// The app stops the run at its own timeout; leave room for the reply.
				SQLITE_QUERY_TIMEOUT_MS + 30_000
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.database || !reply.result) {
		fail(reply.error || `Could not run the query on ${filePath}`, options.json);
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

	const lines: string[] = [`${result.statement} on ${database.displayPath}`];
	if (!result.returnsRows) {
		lines.push('', 'The statement ran and returns no rows.');
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
		lines.push(
			'',
			`Rows ${result.offset + 1}-${last}${result.hasMore ? `; more follow (--offset ${last})` : ''}.`
		);
	}
	lines.push(`${result.elapsedMs} ms.`);
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
