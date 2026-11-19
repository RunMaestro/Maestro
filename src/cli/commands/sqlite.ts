// SQLite commands - `maestro-cli sqlite ...`, the CLI half of the SQLite viewer.
//
//   maestro-cli sqlite tables <path> [--internal] [--json]
//       -> the table-list rail: tables, views, indexes, and triggers, with row
//          counts and on-disk sizes
//   maestro-cli sqlite schema <path> <object> [--kind <kind>] [--json]
//       -> the schema pane: columns with type, affinity, nullability, default,
//          primary key and foreign-key targets, index key columns, CREATE SQL
//
// The CLI links no native modules, so it cannot open a database itself. Each
// verb rides a WS message (`sqlite_list_objects`, `sqlite_read_schema`) to the
// running app, which answers with the same functions the viewer's `sqlite:*`
// IPC calls. The app
// must be running, and the database is opened read-only there.

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
import type {
	SqliteDatabaseInfo,
	SqliteObjectKind,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
	SqliteObjectSummary,
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
