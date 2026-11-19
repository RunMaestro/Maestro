/**
 * Tests for the SQLite IPC handlers: each channel forwards to the main-process
 * function the viewer and the CLI share.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(channel, handler);
		},
	},
}));

const database = vi.hoisted(() => ({
	openSqliteDatabase: vi.fn(),
	closeSqliteDatabase: vi.fn(),
}));
const objects = vi.hoisted(() => ({
	listSqliteObjects: vi.fn(),
	readSqliteObjectStats: vi.fn(),
}));

vi.mock('../../../../main/sqlite/sqlite-database', () => database);
const schema = vi.hoisted(() => ({
	readSqliteObjectSchema: vi.fn(),
	readSqliteColumnCatalog: vi.fn(),
}));
const rows = vi.hoisted(() => ({ readSqliteRows: vi.fn() }));
const count = vi.hoisted(() => ({ countSqliteRows: vi.fn() }));
const blob = vi.hoisted(() => ({ saveSqliteBlob: vi.fn() }));
const summary = vi.hoisted(() => ({ readSqliteDatabaseSummary: vi.fn() }));
const integrity = vi.hoisted(() => ({ checkSqliteIntegrity: vi.fn() }));
const query = vi.hoisted(() => ({
	runSqliteQuery: vi.fn(),
	cancelSqliteQuery: vi.fn(),
	exportSqliteQuery: vi.fn(),
}));
const editing = vi.hoisted(() => ({
	enableSqliteEditing: vi.fn(),
	disableSqliteEditing: vi.fn(),
}));
const history = vi.hoisted(() => ({
	readSqliteQueryHistory: vi.fn(),
	forgetSqliteQueryHistory: vi.fn(),
}));
const rowEdit = vi.hoisted(() => ({
	updateSqliteCell: vi.fn(),
	insertSqliteRow: vi.fn(),
	deleteSqliteRow: vi.fn(),
	undoSqliteEdit: vi.fn(),
}));

vi.mock('../../../../main/sqlite/sqlite-objects', () => objects);
vi.mock('../../../../main/sqlite/sqlite-schema', () => schema);
vi.mock('../../../../main/sqlite/sqlite-rows', () => rows);
vi.mock('../../../../main/sqlite/sqlite-count', () => count);
vi.mock('../../../../main/sqlite/sqlite-blob', () => blob);
vi.mock('../../../../main/sqlite/sqlite-summary', () => summary);
vi.mock('../../../../main/sqlite/sqlite-integrity', () => integrity);
vi.mock('../../../../main/sqlite/sqlite-query', () => query);
vi.mock('../../../../main/sqlite/sqlite-query-history', () => history);
vi.mock('../../../../main/sqlite/sqlite-editing', () => editing);
vi.mock('../../../../main/sqlite/sqlite-row-edit', () => rowEdit);
const transaction = vi.hoisted(() => ({
	beginSqliteTransaction: vi.fn(),
	readSqliteTransaction: vi.fn(),
	endSqliteTransaction: vi.fn(),
}));
vi.mock('../../../../main/sqlite/sqlite-transaction', () => transaction);

import { registerSqliteHandlers } from '../../../../main/ipc/handlers/sqlite';
import { splitSqliteErrorOffset } from '../../../../shared/sqlite/queryError';

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

describe('SQLite IPC handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();
		registerSqliteHandlers();
	});

	it('registers the channels the viewer uses', () => {
		expect([...handlers.keys()].sort()).toEqual([
			'sqlite:beginTransaction',
			'sqlite:cancelQuery',
			'sqlite:checkIntegrity',
			'sqlite:close',
			'sqlite:countRows',
			'sqlite:deleteRow',
			'sqlite:disableEditing',
			'sqlite:enableEditing',
			'sqlite:endTransaction',
			'sqlite:exportQuery',
			'sqlite:forgetQueryHistory',
			'sqlite:insertRow',
			'sqlite:listObjects',
			'sqlite:open',
			'sqlite:readColumns',
			'sqlite:readObjectStats',
			'sqlite:readQueryHistory',
			'sqlite:readRows',
			'sqlite:readSchema',
			'sqlite:readSummary',
			'sqlite:readTransaction',
			'sqlite:runQuery',
			'sqlite:saveBlob',
			'sqlite:undoEdit',
			'sqlite:updateCell',
		]);
	});

	it('reads the database summary by handle', async () => {
		summary.readSqliteDatabaseSummary.mockReturnValue({ pageSize: 4096 });
		await expect(invoke('sqlite:readSummary', 'h1')).resolves.toEqual({ pageSize: 4096 });
		expect(summary.readSqliteDatabaseSummary).toHaveBeenCalledWith('h1');
	});

	it('checks integrity by handle and mode, treating anything but full as quick', async () => {
		integrity.checkSqliteIntegrity.mockResolvedValue({ ok: true });
		await expect(invoke('sqlite:checkIntegrity', 'h1', 'full')).resolves.toEqual({ ok: true });
		await invoke('sqlite:checkIntegrity', 'h1', 'bogus');
		expect(integrity.checkSqliteIntegrity).toHaveBeenNthCalledWith(1, 'h1', 'full');
		expect(integrity.checkSqliteIntegrity).toHaveBeenNthCalledWith(2, 'h1', 'quick');
	});

	it('opens by path', async () => {
		database.openSqliteDatabase.mockResolvedValue({ handle: 'h1' });
		await expect(invoke('sqlite:open', '/data/app.db')).resolves.toEqual({ handle: 'h1' });
		expect(database.openSqliteDatabase).toHaveBeenCalledWith('/data/app.db');
	});

	it('lists objects and reads stats by handle', async () => {
		objects.listSqliteObjects.mockReturnValue({ objects: [], sizesAvailable: true });
		objects.readSqliteObjectStats.mockReturnValue([]);
		await invoke('sqlite:listObjects', 'h1');
		await invoke('sqlite:readObjectStats', 'h1', ['users']);
		expect(objects.listSqliteObjects).toHaveBeenCalledWith('h1');
		expect(objects.readSqliteObjectStats).toHaveBeenCalledWith('h1', ['users']);
	});

	it('reads one object schema by handle, name, and kind', async () => {
		schema.readSqliteObjectSchema.mockReturnValue({ name: 'users', kind: 'table' });
		await expect(invoke('sqlite:readSchema', 'h1', 'users', 'table')).resolves.toEqual({
			name: 'users',
			kind: 'table',
		});
		expect(schema.readSqliteObjectSchema).toHaveBeenCalledWith('h1', 'users', 'table');
	});

	it('reads the column catalog for SQL completion by handle', async () => {
		const catalog = { objects: [{ name: 'users', kind: 'table', internal: false, columns: [] }] };
		schema.readSqliteColumnCatalog.mockReturnValue(catalog);
		await expect(invoke('sqlite:readColumns', 'h1')).resolves.toEqual(catalog);
		expect(schema.readSqliteColumnCatalog).toHaveBeenCalledWith('h1');
	});

	it('reads a window of rows with the request passed through whole', async () => {
		const request = {
			handle: 'h1',
			name: 'users',
			offset: 300,
			limit: 300,
			sort: { column: 'name', direction: 'desc' },
		};
		rows.readSqliteRows.mockReturnValue({ name: 'users', rows: [], hasMore: false });
		await expect(invoke('sqlite:readRows', request)).resolves.toEqual({
			name: 'users',
			rows: [],
			hasMore: false,
		});
		expect(rows.readSqliteRows).toHaveBeenCalledWith(request);
	});

	it('counts rows with the default budget, passing the cursor through', async () => {
		const request = {
			handle: 'h1',
			name: 'users',
			filter: 'status = active',
			cursor: { matched: 10, scanned: 40, afterRowid: '40' },
		};
		const result = { name: 'users', matched: 12, complete: true, cursor: null };
		count.countSqliteRows.mockReturnValue(result);
		await expect(invoke('sqlite:countRows', request)).resolves.toEqual(result);
		// No budget argument: the IPC surface cannot widen how long main is held.
		expect(count.countSqliteRows).toHaveBeenCalledWith(request);
	});

	it('saves a BLOB with the request passed through whole', async () => {
		const request = {
			handle: 'h1',
			name: 'media',
			column: 'data',
			rowid: '7',
			expected: { bytes: 16, head: '89504e47' },
			destPath: '/tmp/logo.png',
		};
		const saved = { path: '/tmp/logo.png', bytes: 16, rowid: '7' };
		blob.saveSqliteBlob.mockResolvedValue(saved);
		await expect(invoke('sqlite:saveBlob', request)).resolves.toEqual(saved);
		expect(blob.saveSqliteBlob).toHaveBeenCalledWith(request);
	});

	it('runs a query with the request passed through whole, and stops one by id', async () => {
		const request = { handle: 'h1', sql: 'SELECT 1', offset: 0, limit: 500, queryId: 'q1' };
		const result = {
			statement: 'SELECT',
			columns: [{ name: '1', declaredType: null }],
			rows: [[1]],
			offset: 0,
			hasMore: false,
			returnsRows: true,
			elapsedMs: 0,
		};
		query.runSqliteQuery.mockResolvedValue(result);
		await expect(invoke('sqlite:runQuery', request)).resolves.toEqual(result);
		expect(query.runSqliteQuery).toHaveBeenCalledWith(request);

		query.cancelSqliteQuery.mockReturnValue(true);
		await expect(invoke('sqlite:cancelQuery', 'q1')).resolves.toBe(true);
		expect(query.cancelSqliteQuery).toHaveBeenCalledWith('q1');
	});

	it("carries a syntax error's offset on its message, since IPC keeps only the message", async () => {
		query.runSqliteQuery.mockRejectedValueOnce(
			Object.assign(new Error('near "=": syntax error'), { offset: 12 })
		);
		const failure = await Promise.resolve(
			invoke('sqlite:runQuery', { handle: 'h1', sql: 'x' })
		).catch((error: unknown) => error as Error);
		expect(splitSqliteErrorOffset((failure as Error).message)).toEqual({
			message: 'near "=": syntax error',
			offset: 12,
		});

		// Any other error passes through as it is.
		const plain = Object.assign(new Error('no such table: t'), { code: 'SQLITE_ERROR' });
		query.runSqliteQuery.mockRejectedValueOnce(plain);
		await expect(invoke('sqlite:runQuery', { handle: 'h1', sql: 'x' })).rejects.toBe(plain);
	});

	it('exports a query with the request passed through whole', async () => {
		const request = {
			handle: 'h1',
			sql: 'SELECT * FROM t',
			destPath: '/tmp/out.csv',
			format: 'csv',
			queryId: 'e1',
		};
		const exported = {
			path: '/tmp/out.csv',
			format: 'csv',
			rows: 3,
			columns: 2,
			bytes: 40,
			elapsedMs: 1,
		};
		query.exportSqliteQuery.mockResolvedValue(exported);
		await expect(invoke('sqlite:exportQuery', request)).resolves.toEqual(exported);
		expect(query.exportSqliteQuery).toHaveBeenCalledWith(request);
	});

	it('reads the query history by handle, and forgets one entry or all of them', async () => {
		const left = { path: '/data/app.db', entries: [] };
		history.readSqliteQueryHistory.mockResolvedValue(left);
		await expect(invoke('sqlite:readQueryHistory', 'h1')).resolves.toEqual(left);
		expect(history.readSqliteQueryHistory).toHaveBeenCalledWith('h1');

		history.forgetSqliteQueryHistory.mockResolvedValue(left);
		await expect(invoke('sqlite:forgetQueryHistory', 'h1', 'id-1')).resolves.toEqual(left);
		expect(history.forgetSqliteQueryHistory).toHaveBeenCalledWith('h1', 'id-1');
		await invoke('sqlite:forgetQueryHistory', 'h1', undefined);
		expect(history.forgetSqliteQueryHistory).toHaveBeenLastCalledWith('h1', null);
	});

	it("turns a tab's editing on by handle and off by its token", async () => {
		editing.enableSqliteEditing.mockResolvedValue({ handle: 'h1', editToken: 't1' });
		await expect(invoke('sqlite:enableEditing', 'h1')).resolves.toEqual({
			handle: 'h1',
			editToken: 't1',
		});
		expect(editing.enableSqliteEditing).toHaveBeenCalledWith('h1');

		editing.disableSqliteEditing.mockReturnValue(true);
		await expect(invoke('sqlite:disableEditing', 'h1', 't1')).resolves.toBe(true);
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 't1');
	});

	it('forwards a cell edit, token and all, to the one UPDATE path', async () => {
		const request = {
			handle: 'h1',
			editToken: 't1',
			name: 'users',
			column: 'email',
			row: { kind: 'rowid', rowid: '7' },
			value: { type: 'text', text: 'a@b.c' },
		};
		const result = {
			name: 'users',
			column: 'email',
			columns: [],
			row: [7, 'a@b.c'],
			key: { kind: 'rowid', rowid: '7' },
			elapsedMs: 1,
		};
		rowEdit.updateSqliteCell.mockResolvedValue(result);
		await expect(invoke('sqlite:updateCell', request)).resolves.toEqual(result);
		expect(rowEdit.updateSqliteCell).toHaveBeenCalledWith(request);

		rowEdit.updateSqliteCell.mockRejectedValue(new Error('UNIQUE constraint failed: users.email'));
		await expect(invoke('sqlite:updateCell', request)).rejects.toThrow(
			'UNIQUE constraint failed: users.email'
		);
	});

	it('forwards an insert, token and all, to the one INSERT path', async () => {
		const request = {
			handle: 'h1',
			editToken: 't1',
			name: 'users',
			values: { email: { type: 'text', text: 'a@b.c' } },
		};
		const result = {
			name: 'users',
			columns: [],
			row: [8, 'a@b.c'],
			key: { kind: 'rowid', rowid: '8' },
			otherChanges: 0,
			elapsedMs: 1,
		};
		rowEdit.insertSqliteRow.mockResolvedValue(result);
		await expect(invoke('sqlite:insertRow', request)).resolves.toEqual(result);
		expect(rowEdit.insertSqliteRow).toHaveBeenCalledWith(request);

		rowEdit.insertSqliteRow.mockRejectedValue(new Error('NOT NULL constraint failed: users.name'));
		await expect(invoke('sqlite:insertRow', request)).rejects.toThrow(
			'NOT NULL constraint failed: users.name'
		);
	});

	it('forwards a delete, token and all, to the one DELETE path', async () => {
		const request = {
			handle: 'h1',
			editToken: 't1',
			name: 'users',
			row: { kind: 'rowid', rowid: '7' },
		};
		const result = { name: 'users', key: request.row, otherChanges: 2, elapsedMs: 1 };
		rowEdit.deleteSqliteRow.mockResolvedValue(result);
		await expect(invoke('sqlite:deleteRow', request)).resolves.toEqual(result);
		expect(rowEdit.deleteSqliteRow).toHaveBeenCalledWith(request);

		rowEdit.deleteSqliteRow.mockRejectedValue(new Error('FOREIGN KEY constraint failed'));
		await expect(invoke('sqlite:deleteRow', request)).rejects.toThrow(
			'FOREIGN KEY constraint failed'
		);
	});

	it('forwards an undo, token and step, to the one undo path', async () => {
		const request = {
			handle: 'h1',
			editToken: 't1',
			step: {
				kind: 'remove-row',
				name: 'users',
				row: { kind: 'rowid', rowid: '9' },
				version: 'AfterAfterAfterAfter_1',
			},
		};
		const result = {
			name: 'users',
			kind: 'remove-row',
			key: request.step.row,
			otherChanges: 0,
			elapsedMs: 1,
		};
		rowEdit.undoSqliteEdit.mockResolvedValue(result);
		await expect(invoke('sqlite:undoEdit', request)).resolves.toEqual(result);
		expect(rowEdit.undoSqliteEdit).toHaveBeenCalledWith(request);

		rowEdit.undoSqliteEdit.mockRejectedValue(new Error('UNIQUE constraint failed: users.id'));
		await expect(invoke('sqlite:undoEdit', request)).rejects.toThrow(
			'UNIQUE constraint failed: users.id'
		);
	});

	it("forwards Query mode's transaction calls: begin, read, and end", async () => {
		const grant = { handle: 'h1', editToken: 't1' };
		const state = {
			transactionId: 'x1',
			startedAt: 1,
			expiresAt: 2,
			statements: 0,
			changes: 0,
			otherChanges: 0,
			schemaChanges: [],
		};
		transaction.beginSqliteTransaction.mockResolvedValue(state);
		await expect(invoke('sqlite:beginTransaction', grant)).resolves.toEqual(state);
		expect(transaction.beginSqliteTransaction).toHaveBeenCalledWith(grant);

		transaction.readSqliteTransaction.mockReturnValue({ transaction: state, lastEnd: null });
		await expect(invoke('sqlite:readTransaction', grant)).resolves.toEqual({
			transaction: state,
			lastEnd: null,
		});
		expect(transaction.readSqliteTransaction).toHaveBeenCalledWith(grant);

		const end = {
			transactionId: 'x1',
			outcome: 'committed',
			reason: 'Committed 0 statements: 0 rows changed. These changes are now in the file.',
			transaction: state,
			endedAt: 3,
		};
		const request = { ...grant, transactionId: 'x1', action: 'commit' };
		transaction.endSqliteTransaction.mockResolvedValue(end);
		await expect(invoke('sqlite:endTransaction', request)).resolves.toEqual(end);
		expect(transaction.endSqliteTransaction).toHaveBeenCalledWith(request);

		transaction.endSqliteTransaction.mockRejectedValue(new Error('FOREIGN KEY constraint failed'));
		await expect(invoke('sqlite:endTransaction', request)).rejects.toThrow(
			'FOREIGN KEY constraint failed'
		);
	});

	it('closes by handle', async () => {
		await invoke('sqlite:close', 'h1');
		expect(database.closeSqliteDatabase).toHaveBeenCalledWith('h1');
	});
});
