/**
 * Tests for the SQLite preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createSqliteApi } from '../../../main/preload/sqlite';

describe('SQLite Preload API', () => {
	let api: ReturnType<typeof createSqliteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createSqliteApi();
	});

	it('opens a database by path', async () => {
		mockInvoke.mockResolvedValue({ handle: 'h1' });
		await api.open('/data/app.db');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:open', '/data/app.db');
	});

	it('reads the database summary by handle', async () => {
		mockInvoke.mockResolvedValue({ pageSize: 4096 });
		await api.readSummary('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readSummary', 'h1');
	});

	it('checks integrity by handle and mode', async () => {
		mockInvoke.mockResolvedValue({ mode: 'full', ok: true, problems: [] });
		await api.checkIntegrity('h1', 'full');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:checkIntegrity', 'h1', 'full');
	});

	it('lists objects by handle', async () => {
		mockInvoke.mockResolvedValue({ objects: [], sizesAvailable: true });
		await api.listObjects('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:listObjects', 'h1');
	});

	it('asks for stats of the named objects', async () => {
		mockInvoke.mockResolvedValue([]);
		await api.readObjectStats('h1', ['users', 'orders']);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readObjectStats', 'h1', ['users', 'orders']);
	});

	it('reads one object schema, passing the kind through', async () => {
		mockInvoke.mockResolvedValue({ name: 'users', kind: 'table' });
		await api.readSchema('h1', 'users', 'table');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readSchema', 'h1', 'users', 'table');
		await api.readSchema('h1', 'users');
		expect(mockInvoke).toHaveBeenLastCalledWith('sqlite:readSchema', 'h1', 'users', undefined);
	});

	it('reads the column catalog by handle', async () => {
		mockInvoke.mockResolvedValue({ objects: [] });
		await api.readColumns('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readColumns', 'h1');
	});

	it('reads a window of rows', async () => {
		const request = { handle: 'h1', name: 'users', offset: 0, limit: 300, sort: null };
		mockInvoke.mockResolvedValue({ name: 'users', rows: [], hasMore: false });
		await api.readRows(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readRows', request);
	});

	it('counts rows, passing the request through', async () => {
		const request = {
			handle: 'h1',
			name: 'users',
			filter: null,
			cursor: { matched: 1, scanned: 1, afterRowid: '1' },
		};
		mockInvoke.mockResolvedValue({ name: 'users', matched: 2, complete: true, cursor: null });
		await api.countRows(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:countRows', request);
	});

	it('saves a BLOB', async () => {
		const request = {
			handle: 'h1',
			name: 'media',
			column: 'data',
			offset: 3,
			destPath: '/tmp/x.bin',
		};
		mockInvoke.mockResolvedValue({ path: '/tmp/x.bin', bytes: 4, rowid: null });
		await api.saveBlob(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:saveBlob', request);
	});

	it('turns editing on and off', async () => {
		mockInvoke.mockResolvedValue({ handle: 'h1', editToken: 't1' });
		await expect(api.enableEditing('h1')).resolves.toEqual({ handle: 'h1', editToken: 't1' });
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:enableEditing', 'h1');

		mockInvoke.mockResolvedValue(true);
		await expect(api.disableEditing('h1', 't1')).resolves.toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:disableEditing', 'h1', 't1');
	});

	it('changes one cell', async () => {
		const request = {
			handle: 'h1',
			editToken: 't1',
			name: 'users',
			column: 'age',
			row: { kind: 'rowid' as const, rowid: '3' },
			value: { type: 'number' as const, text: '42' },
		};
		mockInvoke.mockResolvedValue({ name: 'users', column: 'age', row: [3, 42] });
		await api.updateCell(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:updateCell', request);
	});

	it('inserts and deletes one row', async () => {
		const insert = {
			handle: 'h1',
			editToken: 't1',
			name: 'users',
			values: { age: { type: 'number' as const, text: '42' } },
		};
		mockInvoke.mockResolvedValue({ name: 'users', row: [9, 42] });
		await api.insertRow(insert);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:insertRow', insert);

		const remove = {
			handle: 'h1',
			editToken: 't1',
			name: 'users',
			row: { kind: 'rowid' as const, rowid: '9' },
		};
		mockInvoke.mockResolvedValue({ name: 'users', otherChanges: 0 });
		await api.deleteRow(remove);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:deleteRow', remove);
	});

	it('undoes one write with the step it returned', async () => {
		const undo = {
			handle: 'h1',
			editToken: 't1',
			step: {
				kind: 'restore-row' as const,
				name: 'users',
				rowid: '9',
				values: { age: { type: 'integer' as const, text: '42' } },
			},
		};
		mockInvoke.mockResolvedValue({ name: 'users', kind: 'restore-row', otherChanges: 0 });
		await api.undoEdit(undo);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:undoEdit', undo);
	});

	it("begins, reads, and ends Query mode's transaction, and runs a statement in it", async () => {
		const grant = { handle: 'h1', editToken: 't1' };
		mockInvoke.mockResolvedValue({ transactionId: 'x1' });
		await api.beginTransaction(grant);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:beginTransaction', grant);

		mockInvoke.mockResolvedValue({ transaction: null, lastEnd: null });
		await api.readTransaction(grant);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readTransaction', grant);

		const end = { ...grant, transactionId: 'x1', action: 'rollback' as const };
		mockInvoke.mockResolvedValue({ outcome: 'rolled-back' });
		await api.endTransaction(end);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:endTransaction', end);

		const run = { ...grant, sql: 'SELECT 1', transactionId: 'x1' };
		mockInvoke.mockResolvedValue({ statement: 'SELECT', rows: [] });
		await api.runQuery(run);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:runQuery', run);
	});

	it('runs a query and stops one by id', async () => {
		const request = { handle: 'h1', sql: 'SELECT 1', queryId: 'q1' };
		mockInvoke.mockResolvedValue({ statement: 'SELECT', rows: [] });
		await api.runQuery(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:runQuery', request);

		mockInvoke.mockResolvedValue(true);
		await expect(api.cancelQuery('q1')).resolves.toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:cancelQuery', 'q1');
	});

	it('exports a query, and reads and forgets its history', async () => {
		const request = { handle: 'h1', sql: 'SELECT 1', destPath: '/tmp/out.jsonl', queryId: 'e1' };
		mockInvoke.mockResolvedValue({ path: '/tmp/out.jsonl', rows: 1 });
		await api.exportQuery(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:exportQuery', request);

		mockInvoke.mockResolvedValue({ path: '/data/app.db', entries: [] });
		await api.readQueryHistory('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readQueryHistory', 'h1');
		await api.forgetQueryHistory('h1', 'id-1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:forgetQueryHistory', 'h1', 'id-1');
		await api.forgetQueryHistory('h1', null);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:forgetQueryHistory', 'h1', null);
	});

	it('reads and clears the statement log, and hears it change', async () => {
		mockInvoke.mockResolvedValue({ path: '/data/app.db', entries: [] });
		await api.readStatementLog('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readStatementLog', 'h1');
		await api.clearStatementLog('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:clearStatementLog', 'h1');

		const heard = vi.fn();
		const stop = api.onStatementLogged(heard);
		expect(mockOn).toHaveBeenCalledWith('sqlite:statementLogged', expect.any(Function));
		const handler = mockOn.mock.calls[0][1] as (event: unknown, path: string) => void;
		handler({}, '/data/app.db');
		expect(heard).toHaveBeenCalledWith('/data/app.db');
		stop();
		expect(mockRemoveListener).toHaveBeenCalledWith('sqlite:statementLogged', handler);
	});

	it('closes a handle', async () => {
		mockInvoke.mockResolvedValue(undefined);
		await api.close('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:close', 'h1');
	});
});
