// SQLite commands - `maestro-cli sqlite ...`, the CLI half of the SQLite viewer.
//
//   maestro-cli sqlite tables <path> [--internal] [--json]
//       -> the table-list rail: tables, views, indexes, and triggers, with row
//          counts and on-disk sizes
//
// The CLI links no native modules, so it cannot open a database itself. The
// verb rides the `sqlite_list_objects` WS message to the running app, which
// answers with the same functions the viewer's `sqlite:*` IPC calls. The app
// must be running, and the database is opened read-only there.

import { withMaestroClient } from '../services/maestro-client';
import { failFromError } from '../services/session-command';
import { ExitCode, exitWith } from '../exit-codes';
import { formatTextTable } from '../output/formatter';
import { resolveCliPath } from '../utils/parse';
import { formatSize } from '../../shared/formatters';
import {
	SQLITE_OBJECT_KIND_LABELS,
	formatSqliteRowCount,
	groupSqliteObjects,
	sqliteObjectTags,
} from '../../shared/sqlite/objects';
import type {
	SqliteDatabaseInfo,
	SqliteObjectList,
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
