/**
 * SQLite WebSocket handlers, the CLI half of the SQLite viewer:
 *
 *   - `sqlite_list_objects`: the table-list rail (`maestro-cli sqlite tables`).
 *   - `sqlite_read_schema`: one object's schema pane (`maestro-cli sqlite schema`).
 *
 * The CLI cannot link better-sqlite3 (it is a plain-Node bundle with no native
 * modules), so it asks the running app. The answer comes from the SAME
 * functions the `sqlite:*` IPC handlers call: `openSqliteDatabase()` for the
 * read-only connection, `listSqliteObjects()` for the rail, the budgeted
 * stats reader for the row counts and sizes, and `readSqliteObjectSchema()`
 * for the schema pane, so the CLI prints what the viewer shows.
 *
 * The connection is NOT closed afterwards. It may be the one a preview tab is
 * already using (opens on the same file share a connection), and closing it
 * would strand that tab; the idle reaper releases it once nothing uses it.
 */

import { openSqliteDatabase } from '../../../sqlite/sqlite-database';
import { listSqliteObjects, readAllSqliteObjectStats } from '../../../sqlite/sqlite-objects';
import { readSqliteObjectSchema } from '../../../sqlite/sqlite-schema';
import type { SqliteObjectKind } from '../../../../shared/sqlite/types';
import { SQLITE_OBJECT_KINDS } from '../../../../shared/sqlite/objects';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export async function handleSqliteListObjects(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_objects_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	if (!filePath) {
		reply({ success: false, error: 'Missing required "path" for sqlite_list_objects' });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const list = listSqliteObjects(database.handle);
		const stats = await readAllSqliteObjectStats(
			database.handle,
			list.objects.map((object) => object.name)
		);
		reply({ success: true, database, list, stats });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteReadSchema(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_schema_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const name = typeof message.name === 'string' ? message.name : '';
	if (!filePath || !name) {
		reply({ success: false, error: 'Missing required "path" or "name" for sqlite_read_schema' });
		return;
	}
	const kind: SqliteObjectKind | undefined = SQLITE_OBJECT_KINDS.find(
		(entry) => entry === message.kind
	);
	if (message.kind !== undefined && !kind) {
		reply({ success: false, error: `Unknown object kind: ${String(message.kind)}` });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const schema = readSqliteObjectSchema(database.handle, name, kind);
		reply({ success: true, database, schema });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}
