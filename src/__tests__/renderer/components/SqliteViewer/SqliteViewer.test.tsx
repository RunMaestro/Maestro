import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

import {
	SqliteViewer,
	type SqliteViewerHandle,
} from '../../../../renderer/components/SqliteViewer';
import { AUTO_COUNT_PASSES } from '../../../../renderer/components/SqliteViewer/SqliteTableView';
import { sqliteMeasurementOrder } from '../../../../shared/sqlite/objects';
import { SQLITE_AUTO_INTEGRITY_MAX_BYTES } from '../../../../shared/sqlite/summary';
import type {
	SqliteBlobRequest,
	SqliteCellUpdateRequest,
	SqliteColumnCatalog,
	SqliteCountRequest,
	SqliteDatabaseInfo,
	SqliteDatabaseSummary,
	SqliteEditability,
	SqliteIntegrityResult,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
	SqliteObjectSummary,
	SqliteQueryExportRequest,
	SqliteQueryHistory,
	SqliteQueryHistoryEntry,
	SqliteQueryRequest,
	SqliteQueryResult,
	SqliteRowCount,
	SqliteRowsPage,
	SqliteRowsRequest,
} from '../../../../shared/sqlite/types';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

// CodeMirror cannot lay itself out in jsdom; the SQL editor renders the
// shared textarea double instead.
vi.mock('../../../../renderer/components/FilePreview/markdownEditor', async () => {
	const { markdownEditorModuleMock } = await import('../../../helpers/mockMarkdownEditor');
	return markdownEditorModuleMock();
});

const notifyToastMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/stores/notificationStore')>()),
	notifyToast: notifyToastMock,
}));

// jsdom has no layout, so the grid's virtualizer is stubbed to draw every
// loaded row. The grid's own "is it on screen" guard (clientHeight 0) still
// keeps it from paging on its own.
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
		const items = Array.from({ length: opts.count }, (_, index) => ({
			index,
			key: index,
			start: index * opts.estimateSize(),
			size: opts.estimateSize(),
		}));
		return {
			getTotalSize: () => opts.count * opts.estimateSize(),
			getVirtualItems: () => items,
		};
	},
}));

function object(overrides: Partial<SqliteObjectSummary>): SqliteObjectSummary {
	return {
		name: 'users',
		kind: 'table',
		tableName: 'users',
		tableType: 'table',
		internal: false,
		countable: true,
		hasStorage: true,
		...overrides,
	};
}

const INFO: SqliteDatabaseInfo = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 65536 };

const LIST: SqliteObjectList = {
	objects: [
		object({ name: 'users' }),
		object({ name: 'events', withoutRowid: true }),
		object({ name: 'users_email', kind: 'index', countable: false, tableType: undefined }),
		object({
			name: 'active_users',
			kind: 'view',
			countable: false,
			hasStorage: false,
			tableType: undefined,
		}),
		object({
			name: 'users_audit',
			kind: 'trigger',
			tableName: 'users',
			countable: false,
			hasStorage: false,
			tableType: undefined,
		}),
		object({ name: 'sqlite_sequence', internal: true }),
	],
	sizesAvailable: true,
};

const STATS: Record<string, SqliteObjectStats> = {
	users: { name: 'users', rowCount: 1204, rowCountCapped: false, sizeBytes: 8192 },
	events: { name: 'events', rowCount: 100000, rowCountCapped: true, sizeBytes: 1048576 },
	users_email: { name: 'users_email', rowCount: null, rowCountCapped: false, sizeBytes: 4096 },
	sqlite_sequence: { name: 'sqlite_sequence', rowCount: 1, rowCountCapped: false, sizeBytes: 4096 },
};

let open: ReturnType<typeof vi.fn>;
let listObjects: ReturnType<typeof vi.fn>;
let readObjectStats: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
let readSchema: ReturnType<typeof vi.fn>;
let readColumns: ReturnType<typeof vi.fn>;
let readRows: ReturnType<typeof vi.fn>;
let countRows: ReturnType<typeof vi.fn>;
let saveBlob: ReturnType<typeof vi.fn>;
let saveFile: ReturnType<typeof vi.fn>;
let readSummary: ReturnType<typeof vi.fn>;
let checkIntegrity: ReturnType<typeof vi.fn>;
let runQuery: ReturnType<typeof vi.fn>;
let cancelQuery: ReturnType<typeof vi.fn>;
let exportQuery: ReturnType<typeof vi.fn>;
let readQueryHistory: ReturnType<typeof vi.fn>;
let forgetQueryHistory: ReturnType<typeof vi.fn>;
let enableEditing: ReturnType<typeof vi.fn>;
let disableEditing: ReturnType<typeof vi.fn>;
let updateCell: ReturnType<typeof vi.fn>;

const SUMMARY: SqliteDatabaseSummary = {
	pageSize: 4096,
	pageCount: 16,
	freelistCount: 0,
	encoding: 'UTF-8',
	journalMode: 'wal',
	userVersion: 3,
	applicationId: 0,
	sqliteVersion: '3.53.2',
};

function integrityResult(overrides: Partial<SqliteIntegrityResult> = {}): SqliteIntegrityResult {
	return { mode: 'quick', ok: true, problems: [], truncated: false, elapsedMs: 5, ...overrides };
}

/** A count reply: settled at `matched` unless `complete` says otherwise. */
function countReply(request: SqliteCountRequest, matched: number, complete = true): SqliteRowCount {
	return {
		name: request.name,
		matched,
		complete,
		cursor: complete ? null : { matched, scanned: matched, afterRowid: String(matched) },
		filtered: Boolean(request.filter),
		elapsedMs: 1,
	};
}

/** A page of `count` rows of events, starting at `offset`. */
/** events is WITHOUT ROWID, keyed by id, with a generated payload column. */
const EVENTS_EDITABILITY: SqliteEditability = {
	editable: true,
	identity: { kind: 'primary-key', columns: ['id'], keyMayBeNull: false },
	readOnlyColumns: [
		{
			name: 'payload',
			reason: 'payload is a generated column: SQLite calculates its value from other columns.',
		},
	],
};

function eventsPage(request: SqliteRowsRequest, total = 2): SqliteRowsPage {
	const count = Math.max(0, Math.min(request.limit, total - request.offset));
	return {
		name: request.name,
		columns: [
			{ name: 'id', declaredType: 'INTEGER' },
			{ name: 'kind', declaredType: 'TEXT' },
			{ name: 'payload', declaredType: null },
		],
		rows: Array.from({ length: count }, (_, index) => [
			request.offset + index + 1,
			index === 0 ? '' : 'click',
			index === 0 ? null : { kind: 'blob', head: 'ff', bytes: 2048 },
		]),
		// events is a WITHOUT ROWID table: no rowid to name a row by, so each
		// row's primary key comes whole beside it.
		rowids: null,
		rowKeys: Array.from({ length: count }, (_, index) => [
			{ type: 'integer' as const, text: String(request.offset + index + 1) },
		]),
		offset: request.offset,
		hasMore: request.offset + count < total,
		orderedBy: request.sort ? [request.sort.column, 'id'] : ['id'],
		elapsedMs: 3,
		filtered: Boolean(request.filter),
		editability: EVENTS_EDITABILITY,
	};
}

const EVENTS_SCHEMA: SqliteObjectSchema = {
	name: 'events',
	kind: 'table',
	tableName: 'events',
	sql: "CREATE TABLE events (id INTEGER, user_id INTEGER REFERENCES users, kind TEXT NOT NULL DEFAULT 'click', PRIMARY KEY (id)) WITHOUT ROWID",
	columns: [
		{
			name: 'id',
			declaredType: 'INTEGER',
			affinity: 'INTEGER',
			notNull: true,
			defaultValue: null,
			primaryKeyPosition: 1,
			references: [],
		},
		{
			name: 'user_id',
			declaredType: 'INTEGER',
			affinity: 'INTEGER',
			notNull: false,
			defaultValue: null,
			primaryKeyPosition: 0,
			references: [{ table: 'users', column: null }],
		},
		{
			name: 'kind',
			declaredType: 'TEXT',
			affinity: 'TEXT',
			notNull: true,
			defaultValue: "'click'",
			primaryKeyPosition: 0,
			references: [],
		},
		{
			name: 'payload',
			declaredType: '',
			affinity: 'BLOB',
			notNull: false,
			defaultValue: null,
			primaryKeyPosition: 0,
			generated: 'stored',
			references: [],
		},
	],
	foreignKeys: [
		{ table: 'users', from: ['user_id'], to: [null], onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
	],
	editability: EVENTS_EDITABILITY,
};

const INDEX_SCHEMA: SqliteObjectSchema = {
	name: 'users_email',
	kind: 'index',
	tableName: 'users',
	sql: null,
	columns: [],
	foreignKeys: [],
	index: {
		columns: [
			{ name: 'email', descending: false, collation: 'BINARY' },
			{ name: null, descending: true, collation: 'NOCASE' },
		],
		unique: true,
		partial: true,
		origin: 'unique',
	},
};

/** A statement over 3 rows: `id` and `email`, one email NULL. */
function queryWindow(request: SqliteQueryRequest): SqliteQueryResult {
	const all = [
		[1, 'ada@example.com'],
		[2, null],
		[3, ''],
	];
	const offset = request.offset ?? 0;
	const limit = request.limit ?? 500;
	return {
		statement: 'SELECT',
		columns: [
			{ name: 'id', declaredType: 'INTEGER' },
			{ name: 'id', declaredType: null },
		],
		rows: all.slice(offset, offset + limit),
		offset,
		hasMore: offset + limit < all.length,
		returnsRows: true,
		elapsedMs: 3,
	};
}

const CATALOG: SqliteColumnCatalog = {
	objects: [
		{
			name: 'users',
			kind: 'table',
			internal: false,
			columns: [
				{ name: 'id', declaredType: 'INTEGER' },
				{ name: 'email', declaredType: 'TEXT' },
			],
		},
	],
};

beforeEach(() => {
	installLocalStorageMock();
	open = vi.fn().mockResolvedValue(INFO);
	listObjects = vi.fn().mockResolvedValue(LIST);
	// Answer one name per call, the way a tight main-process budget would.
	readObjectStats = vi.fn(async (_handle: string, names: string[]) => [STATS[names[0]]]);
	close = vi.fn().mockResolvedValue(undefined);
	readSchema = vi.fn(async (_handle: string, name: string) =>
		name === 'users_email' ? INDEX_SCHEMA : { ...EVENTS_SCHEMA, name }
	);
	readColumns = vi.fn().mockResolvedValue(CATALOG);
	readRows = vi.fn(async (request: SqliteRowsRequest) => eventsPage(request));
	// The count never answers unless a test says so: a settled count would
	// replace the rail's capped counts that other tests assert on.
	countRows = vi.fn(() => new Promise<SqliteRowCount>(() => {}));
	saveBlob = vi.fn(async (request: SqliteBlobRequest) => ({
		path: request.destPath,
		bytes: 2048,
		rowid: request.rowid ?? null,
	}));
	saveFile = vi.fn().mockResolvedValue('/tmp/payload.bin');
	readSummary = vi.fn().mockResolvedValue(SUMMARY);
	// The check never answers unless a test says so, like the row count.
	checkIntegrity = vi.fn(() => new Promise<SqliteIntegrityResult>(() => {}));
	runQuery = vi.fn(async (request: SqliteQueryRequest) => queryWindow(request));
	cancelQuery = vi.fn().mockResolvedValue(true);
	exportQuery = vi.fn(async (request: SqliteQueryExportRequest) => ({
		path: request.destPath,
		format: request.format ?? 'csv',
		rows: 3,
		columns: 2,
		bytes: 40,
		elapsedMs: 2,
	}));
	readQueryHistory = vi.fn(
		async (): Promise<SqliteQueryHistory> => ({ path: '/data/app.db', entries: [] })
	);
	forgetQueryHistory = vi.fn(
		async (): Promise<SqliteQueryHistory> => ({ path: '/data/app.db', entries: [] })
	);
	enableEditing = vi.fn(async (handle: string) => ({ handle, editToken: 'token-1' }));
	disableEditing = vi.fn().mockResolvedValue(true);
	// Echo the edit back as stored: the edited cell takes the new value.
	updateCell = vi.fn(async (request: SqliteCellUpdateRequest) => {
		const page = eventsPage({ handle: 'h1', name: 'events', offset: 0, limit: 10 });
		const key = request.row.kind === 'primary-key' ? request.row.values.id : null;
		// A key the page does not hold (a row re-keyed by an earlier edit) maps to its last row.
		const position = Math.min(Number(key?.text ?? 1), page.rows.length) - 1;
		const index = page.columns.findIndex((column) => column.name === request.column);
		const row = [...page.rows[position]];
		row[index] =
			request.value.type === 'null'
				? null
				: request.value.type === 'number'
					? Number(request.value.text)
					: request.value.text;
		const newKey = request.column === 'id' ? { type: 'integer', text: request.value.text } : key;
		return {
			name: 'events',
			column: request.column,
			columns: page.columns,
			row,
			key: { kind: 'primary-key', values: { id: newKey } },
			elapsedMs: 4,
		};
	});
	notifyToastMock.mockReset();
	(window as unknown as { maestro: unknown }).maestro = {
		sqlite: {
			open,
			readSummary,
			checkIntegrity,
			listObjects,
			readObjectStats,
			readSchema,
			readColumns,
			readRows,
			countRows,
			saveBlob,
			runQuery,
			cancelQuery,
			exportQuery,
			readQueryHistory,
			forgetQueryHistory,
			enableEditing,
			disableEditing,
			updateCell,
			close,
		},
		dialog: { saveFile },
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

function renderViewer() {
	return render(<SqliteViewer filePath="/data/app.db" fileName="app.db" theme={mockTheme} />);
}

describe('sqliteMeasurementOrder', () => {
	it('measures visible tables and indexes first, internal ones last, and skips views and triggers', () => {
		expect(sqliteMeasurementOrder(LIST.objects)).toEqual([
			'events',
			'users',
			'users_email',
			'sqlite_sequence',
		]);
	});
});

describe('SqliteViewer', () => {
	it('shows a loading state until the schema arrives', () => {
		open.mockReturnValue(new Promise(() => {}));
		renderViewer();
		expect(screen.getByTestId('sqlite-loading')).toBeInTheDocument();
	});

	it('shows the open failure verbatim', async () => {
		open.mockRejectedValue(new Error('/data/app.db is not a readable SQLite database.'));
		renderViewer();
		expect(await screen.findByTestId('sqlite-open-error')).toHaveTextContent(
			'/data/app.db is not a readable SQLite database.'
		);
	});

	it('lists every kind in rail order with names before any count arrives', async () => {
		readObjectStats.mockReturnValue(new Promise(() => {}));
		renderViewer();
		await screen.findByTestId('sqlite-object-rail');
		for (const kind of ['table', 'view', 'index', 'trigger']) {
			expect(screen.getByTestId(`sqlite-rail-section-${kind}`)).toBeInTheDocument();
		}
		expect(screen.getByTestId('sqlite-rail-object-users')).toBeInTheDocument();
		expect(screen.getByTestId('sqlite-rail-object-users_audit')).toHaveTextContent('on users');
		// Pending, not zero.
		expect(screen.queryByTestId('sqlite-rail-rows-users')).not.toBeInTheDocument();
	});

	it('fills in row counts and sizes batch by batch until every object is measured', async () => {
		renderViewer();
		expect(await screen.findByTestId('sqlite-rail-rows-users')).toHaveTextContent('1,204');
		expect(screen.getByTestId('sqlite-rail-rows-events')).toHaveTextContent('100,000+');
		expect(screen.getByTestId('sqlite-rail-size-users_email')).toHaveTextContent('4.0 KB');
		// Four measurable objects, one per call, then it stops asking.
		await waitFor(() => expect(readObjectStats).toHaveBeenCalledTimes(4));
		expect(readObjectStats.mock.calls[0][1]).toEqual([
			'events',
			'users',
			'users_email',
			'sqlite_sequence',
		]);
		expect(readObjectStats.mock.calls[3][1]).toEqual(['sqlite_sequence']);
	});

	it('hides internal objects until asked, and remembers the choice', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-object-rail');
		expect(screen.queryByTestId('sqlite-rail-object-sqlite_sequence')).not.toBeInTheDocument();
		fireEvent.click(screen.getByTestId('sqlite-rail-toggle-internal'));
		expect(screen.getByTestId('sqlite-rail-object-sqlite_sequence')).toBeInTheDocument();
		expect(localStorage.getItem('sqlite-show-internal')).not.toBeNull();
	});

	it('selects the first table on open and follows clicks and arrow keys', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-object-rail');
		expect(screen.getByTestId('sqlite-rail-object-events')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(screen.getByTestId('sqlite-object-pane')).toHaveTextContent('events');

		fireEvent.click(screen.getByTestId('sqlite-rail-object-users_email'));
		expect(screen.getByTestId('sqlite-object-pane')).toHaveTextContent('on users');

		fireEvent.keyDown(screen.getByTestId('sqlite-rail-object-users_email'), { key: 'ArrowUp' });
		expect(screen.getByTestId('sqlite-rail-object-users')).toHaveAttribute('aria-selected', 'true');
		fireEvent.keyDown(screen.getByTestId('sqlite-rail-object-users'), { key: 'End' });
		expect(screen.getByTestId('sqlite-rail-object-users_audit')).toHaveAttribute(
			'aria-selected',
			'true'
		);
	});

	it('shows a per-object failure on its row and keeps measuring the rest', async () => {
		readObjectStats.mockImplementation(async (_handle: string, names: string[]) => [
			names[0] === 'events'
				? {
						name: 'events',
						rowCount: null,
						rowCountCapped: false,
						sizeBytes: null,
						error: 'no such module: fts5',
					}
				: STATS[names[0]],
		]);
		renderViewer();
		expect(await screen.findByTestId('sqlite-rail-error-events')).toHaveAttribute(
			'title',
			'no such module: fts5'
		);
		expect(await screen.findByTestId('sqlite-rail-rows-users')).toHaveTextContent('1,204');
	});

	it('reports a measuring failure in the summary bar', async () => {
		readObjectStats.mockRejectedValue(new Error('SQLite database handle is no longer open.'));
		renderViewer();
		expect(await screen.findByTestId('sqlite-stats-error')).toHaveTextContent('no longer open');
	});

	it('shows why sizes are missing', async () => {
		listObjects.mockResolvedValue({
			...LIST,
			sizesAvailable: false,
			sizeNote: 'Sizes are unavailable: this SQLite build has no dbstat table.',
		});
		renderViewer();
		expect(await screen.findByText(/no dbstat table/)).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-rail-size-users')).not.toBeInTheDocument();
	});

	it('closes the handle when the tab goes away', async () => {
		const { unmount } = renderViewer();
		await screen.findByTestId('sqlite-object-rail');
		unmount();
		expect(close).toHaveBeenCalledWith('h1');
	});
});

describe('SqliteViewer schema pane', () => {
	beforeEach(() => {
		// The pane opens on the rows by default; these tests are about the schema.
		localStorage.setItem('sqlite-object-view', 'schema');
	});

	it('reads the selected object schema by handle, name, and kind', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-schema');
		expect(readSchema).toHaveBeenCalledWith('h1', 'events', 'table');
	});

	it('lists columns with declared type, affinity, nullability, default, PK, and references', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-schema');
		const rows = screen.getAllByTestId('sqlite-schema-column');
		expect(rows).toHaveLength(4);
		expect(rows[0]).toHaveTextContent('id');
		expect(rows[0]).toHaveTextContent('NOT NULL');
		expect(screen.getByLabelText('Primary key, position 1')).toBeInTheDocument();
		expect(rows[1]).toHaveTextContent('users (primary key)');
		expect(rows[1]).toHaveTextContent('nullable');
		expect(rows[2]).toHaveTextContent("'click'");
		// No declared type reads "none", not an empty cell; affinity still shows.
		expect(rows[3]).toHaveTextContent('none');
		expect(rows[3]).toHaveTextContent('BLOB');
		expect(rows[3]).toHaveTextContent('generated stored');
		expect(screen.getByTestId('sqlite-schema-foreign-key')).toHaveTextContent(
			'(user_id) -> users (primary key) ON DELETE CASCADE'
		);
	});

	it('says how an edit names a row, and which columns it cannot write', async () => {
		renderViewer();
		const editing = await screen.findByTestId('sqlite-schema-editability');
		expect(editing).toHaveTextContent('rows keyed by primary key');
		expect(editing).toHaveTextContent(
			'Editable. An edit names its row by the primary key (id). Generated columns cannot be edited: payload.'
		);
	});

	it('says why a view is read-only, and nothing for an index', async () => {
		readSchema.mockImplementation(async (_handle: string, name: string) =>
			name === 'users_email'
				? INDEX_SCHEMA
				: {
						...EVENTS_SCHEMA,
						name,
						editability: {
							editable: false,
							code: 'view',
							reason: `${name} is a view: it has no rows of its own.`,
						},
					}
		);
		renderViewer();
		const editing = await screen.findByTestId('sqlite-schema-editability');
		expect(editing).toHaveTextContent('read-only: view');
		expect(editing).toHaveTextContent('Read-only. events is a view: it has no rows of its own.');
		fireEvent.click(screen.getByTestId('sqlite-rail-object-users_email'));
		await waitFor(() =>
			expect(screen.getAllByTestId('sqlite-schema-index-column')).toHaveLength(2)
		);
		expect(screen.queryByTestId('sqlite-schema-editability')).not.toBeInTheDocument();
	});

	it('shows the original CREATE statement', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-schema');
		expect(screen.getByTestId('sqlite-schema')).toHaveTextContent('WITHOUT ROWID');
	});

	it('shows an index as key columns and explains a missing CREATE statement', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-object-rail');
		fireEvent.click(screen.getByTestId('sqlite-rail-object-users_email'));
		await waitFor(() =>
			expect(screen.getAllByTestId('sqlite-schema-index-column')).toHaveLength(2)
		);
		const keys = screen.getAllByTestId('sqlite-schema-index-column');
		expect(keys[0]).toHaveTextContent('email');
		expect(keys[1]).toHaveTextContent('<expression>');
		expect(keys[1]).toHaveTextContent('DESC');
		expect(screen.getByTestId('sqlite-schema')).toHaveTextContent('from UNIQUE constraint');
		expect(screen.getByTestId('sqlite-schema')).toHaveTextContent('no CREATE statement of its own');
		expect(screen.queryByTestId('sqlite-schema-column')).not.toBeInTheDocument();
	});

	it('keeps the SQL when the columns could not be read', async () => {
		readSchema.mockResolvedValue({
			...EVENTS_SCHEMA,
			columns: [],
			foreignKeys: [],
			error: 'no such module: fts5',
		});
		renderViewer();
		expect(await screen.findByTestId('sqlite-schema')).toHaveTextContent(
			'Columns could not be read: no such module: fts5'
		);
		expect(screen.getByTestId('sqlite-schema')).toHaveTextContent('CREATE TABLE events');
	});

	it('reports a schema read failure in the pane', async () => {
		readSchema.mockRejectedValue(new Error('SQLite database handle is no longer open.'));
		renderViewer();
		expect(await screen.findByTestId('sqlite-schema-error')).toHaveTextContent(
			'Could not read the schema of events: SQLite database handle is no longer open.'
		);
	});

	it('drops a stale reply from an earlier selection', async () => {
		let resolveFirst: (schema: SqliteObjectSchema) => void = () => {};
		readSchema.mockImplementationOnce(
			() => new Promise<SqliteObjectSchema>((resolve) => (resolveFirst = resolve))
		);
		renderViewer();
		await screen.findByTestId('sqlite-schema-loading');
		fireEvent.click(screen.getByTestId('sqlite-rail-object-users_email'));
		await waitFor(() =>
			expect(screen.getAllByTestId('sqlite-schema-index-column')).toHaveLength(2)
		);
		resolveFirst(EVENTS_SCHEMA);
		await Promise.resolve();
		expect(screen.queryByTestId('sqlite-schema-column')).not.toBeInTheDocument();
	});
});

describe('SqliteViewer table view', () => {
	it('opens a table on its rows, read by handle and name from offset 0, unsorted', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-table-view');
		expect(readRows).toHaveBeenCalledWith({
			handle: 'h1',
			name: 'events',
			offset: 0,
			limit: 300,
			sort: null,
			filter: null,
		});
		expect(readSchema).not.toHaveBeenCalled();
	});

	it('draws NULL as a placeholder apart from an empty string, and a BLOB by size', async () => {
		renderViewer();
		const first = await screen.findByTestId('sqlite-row-0');
		expect(first).toHaveTextContent('NULL');
		// The tooltip names which one a cell is: a blank could be whitespace.
		expect(within(first).getByTitle('NULL (no value)')).toHaveStyle({ fontStyle: 'italic' });
		expect(within(first).getByTitle('Empty string')).toHaveTextContent(/^$/);
		const second = screen.getByTestId('sqlite-row-1');
		expect(second).toHaveTextContent('click');
		expect(second).toHaveTextContent('BLOB 2.0 KB · ff …');
		// The tooltip gives the exact size and says how to save it.
		const blob = within(second).getByTitle(/^BLOB, 2\.0 KB \(2,048 bytes\)\nff …\n/);
		expect(blob.getAttribute('title')).toContain('Double-click the row to save it to a file');
	});

	it('shows column types from the statement and the order in the footer', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-table-view');
		expect(screen.getByTestId('sqlite-header-id')).toHaveTextContent('INTEGER');
		expect(screen.getByTestId('sqlite-header-payload')).toHaveAttribute(
			'title',
			'payload (an expression) - click to sort'
		);
		const footer = screen.getByTestId('sqlite-rows-footer');
		expect(footer).toHaveTextContent('2 loaded');
		expect(footer).toHaveTextContent('ordered by id');
		expect(footer).toHaveTextContent('3 ms');
	});

	it('sorts in SQLite on a header click: ascending, descending, then off', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-header-kind');
		fireEvent.click(screen.getByTestId('sqlite-header-kind'));
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(
				expect.objectContaining({ offset: 0, sort: { column: 'kind', direction: 'asc' } })
			)
		);
		fireEvent.click(screen.getByTestId('sqlite-header-kind'));
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(
				expect.objectContaining({ offset: 0, sort: { column: 'kind', direction: 'desc' } })
			)
		);
		fireEvent.click(screen.getByTestId('sqlite-header-kind'));
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(expect.objectContaining({ sort: null }))
		);
		expect(await screen.findByTestId('sqlite-rows-footer')).toHaveTextContent('ordered by id');
	});

	it('drops a window that arrives for an older sort', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-header-kind');
		// The ascending window hangs; the descending one answers with 3 rows.
		let resolveStale: (page: SqliteRowsPage) => void = () => {};
		readRows.mockImplementationOnce(
			() => new Promise<SqliteRowsPage>((resolve) => (resolveStale = resolve))
		);
		readRows.mockImplementationOnce(async (request: SqliteRowsRequest) => eventsPage(request, 3));
		fireEvent.click(screen.getByTestId('sqlite-header-kind'));
		fireEvent.click(screen.getByTestId('sqlite-header-kind'));
		await waitFor(() =>
			expect(screen.getByTestId('sqlite-rows-footer')).toHaveTextContent('3 loaded')
		);
		resolveStale(eventsPage({ handle: 'h1', name: 'events', offset: 0, limit: 300 }, 7));
		await Promise.resolve();
		expect(screen.getByTestId('sqlite-rows-footer')).toHaveTextContent('3 loaded');
	});

	it('shows a read failure verbatim in the pane', async () => {
		readRows.mockRejectedValue(new Error('no such table: main.gone'));
		renderViewer();
		expect(await screen.findByTestId('sqlite-rows-error')).toHaveTextContent(
			'Could not read the rows of events: no such table: main.gone'
		);
	});

	it('switches to the schema and back, and remembers the choice', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-table-view');
		fireEvent.click(screen.getByTestId('sqlite-object-view-schema'));
		expect(await screen.findByTestId('sqlite-schema')).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-table-view')).not.toBeInTheDocument();
		expect(localStorage.getItem('sqlite-object-view')).toBe('schema');
		fireEvent.click(screen.getByTestId('sqlite-object-view-data'));
		expect(await screen.findByTestId('sqlite-table-view')).toBeInTheDocument();
	});

	it('reads a view the same way, and starts over for each selected object', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-table-view');
		fireEvent.click(screen.getByTestId('sqlite-rail-object-active_users'));
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(
				expect.objectContaining({ name: 'active_users', offset: 0, sort: null })
			)
		);
	});

	it('filters in SQLite once typing pauses, starting again from the first window', async () => {
		renderViewer();
		const input = await screen.findByTestId('sqlite-filter-input');
		fireEvent.change(input, { target: { value: 'kind = click' } });
		// Not on the keystroke: the filter waits for the debounce.
		expect(readRows).not.toHaveBeenLastCalledWith(
			expect.objectContaining({ filter: 'kind = click' })
		);
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(
				expect.objectContaining({ name: 'events', offset: 0, filter: 'kind = click' })
			)
		);
		const footer = await screen.findByTestId('sqlite-rows-footer');
		await waitFor(() => expect(footer).toHaveTextContent('2 matching rows'));
		expect(footer).toHaveTextContent('2 loaded');
	});

	it('says when a filter matches nothing', async () => {
		renderViewer();
		const input = await screen.findByTestId('sqlite-filter-input');
		readRows.mockImplementation(async (request: SqliteRowsRequest) => eventsPage(request, 0));
		fireEvent.change(input, { target: { value: 'id = 999' } });
		await waitFor(() =>
			expect(screen.getByTestId('sqlite-rows-footer')).toHaveTextContent('No matching rows')
		);
	});

	it('underlines a filter that does not parse and keeps the last good rows', async () => {
		renderViewer();
		const input = await screen.findByTestId('sqlite-filter-input');
		await screen.findByTestId('sqlite-row-1');
		readRows.mockImplementation(async (request: SqliteRowsRequest) => ({
			...eventsPage(request),
			rows: [],
			hasMore: false,
			filtered: false,
			filterProblem: {
				message: 'No column "knd". Did you mean "kind"?',
				start: 0,
				end: 3,
				suggestion: 'kind',
			},
		}));
		fireEvent.change(input, { target: { value: 'knd = click' } });
		expect(await screen.findByTestId('sqlite-filter-error')).toHaveTextContent(
			'No column "knd". Did you mean "kind"?'
		);
		expect(screen.getByTestId('sqlite-row-1')).toHaveTextContent('click');
		fireEvent.click(screen.getByText('Use "kind"'));
		expect(screen.getByTestId('sqlite-filter-input')).toHaveValue('kind = click');
	});

	it("keeps each object's filter text when the selection moves away and back", async () => {
		renderViewer();
		const input = await screen.findByTestId('sqlite-filter-input');
		fireEvent.change(input, { target: { value: 'kind ~ cl' } });
		fireEvent.click(screen.getByTestId('sqlite-rail-object-users'));
		await waitFor(() => expect(screen.getByTestId('sqlite-filter-input')).toHaveValue(''));
		fireEvent.click(screen.getByTestId('sqlite-rail-object-events'));
		await waitFor(() => expect(screen.getByTestId('sqlite-filter-input')).toHaveValue('kind ~ cl'));
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(
				expect.objectContaining({ name: 'events', filter: 'kind ~ cl' })
			)
		);
	});

	it('focuses the filter on request (Cmd+F), switching from the schema to the rows', async () => {
		const ref = createRef<SqliteViewerHandle>();
		render(<SqliteViewer ref={ref} filePath="/data/app.db" fileName="app.db" theme={mockTheme} />);
		await screen.findByTestId('sqlite-table-view');
		fireEvent.click(screen.getByTestId('sqlite-object-view-schema'));
		await screen.findByTestId('sqlite-schema');
		act(() => ref.current?.focusFilter());
		const input = await screen.findByTestId('sqlite-filter-input');
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(localStorage.getItem('sqlite-object-view')).toBe('data');
	});

	it('ignores a focus request on an index, which has no rows to filter', async () => {
		const ref = createRef<SqliteViewerHandle>();
		render(<SqliteViewer ref={ref} filePath="/data/app.db" fileName="app.db" theme={mockTheme} />);
		await screen.findByTestId('sqlite-table-view');
		fireEvent.click(screen.getByTestId('sqlite-rail-object-users_email'));
		await screen.findByTestId('sqlite-schema');
		act(() => ref.current?.focusFilter());
		expect(screen.queryByTestId('sqlite-filter-input')).not.toBeInTheDocument();
	});

	it('shows an index or trigger as its schema, with no Data switch', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-table-view');
		fireEvent.click(screen.getByTestId('sqlite-rail-object-users_email'));
		expect(await screen.findByTestId('sqlite-schema')).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-object-view')).not.toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-table-view')).not.toBeInTheDocument();
	});
});

describe('SqliteViewer record view', () => {
	// The record view is a modal on the layer stack, which the app provides.
	function renderWithLayers() {
		return render(
			<LayerStackProvider>
				<SqliteViewer filePath="/data/app.db" fileName="app.db" theme={mockTheme} />
			</LayerStackProvider>
		);
	}

	/** The field list of the open record, as `key value` pairs in display order. */
	function recordRows(): string[] {
		const fields = screen.getByTestId('sqlite-row-detail-fields');
		return Array.from(fields.querySelectorAll('tr')).map((row) =>
			Array.from(row.querySelectorAll('td'))
				.map((cell) => cell.textContent ?? '')
				.join(' ')
		);
	}

	it('opens a row on double-click, one field per line', async () => {
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		expect(await screen.findByTestId('sqlite-row-detail-modal')).toHaveTextContent('Row 2 of 2');
		expect(recordRows()).toEqual(['id 2', 'kind click', 'payload BLOB 2.0 KB\nff …']);
	});

	it('keeps NULL apart from an empty string', async () => {
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-0'));
		await screen.findByTestId('sqlite-row-detail-modal');
		expect(recordRows()).toEqual(['id 1', 'kind empty', 'payload NULL']);
		expect(screen.getByTestId('sqlite-row-detail-placeholder')).toHaveTextContent('NULL');
		expect(screen.getByTestId('sqlite-row-detail-empty')).toHaveTextContent('empty');
	});

	it('draws a real NULL apart from the TEXT value "NULL"', async () => {
		readRows.mockImplementation(async (request: SqliteRowsRequest) => ({
			...eventsPage(request, 1),
			rows: [[1, 'NULL', null]],
		}));
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-0'));
		await screen.findByTestId('sqlite-row-detail-modal');
		expect(recordRows()).toEqual(['id 1', 'kind NULL', 'payload NULL']);
		// Only the real NULL is a placeholder, and only data offers a copy.
		const placeholders = screen.getAllByTestId('sqlite-row-detail-placeholder');
		expect(placeholders).toHaveLength(1);
		expect(placeholders[0].closest('tr')).toHaveTextContent('payload');
		expect(screen.getByRole('button', { name: 'Copy kind' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Copy payload' })).not.toBeInTheDocument();
	});

	it('steps through the loaded rows with Left and Right', async () => {
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-0'));
		const fields = await screen.findByTestId('sqlite-row-detail-fields');
		fireEvent.keyDown(fields, { key: 'ArrowRight' });
		expect(screen.getByTestId('sqlite-row-detail-modal')).toHaveTextContent('Row 2 of 2');
		expect(recordRows()[0]).toBe('id 2');
		fireEvent.keyDown(fields, { key: 'ArrowLeft' });
		expect(recordRows()[0]).toBe('id 1');
	});

	it('reads the next window when stepping near the last loaded row', async () => {
		readRows.mockImplementation(async (request: SqliteRowsRequest) => eventsPage(request, 400));
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-290'));
		const fields = await screen.findByTestId('sqlite-row-detail-fields');
		expect(readRows).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(fields, { key: 'ArrowRight' });
		expect(readRows).not.toHaveBeenCalledWith(expect.objectContaining({ offset: 300 }));
		for (let step = 0; step < 4; step++) fireEvent.keyDown(fields, { key: 'ArrowRight' });
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 300 }))
		);
		await waitFor(() =>
			expect(screen.getByTestId('sqlite-row-detail-modal')).toHaveTextContent('Row 296 of 400')
		);
	});

	it('closes from its close control', async () => {
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		await screen.findByTestId('sqlite-row-detail-modal');
		fireEvent.click(screen.getByLabelText('Close modal'));
		await waitFor(() =>
			expect(screen.queryByTestId('sqlite-row-detail-modal')).not.toBeInTheDocument()
		);
	});

	it('offers Save to file only on a BLOB field', async () => {
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		await screen.findByTestId('sqlite-row-detail-modal');
		const actions = screen.getAllByTestId('sqlite-row-detail-action');
		expect(actions).toHaveLength(1);
		expect(actions[0]).toHaveAccessibleName('Save BLOB to file: payload');
	});

	it('saves a BLOB with no rowid by its position, guarded by what the cell showed', async () => {
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		await screen.findByTestId('sqlite-row-detail-modal');
		fireEvent.click(screen.getByTestId('sqlite-row-detail-action'));
		await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
		expect(saveFile).toHaveBeenCalledWith({
			title: 'Save BLOB to file',
			defaultPath: 'events-payload-2.bin',
		});
		expect(saveBlob).toHaveBeenCalledWith({
			handle: 'h1',
			name: 'events',
			column: 'payload',
			rowid: null,
			offset: 1,
			sort: null,
			filter: null,
			expected: { bytes: 2048, head: 'ff' },
			destPath: '/tmp/payload.bin',
		});
		await waitFor(() =>
			expect(notifyToastMock).toHaveBeenCalledWith({
				color: 'green',
				title: 'BLOB saved',
				message: '2.0 KB written to /tmp/payload.bin',
			})
		);
	});

	it('saves a BLOB by the rowid its page carried, wherever the row sits', async () => {
		readRows.mockImplementation(async (request: SqliteRowsRequest) => ({
			...eventsPage(request),
			rowids: ['41', '42'],
		}));
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		await screen.findByTestId('sqlite-row-detail-modal');
		fireEvent.click(screen.getByTestId('sqlite-row-detail-action'));
		await waitFor(() =>
			expect(saveBlob).toHaveBeenCalledWith(expect.objectContaining({ rowid: '42', offset: null }))
		);
		expect(saveFile).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: 'events-payload-42.bin' })
		);
	});

	it('names the position with the sort the rows were read with', async () => {
		renderWithLayers();
		await screen.findByTestId('sqlite-row-1');
		fireEvent.click(screen.getByTestId('sqlite-header-kind'));
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(
				expect.objectContaining({ sort: { column: 'kind', direction: 'asc' } })
			)
		);
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		await screen.findByTestId('sqlite-row-detail-modal');
		fireEvent.click(screen.getByTestId('sqlite-row-detail-action'));
		await waitFor(() =>
			expect(saveBlob).toHaveBeenCalledWith(
				expect.objectContaining({ offset: 1, sort: { column: 'kind', direction: 'asc' } })
			)
		);
	});

	it('does nothing when the save dialog is cancelled', async () => {
		saveFile.mockResolvedValue(null);
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		await screen.findByTestId('sqlite-row-detail-modal');
		fireEvent.click(screen.getByTestId('sqlite-row-detail-action'));
		await waitFor(() => expect(saveFile).toHaveBeenCalled());
		expect(saveBlob).not.toHaveBeenCalled();
		expect(notifyToastMock).not.toHaveBeenCalled();
	});

	it('reports a refused save in a toast', async () => {
		saveBlob.mockRejectedValue(
			new Error('payload in row 2 changed since it was read. Reload the table and try again.')
		);
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		await screen.findByTestId('sqlite-row-detail-modal');
		fireEvent.click(screen.getByTestId('sqlite-row-detail-action'));
		await waitFor(() =>
			expect(notifyToastMock).toHaveBeenCalledWith({
				color: 'red',
				title: 'Could not save the BLOB',
				message: 'payload in row 2 changed since it was read. Reload the table and try again.',
			})
		);
	});

	it('closes on a new sort, whose row at that position is a different row', async () => {
		renderWithLayers();
		fireEvent.doubleClick(await screen.findByTestId('sqlite-row-1'));
		await screen.findByTestId('sqlite-row-detail-modal');
		fireEvent.click(screen.getByTestId('sqlite-header-kind'));
		await waitFor(() =>
			expect(screen.queryByTestId('sqlite-row-detail-modal')).not.toBeInTheDocument()
		);
	});
});

describe('SqliteViewer converging row count', () => {
	const total = () => screen.getByTestId('sqlite-rows-total');

	it('shows a lower bound from the first window, then the settled count', async () => {
		readRows.mockImplementation(async (request: SqliteRowsRequest) => eventsPage(request, 5000));
		let resolveFirst: (count: SqliteRowCount) => void = () => {};
		countRows.mockImplementationOnce(
			() => new Promise<SqliteRowCount>((resolve) => (resolveFirst = resolve))
		);
		countRows.mockImplementationOnce(async (request: SqliteCountRequest) =>
			countReply(request, 5000)
		);
		renderViewer();
		await screen.findByTestId('sqlite-row-0');
		expect(total()).toHaveTextContent('300+ rows');
		expect(screen.getByTestId('sqlite-rows-counting')).toBeInTheDocument();
		await waitFor(() => expect(countRows).toHaveBeenCalledTimes(1));

		resolveFirst(countReply({ handle: 'h1', name: 'events' }, 1200, false));
		await waitFor(() => expect(total()).toHaveTextContent('5,000 rows'));
		expect(total()).not.toHaveTextContent('+');
		expect(screen.queryByTestId('sqlite-rows-counting')).not.toBeInTheDocument();
		// The second call resumed where the first stopped.
		expect(countRows).toHaveBeenNthCalledWith(2, {
			handle: 'h1',
			name: 'events',
			filter: null,
			cursor: { matched: 1200, scanned: 1200, afterRowid: '1200' },
		});
	});

	it('is exact as soon as paging reaches the last row', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-row-1');
		expect(total()).toHaveTextContent('2 rows');
		expect(screen.queryByTestId('sqlite-rows-counting')).not.toBeInTheDocument();
	});

	it('counts the filter the rows were read with, and starts over on a new one', async () => {
		renderViewer();
		const input = await screen.findByTestId('sqlite-filter-input');
		await waitFor(() => expect(countRows).toHaveBeenCalledTimes(1));
		countRows.mockImplementation(async (request: SqliteCountRequest) => countReply(request, 1));
		readRows.mockImplementation(async (request: SqliteRowsRequest) => eventsPage(request, 1));
		fireEvent.change(input, { target: { value: 'kind = click' } });
		await waitFor(() =>
			expect(countRows).toHaveBeenLastCalledWith({
				handle: 'h1',
				name: 'events',
				filter: 'kind = click',
				cursor: null,
			})
		);
		await waitFor(() => expect(total()).toHaveTextContent('1 matching row'));
	});

	it('does not count again for a new sort, which keeps the same rows', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-header-kind');
		await waitFor(() => expect(countRows).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByTestId('sqlite-header-kind'));
		await waitFor(() =>
			expect(readRows).toHaveBeenLastCalledWith(
				expect.objectContaining({ sort: { column: 'kind', direction: 'asc' } })
			)
		);
		expect(countRows).toHaveBeenCalledTimes(1);
	});

	it('pauses a very large count for "Count all", which resumes it', async () => {
		readRows.mockImplementation(async (request: SqliteRowsRequest) => eventsPage(request, 10_000));
		let calls = 0;
		countRows.mockImplementation(async (request: SqliteCountRequest) => {
			calls++;
			return calls > AUTO_COUNT_PASSES + 2
				? countReply(request, 9_000_000)
				: countReply(request, calls * 1000, false);
		});
		renderViewer();
		const button = await screen.findByTestId('sqlite-count-all');
		expect(countRows).toHaveBeenCalledTimes(AUTO_COUNT_PASSES);
		expect(total()).toHaveTextContent(
			`${(AUTO_COUNT_PASSES * 1000).toLocaleString('en-US')}+ rows`
		);

		fireEvent.click(button);
		await waitFor(() => expect(total()).toHaveTextContent('9,000,000 rows'));
		expect(countRows).toHaveBeenNthCalledWith(
			AUTO_COUNT_PASSES + 1,
			expect.objectContaining({
				cursor: {
					matched: AUTO_COUNT_PASSES * 1000,
					scanned: AUTO_COUNT_PASSES * 1000,
					afterRowid: String(AUTO_COUNT_PASSES * 1000),
				},
			})
		);
		expect(screen.queryByTestId('sqlite-count-all')).not.toBeInTheDocument();
	});

	it("replaces the rail's capped count once the unfiltered count settles", async () => {
		countRows.mockImplementation(async (request: SqliteCountRequest) =>
			countReply(request, 250_003)
		);
		readRows.mockImplementation(async (request: SqliteRowsRequest) => eventsPage(request, 1000));
		renderViewer();
		await waitFor(() =>
			expect(screen.getByTestId('sqlite-rail-rows-events')).toHaveTextContent('250,003')
		);
		expect(screen.getByTestId('sqlite-rail-rows-events')).not.toHaveTextContent('+');
	});

	it('leaves the rail alone for a filtered count', async () => {
		countRows.mockImplementation((request: SqliteCountRequest) =>
			request.filter
				? Promise.resolve(countReply(request, 7))
				: new Promise<SqliteRowCount>(() => {})
		);
		renderViewer();
		const input = await screen.findByTestId('sqlite-filter-input');
		expect(await screen.findByTestId('sqlite-rail-rows-events')).toHaveTextContent('100,000+');
		fireEvent.change(input, { target: { value: 'kind = click' } });
		await waitFor(() =>
			expect(countRows).toHaveBeenLastCalledWith(
				expect.objectContaining({ filter: 'kind = click' })
			)
		);
		expect(screen.getByTestId('sqlite-rail-rows-events')).toHaveTextContent('100,000+');
	});

	it('says when counting stopped, and why', async () => {
		readRows.mockImplementation(async (request: SqliteRowsRequest) => eventsPage(request, 5000));
		countRows.mockRejectedValue(new Error('database is locked'));
		renderViewer();
		expect(await screen.findByTestId('sqlite-count-error')).toHaveTextContent(
			'Counting stopped: database is locked'
		);
		expect(total()).toHaveTextContent('300+ rows');
	});
});

describe('SqliteViewer database summary', () => {
	it('shows the header facts of the database in the summary strip', async () => {
		renderViewer();
		expect(await screen.findByTestId('sqlite-fact-pages')).toHaveTextContent('Pages 16 x 4.0 KB');
		expect(screen.getByTestId('sqlite-fact-encoding')).toHaveTextContent('UTF-8');
		expect(screen.getByTestId('sqlite-fact-journal')).toHaveTextContent('Journal WAL');
		expect(screen.getByTestId('sqlite-fact-user-version')).toHaveTextContent('user_version 3');
		// Unset header fields stay out of the strip.
		expect(screen.queryByTestId('sqlite-fact-application-id')).not.toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-fact-freelist')).not.toBeInTheDocument();
		expect(readSummary).toHaveBeenCalledWith('h1');
	});

	it('shows a summary read failure without blocking the viewer', async () => {
		readSummary.mockRejectedValue(new Error('database is locked'));
		renderViewer();
		expect(await screen.findByTestId('sqlite-summary-error')).toHaveTextContent(
			'database is locked'
		);
		expect(screen.getByTestId('sqlite-object-rail')).toBeInTheDocument();
	});

	it('runs a quick check on open for a small database, then offers a full one', async () => {
		checkIntegrity.mockResolvedValueOnce(integrityResult());
		renderViewer();
		expect(await screen.findByTestId('sqlite-integrity-ok')).toHaveTextContent('Integrity ok');
		expect(checkIntegrity).toHaveBeenCalledWith('h1', 'quick');

		checkIntegrity.mockResolvedValueOnce(integrityResult({ mode: 'full' }));
		fireEvent.click(screen.getByTestId('sqlite-integrity-full'));
		await waitFor(() => expect(checkIntegrity).toHaveBeenLastCalledWith('h1', 'full'));
		// A full check leaves nothing further to offer.
		await waitFor(() =>
			expect(screen.queryByTestId('sqlite-integrity-full')).not.toBeInTheDocument()
		);
		expect(screen.getByTestId('sqlite-integrity-ok')).toBeInTheDocument();
	});

	it('shows the check in progress', async () => {
		renderViewer();
		expect(await screen.findByTestId('sqlite-integrity')).toHaveTextContent(
			'Running quick check...'
		);
	});

	it('waits to be asked for a database over the auto-check size', async () => {
		open.mockResolvedValue({ ...INFO, fileBytes: SQLITE_AUTO_INTEGRITY_MAX_BYTES + 1 });
		renderViewer();
		const button = await screen.findByTestId('sqlite-integrity-check');
		expect(checkIntegrity).not.toHaveBeenCalled();
		fireEvent.click(button);
		expect(checkIntegrity).toHaveBeenCalledWith('h1', 'quick');
	});

	it('lists the problems a failed check found, and folds them away on click', async () => {
		checkIntegrity.mockResolvedValueOnce(
			integrityResult({ ok: false, problems: ['wrong # of entries in index tv', 'page 5 bad'] })
		);
		renderViewer();
		const flag = await screen.findByTestId('sqlite-integrity-failed');
		expect(flag).toHaveTextContent('Integrity: 2 problems (quick check, 5 ms)');
		const problems = screen.getByTestId('sqlite-integrity-problems');
		expect(
			within(problems)
				.getAllByRole('listitem')
				.map((item) => item.textContent)
		).toEqual(['wrong # of entries in index tv', 'page 5 bad']);
		fireEvent.click(flag);
		expect(screen.queryByTestId('sqlite-integrity-problems')).not.toBeInTheDocument();
	});

	it('reports a check that could not run, and runs it again on Retry', async () => {
		checkIntegrity.mockRejectedValueOnce(new Error('database is locked'));
		renderViewer();
		expect(await screen.findByTestId('sqlite-integrity-error')).toHaveTextContent(
			'database is locked'
		);
		checkIntegrity.mockResolvedValueOnce(integrityResult());
		fireEvent.click(screen.getByTestId('sqlite-integrity-retry'));
		expect(await screen.findByTestId('sqlite-integrity-ok')).toBeInTheDocument();
		expect(checkIntegrity).toHaveBeenCalledTimes(2);
		expect(checkIntegrity).toHaveBeenLastCalledWith('h1', 'quick');
	});
});

describe('SqliteViewer editing unlock', () => {
	it('opens read-only and asks for nothing until editing is enabled', async () => {
		renderViewer();
		const strip = await screen.findByTestId('sqlite-editing');
		expect(strip).toHaveTextContent('read-only');
		expect(screen.getByTestId('sqlite-editing-enable')).toHaveTextContent('Enable editing');
		expect(enableEditing).not.toHaveBeenCalled();
	});

	it('enables editing for this tab in one click, and Lock releases the grant', async () => {
		renderViewer();
		fireEvent.click(await screen.findByTestId('sqlite-editing-enable'));
		expect(enableEditing).toHaveBeenCalledWith('h1');
		expect(await screen.findByTestId('sqlite-editing-disable')).toBeInTheDocument();
		expect(screen.getByTestId('sqlite-editing')).toHaveTextContent('editing enabled');
		expect(disableEditing).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('sqlite-editing-disable'));
		expect(await screen.findByTestId('sqlite-editing-enable')).toBeInTheDocument();
		expect(disableEditing).toHaveBeenCalledWith('h1', 'token-1');
		expect(disableEditing).toHaveBeenCalledTimes(1);
	});

	it('shows why editing was refused, and stays read-only', async () => {
		enableEditing.mockRejectedValueOnce(
			new Error(
				"Error invoking remote method 'sqlite:enableEditing': Error: You do not have permission to write /data/app.db."
			)
		);
		renderViewer();
		fireEvent.click(await screen.findByTestId('sqlite-editing-enable'));
		expect(await screen.findByTestId('sqlite-editing-error')).toHaveTextContent(
			'You do not have permission to write /data/app.db.'
		);
		expect(screen.getByTestId('sqlite-editing')).toHaveTextContent('read-only');
		expect(screen.getByTestId('sqlite-editing-enable')).not.toBeDisabled();
	});

	it('releases the grant when the tab goes away', async () => {
		const view = renderViewer();
		fireEvent.click(await screen.findByTestId('sqlite-editing-enable'));
		await screen.findByTestId('sqlite-editing-disable');
		view.unmount();
		expect(disableEditing).toHaveBeenCalledWith('h1', 'token-1');
	});

	it('starts read-only on another file and releases the old grant', async () => {
		const view = renderViewer();
		fireEvent.click(await screen.findByTestId('sqlite-editing-enable'));
		await screen.findByTestId('sqlite-editing-disable');

		open.mockResolvedValue({ ...INFO, handle: 'h2', displayPath: '/data/other.db' });
		view.rerender(<SqliteViewer filePath="/data/other.db" fileName="other.db" theme={mockTheme} />);
		expect(disableEditing).toHaveBeenCalledWith('h1', 'token-1');
		expect(await screen.findByTestId('sqlite-editing-enable')).toBeInTheDocument();
	});

	it('says in the rows footer how an edit names a row, only once editing is enabled', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-row-0');
		expect(screen.queryByTestId('sqlite-rows-editability')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId('sqlite-editing-enable'));
		const label = await screen.findByTestId('sqlite-rows-editability');
		expect(label).toHaveTextContent('rows keyed by primary key');
		expect(label).toHaveAttribute(
			'title',
			'Editable. An edit names its row by the primary key (id). Generated columns cannot be edited: payload.'
		);

		fireEvent.click(screen.getByTestId('sqlite-editing-disable'));
		await screen.findByTestId('sqlite-editing-enable');
		expect(screen.queryByTestId('sqlite-rows-editability')).not.toBeInTheDocument();
	});

	it('shows why the rows are read-only, in the warning color', async () => {
		readRows.mockImplementation(async (request: SqliteRowsRequest) => ({
			...eventsPage(request),
			editability: {
				editable: false,
				code: 'virtual-table',
				reason: 'events is a virtual table (module fts5).',
			},
		}));
		renderViewer();
		fireEvent.click(await screen.findByTestId('sqlite-editing-enable'));
		const label = await screen.findByTestId('sqlite-rows-editability');
		expect(label).toHaveTextContent('read-only: virtual table');
		expect(label).toHaveAttribute('title', 'Read-only. events is a virtual table (module fts5).');
		expect(label).toHaveStyle({ color: mockTheme.colors.warning });
	});

	it('releases a grant that arrives after the tab went away', async () => {
		let resolveGrant: (grant: { handle: string; editToken: string }) => void = () => {};
		enableEditing.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveGrant = resolve;
			})
		);
		const view = renderViewer();
		fireEvent.click(await screen.findByTestId('sqlite-editing-enable'));
		view.unmount();
		await act(async () => {
			resolveGrant({ handle: 'h1', editToken: 'late' });
		});
		expect(disableEditing).toHaveBeenCalledWith('h1', 'late');
	});
});

describe('SqliteViewer query editor', () => {
	it('opens on Browse, and Query swaps the content pane for the SQL editor', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-object-pane');
		expect(screen.queryByTestId('sqlite-query-panel')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-query'));
		expect(await screen.findByTestId('sqlite-query-panel')).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-object-pane')).not.toBeInTheDocument();
		// The rail stays as a reference while writing SQL.
		expect(screen.getByTestId('sqlite-object-rail')).toBeInTheDocument();
		expect(localStorage.getItem('sqlite-viewer-mode')).toBe('query');
	});

	it('remembers Query across a reopen', async () => {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		expect(await screen.findByTestId('sqlite-query-panel')).toBeInTheDocument();
	});

	it("feeds the editor a SQL grammar built from the database's column catalog", async () => {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		const editor = await screen.findByRole('textbox');
		expect(editor).toHaveAttribute('data-language', 'sql');
		await waitFor(() => expect(editor).toHaveAttribute('data-language-extension', 'host'));
		expect(readColumns).toHaveBeenCalledWith('h1');
		expect(screen.getByTestId('sqlite-query-status')).toHaveTextContent(
			'Completes keywords, table names, and the columns of the tables a statement names.'
		);
	});

	it('keeps keyword completion and says why when the catalog cannot be read', async () => {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		readColumns.mockRejectedValue(new Error('SQLite database handle is no longer open.'));
		renderViewer();
		expect(await screen.findByTestId('sqlite-query-catalog-error')).toHaveTextContent(
			'Completing keywords only. The table and column names could not be read: SQLite database handle is no longer open.'
		);
		// The plain grammar from the language loader still highlights and
		// completes keywords.
		expect(screen.getByRole('textbox')).toHaveAttribute('data-language-extension', 'loader');
	});

	it('keeps the query text across a switch to Browse and back', async () => {
		renderViewer();
		await screen.findByTestId('sqlite-object-pane');
		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-query'));
		fireEvent.change(await screen.findByRole('textbox'), {
			target: { value: 'SELECT email FROM users' },
		});
		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-browse'));
		await screen.findByTestId('sqlite-object-pane');
		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-query'));
		expect(await screen.findByRole('textbox')).toHaveValue('SELECT email FROM users');
	});

	it('goes back to Browse when an object is picked in the rail', async () => {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		await screen.findByTestId('sqlite-query-panel');
		fireEvent.click(screen.getByTestId('sqlite-rail-object-users_email'));
		expect(await screen.findByTestId('sqlite-object-pane')).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-query-panel')).not.toBeInTheDocument();
		expect(localStorage.getItem('sqlite-viewer-mode')).toBe('browse');
	});

	it('leaves Cmd+F alone in Query mode instead of jumping to a filter box', async () => {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		const ref = createRef<SqliteViewerHandle>();
		render(<SqliteViewer ref={ref} filePath="/data/app.db" fileName="app.db" theme={mockTheme} />);
		await screen.findByTestId('sqlite-query-panel');
		act(() => ref.current?.focusFilter());
		expect(screen.getByTestId('sqlite-query-panel')).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-filter-input')).not.toBeInTheDocument();
	});
});

describe('SqliteViewer query runs', () => {
	async function openQuery(sql: string) {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		const editor = await screen.findByRole('textbox');
		fireEvent.change(editor, { target: { value: sql } });
		return editor;
	}

	it('runs the statement and fills the shared grid, a repeated name and all', async () => {
		await openQuery('SELECT id, id FROM users');
		fireEvent.click(screen.getByTestId('sqlite-query-run'));

		await screen.findByTestId('sqlite-query-grid');
		expect(runQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				handle: 'h1',
				sql: 'SELECT id, id FROM users',
				offset: 0,
				limit: 500,
			})
		);
		// Two result columns share a name; both are drawn.
		expect(screen.getByTestId('sqlite-query-header-0')).toHaveTextContent('id');
		expect(screen.getByTestId('sqlite-query-header-1')).toHaveTextContent('id');
		const second = screen.getByTestId('sqlite-query-row-1');
		expect(second).toHaveTextContent('NULL');
		expect(screen.getByTestId('sqlite-query-total')).toHaveTextContent('3 rows');
	});

	it('names each call so Stop can reach it, and stops the run in flight', async () => {
		runQuery.mockImplementation(() => new Promise(() => {}));
		await openQuery('SELECT * FROM users');
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		const queryId = runQuery.mock.calls[0][0].queryId as string;
		expect(queryId).toEqual(expect.any(String));

		fireEvent.click(await screen.findByTestId('sqlite-query-stop'));
		expect(cancelQuery).toHaveBeenCalledWith(queryId);
	});

	it('stops the older run when Run is pressed again, and keeps only the newer reply', async () => {
		let resolveFirst: (value: SqliteQueryResult) => void = () => {};
		runQuery.mockImplementationOnce(
			() =>
				new Promise<SqliteQueryResult>((resolve) => {
					resolveFirst = resolve;
				})
		);
		await openQuery('SELECT * FROM users');
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		const firstId = runQuery.mock.calls[0][0].queryId;
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		expect(cancelQuery).toHaveBeenCalledWith(firstId);

		await screen.findByTestId('sqlite-query-grid');
		await act(async () => {
			resolveFirst({ ...queryWindow({ handle: 'h1', sql: '' }), rows: [] });
		});
		// The stale reply did not replace the newer rows.
		expect(screen.getByTestId('sqlite-query-total')).toHaveTextContent('3 rows');
	});

	it('runs on Cmd+Enter in the editor', async () => {
		const editor = await openQuery('SELECT 1');
		fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
		await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
		fireEvent.keyDown(editor, { key: 'Enter' });
		expect(runQuery).toHaveBeenCalledTimes(1);
	});

	it('refuses a write under the editor without asking main, never as a toast', async () => {
		await openQuery('DELETE FROM users');
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		expect(await screen.findByTestId('sqlite-query-error')).toHaveTextContent(
			'DELETE is not a read-only statement.'
		);
		expect(runQuery).not.toHaveBeenCalled();
		expect(notifyToastMock).not.toHaveBeenCalled();
	});

	it("shows SQLite's error under the editor", async () => {
		runQuery.mockRejectedValue(new Error('no such table: userz'));
		await openQuery('SELECT * FROM userz');
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		expect(await screen.findByTestId('sqlite-query-error')).toHaveTextContent(
			'no such table: userz'
		);
		expect(notifyToastMock).not.toHaveBeenCalled();
	});

	it('says when a statement returns no rows by design', async () => {
		runQuery.mockResolvedValue({
			statement: 'PRAGMA',
			columns: [],
			rows: [],
			offset: 0,
			hasMore: false,
			returnsRows: false,
			elapsedMs: 0,
		});
		await openQuery('PRAGMA trusted_schema = ON');
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		expect(await screen.findByTestId('sqlite-query-empty')).toHaveTextContent(
			'PRAGMA ran and returns no rows.'
		);
	});

	it('keeps the result across a switch to Browse and back', async () => {
		await openQuery('SELECT * FROM users');
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		await screen.findByTestId('sqlite-query-grid');
		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-browse'));
		await screen.findByTestId('sqlite-object-pane');
		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-query'));
		expect(await screen.findByTestId('sqlite-query-grid')).toBeInTheDocument();
		expect(runQuery).toHaveBeenCalledTimes(1);
	});
});

describe('SqliteViewer query errors against the statement', () => {
	async function failQuery(sql: string, error: Error) {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		runQuery.mockRejectedValue(error);
		renderViewer();
		const editor = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: sql } });
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		await screen.findByTestId('sqlite-query-error');
		return editor;
	}

	it('underlines the token SQLite stopped at and names its line and column', async () => {
		const sql = 'SELECT * FROM users\nWHERE id = = 1';
		const at = sql.lastIndexOf('=');
		// What Electron hands the renderer: its wrapper, the message, and the offset on it.
		const editor = await failQuery(
			sql,
			new Error(
				`Error invoking remote method 'sqlite:runQuery': Error: near "=": syntax error\n[at character ${at}]`
			)
		);
		const error = screen.getByTestId('sqlite-query-error');
		expect(error).toHaveTextContent('Line 2, column 12: near "=": syntax error');
		expect(error).not.toHaveTextContent('at character');
		expect(editor).toHaveAttribute('data-problem-from', String(at));
		expect(editor).toHaveAttribute('data-problem-to', String(at + 1));
		expect(editor).toHaveAttribute('data-problem-message', 'near "=": syntax error');
		expect(notifyToastMock).not.toHaveBeenCalled();
	});

	it('puts the cursor on the span when its place is clicked', async () => {
		const sql = 'SELECT emial FROM users';
		const editor = await failQuery(sql, new Error('no such column: emial'));
		fireEvent.click(screen.getByTestId('sqlite-query-error-place'));
		expect(editor.selectionStart).toBe(7);
		expect(editor.selectionEnd).toBe(12);
		expect(document.activeElement).toBe(editor);
	});

	it('places a refusal at its keyword without asking main', async () => {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		const editor = await screen.findByRole('textbox');
		fireEvent.change(editor, { target: { value: '  DELETE FROM users' } });
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		expect(await screen.findByTestId('sqlite-query-error-place')).toHaveTextContent(
			'Line 1, column 3'
		);
		expect(editor).toHaveAttribute('data-problem-from', '2');
		expect(runQuery).not.toHaveBeenCalled();
	});

	it('clears the underline once the text that ran is edited, and shows no place for an error without one', async () => {
		const editor = await failQuery('SELECT * FORM users', new Error('near "FORM": syntax error'));
		expect(editor).toHaveAttribute('data-problem-from', '9');
		fireEvent.change(editor, { target: { value: 'SELECT * FROM users' } });
		expect(editor).not.toHaveAttribute('data-problem-from');
		// The error itself stays until the next run says otherwise.
		expect(screen.getByTestId('sqlite-query-error')).toHaveTextContent('near "FORM": syntax error');
		expect(screen.queryByTestId('sqlite-query-error-place')).not.toBeInTheDocument();
	});

	it('shows an error that names no place as it is', async () => {
		const editor = await failQuery('SELECT 1', new Error('The query was stopped.'));
		expect(screen.getByTestId('sqlite-query-error')).toHaveTextContent('The query was stopped.');
		expect(screen.queryByTestId('sqlite-query-error-place')).not.toBeInTheDocument();
		expect(editor).not.toHaveAttribute('data-problem-from');
	});
});

describe('SqliteViewer query parameters', () => {
	async function openQuery(sql: string) {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		const editor = await screen.findByTestId('sqlite-query-panel');
		fireEvent.change(within(editor).getAllByRole('textbox')[0], { target: { value: sql } });
	}

	it('shows no parameter boxes for a statement without parameters', async () => {
		await openQuery("SELECT ':not' FROM users -- ?");
		expect(screen.queryByTestId('sqlite-query-parameters')).not.toBeInTheDocument();
	});

	it('shows one box per parameter as the statement is typed, a repeated name once', async () => {
		await openQuery('SELECT * FROM users WHERE id = ? OR email = :email OR name = :email');
		expect(screen.getByTestId('sqlite-query-parameter-?1')).toBeInTheDocument();
		expect(screen.getByTestId('sqlite-query-parameter-:email')).toBeInTheDocument();
		expect(screen.getAllByTestId(/^sqlite-query-parameter-input-/)).toHaveLength(2);
	});

	it('sends the values with the run, typed, an untouched box as empty text', async () => {
		await openQuery('SELECT * FROM users WHERE id = ? AND email = :email AND note IS @note');
		fireEvent.change(screen.getByTestId('sqlite-query-parameter-input-?1'), {
			target: { value: '42' },
		});
		fireEvent.click(screen.getByTestId('sqlite-query-parameter-type-?1-number'));
		fireEvent.click(screen.getByTestId('sqlite-query-parameter-type-@note-null'));
		expect(screen.getByTestId('sqlite-query-parameter-input-@note')).toBeDisabled();
		fireEvent.click(screen.getByTestId('sqlite-query-run'));

		await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
		expect(runQuery.mock.calls[0][0].params).toEqual({
			'?1': { type: 'number', text: '42' },
			':email': { type: 'text', text: '' },
			'@note': { type: 'null', text: '' },
		});
	});

	it('runs on Enter in a parameter box', async () => {
		await openQuery('SELECT :a');
		const box = screen.getByTestId('sqlite-query-parameter-input-:a');
		fireEvent.change(box, { target: { value: 'x' } });
		fireEvent.keyDown(box, { key: 'Enter' });
		await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
		expect(runQuery.mock.calls[0][0].params).toEqual({ ':a': { type: 'text', text: 'x' } });
	});

	it('refuses a Number box that holds no number under the editor, without asking main', async () => {
		await openQuery('SELECT :n');
		fireEvent.change(screen.getByTestId('sqlite-query-parameter-input-:n'), {
			target: { value: 'ten' },
		});
		fireEvent.click(screen.getByTestId('sqlite-query-parameter-type-:n-number'));
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		expect(await screen.findByTestId('sqlite-query-error')).toHaveTextContent(
			':n is set to Number, but "ten" is not a number.'
		);
		expect(runQuery).not.toHaveBeenCalled();
		expect(notifyToastMock).not.toHaveBeenCalled();
	});

	it('warns about ? mixed with ?NNN as it is typed, and refuses to run it', async () => {
		await openQuery('SELECT ?, ?2');
		expect(screen.getByTestId('sqlite-query-parameters-problem')).toHaveTextContent(
			'mixes ? with numbered parameters'
		);
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		expect(await screen.findByTestId('sqlite-query-error')).toHaveTextContent(
			'Number every parameter or none.'
		);
		expect(runQuery).not.toHaveBeenCalled();
	});

	it('keeps a value when its parameter goes and comes back, and across Browse', async () => {
		await openQuery('SELECT :a');
		fireEvent.change(screen.getByTestId('sqlite-query-parameter-input-:a'), {
			target: { value: 'kept' },
		});
		const editor = within(screen.getByTestId('sqlite-query-panel')).getAllByRole('textbox')[0];
		fireEvent.change(editor, { target: { value: 'SELECT 1' } });
		expect(screen.queryByTestId('sqlite-query-parameters')).not.toBeInTheDocument();
		fireEvent.change(editor, { target: { value: 'SELECT :a' } });
		expect(screen.getByTestId('sqlite-query-parameter-input-:a')).toHaveValue('kept');

		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-browse'));
		await screen.findByTestId('sqlite-object-pane');
		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-query'));
		expect(await screen.findByTestId('sqlite-query-parameter-input-:a')).toHaveValue('kept');
	});
});

describe('SqliteViewer query plan', () => {
	const PLAN: SqliteQueryResult = {
		statement: 'SELECT',
		plan: true,
		columns: ['id', 'parent', 'notused', 'detail'].map((name) => ({ name, declaredType: null })),
		rows: [
			[2, 0, 0, 'CO-ROUTINE r'],
			[5, 2, 0, 'SCAN users'],
			[9, 0, 0, 'SEARCH events USING INDEX events_user (user_id=?)'],
			[18, 0, 0, 'USE TEMP B-TREE FOR ORDER BY'],
		],
		offset: 0,
		hasMore: false,
		returnsRows: true,
		elapsedMs: 1,
	};

	async function openQuery(sql: string) {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		const panel = await screen.findByTestId('sqlite-query-panel');
		fireEvent.change(within(panel).getAllByRole('textbox')[0], { target: { value: sql } });
	}

	it('starts on Rows, and runs a plan of the statement as written once switched to Plan', async () => {
		runQuery.mockResolvedValue(PLAN);
		await openQuery('SELECT * FROM users WHERE id = :id');
		expect(screen.getByTestId('sqlite-query-result-mode-rows')).toHaveAttribute(
			'aria-checked',
			'true'
		);
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-plan'));

		// A plan reads no rows, so switching to Plan runs it at once.
		await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
		expect(runQuery.mock.calls[0][0]).toMatchObject({
			sql: 'SELECT * FROM users WHERE id = :id',
			plan: true,
			offset: 0,
			limit: 1000,
			params: { ':id': { type: 'text', text: '' } },
		});
		expect(await screen.findByTestId('sqlite-query-plan')).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-query-grid')).not.toBeInTheDocument();
		expect(screen.getByTestId('sqlite-query-total')).toHaveTextContent(
			'Query plan of SELECT: 4 steps'
		);
	});

	it('draws the plan as a tree, each step marked by what it costs, with a legend', async () => {
		runQuery.mockResolvedValue(PLAN);
		await openQuery('SELECT 1');
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-plan'));
		await screen.findByTestId('sqlite-query-plan');

		const steps = screen.getAllByTestId('sqlite-query-plan-step');
		expect(steps.map((step) => step.textContent)).toEqual([
			'|--CO-ROUTINE r',
			'|  `--SCAN users',
			'|--SEARCH events USING INDEX events_user (user_id=?)',
			'`--USE TEMP B-TREE FOR ORDER BY',
		]);
		expect(steps.map((step) => step.getAttribute('data-kind'))).toEqual([
			'other',
			'scan',
			'search',
			'sort',
		]);
		expect(steps[1]).toHaveAttribute('aria-level', '2');
		const legend = screen.getByTestId('sqlite-query-plan-legend');
		expect(legend).toHaveTextContent('SCAN reads every row');
		expect(legend).toHaveTextContent('USE TEMP B-TREE');
		expect(legend).toHaveTextContent('SEARCH reaches rows');
	});

	it('keeps Plan on for the next Run, and switching back to Rows waits for Run', async () => {
		runQuery.mockResolvedValue(PLAN);
		await openQuery('SELECT * FROM users');
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-plan'));
		await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));
		expect(runQuery.mock.calls[1][0].plan).toBe(true);

		runQuery.mockImplementation(async (request: SqliteQueryRequest) => queryWindow(request));
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-rows'));
		expect(runQuery).toHaveBeenCalledTimes(2);
		// The plan stays on screen until the rows are asked for.
		expect(screen.getByTestId('sqlite-query-plan')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		expect(await screen.findByTestId('sqlite-query-grid')).toBeInTheDocument();
		expect(runQuery.mock.calls[2][0]).toMatchObject({ plan: false, limit: 500 });
	});

	it('does not run when switched to Plan with an empty editor', async () => {
		await openQuery('   ');
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-plan'));
		expect(screen.getByTestId('sqlite-query-empty')).toHaveTextContent('to see its query plan');
		expect(runQuery).not.toHaveBeenCalled();
	});

	it('refuses to plan an EXPLAIN or a write under the editor, without asking main', async () => {
		await openQuery('EXPLAIN SELECT 1');
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-plan'));
		expect(await screen.findByTestId('sqlite-query-error')).toHaveTextContent('already an EXPLAIN');
		const panel = screen.getByTestId('sqlite-query-panel');
		fireEvent.change(within(panel).getAllByRole('textbox')[0], {
			target: { value: 'DELETE FROM users' },
		});
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		await waitFor(() =>
			expect(screen.getByTestId('sqlite-query-error')).toHaveTextContent(
				'DELETE is not a read-only statement.'
			)
		);
		expect(runQuery).not.toHaveBeenCalled();
		expect(notifyToastMock).not.toHaveBeenCalled();
	});

	it('says when SQLite reports no plan steps', async () => {
		runQuery.mockResolvedValue({ ...PLAN, statement: 'PRAGMA', rows: [] });
		await openQuery('PRAGMA user_version');
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-plan'));
		expect(await screen.findByTestId('sqlite-query-plan-empty')).toBeInTheDocument();
	});

	it('keeps Plan and the plan across a switch to Browse and back', async () => {
		runQuery.mockResolvedValue(PLAN);
		await openQuery('SELECT 1');
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-plan'));
		await screen.findByTestId('sqlite-query-plan');
		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-browse'));
		await screen.findByTestId('sqlite-object-pane');
		fireEvent.click(screen.getByTestId('sqlite-viewer-mode-query'));
		expect(await screen.findByTestId('sqlite-query-plan')).toBeInTheDocument();
		expect(screen.getByTestId('sqlite-query-result-mode-plan')).toHaveAttribute(
			'aria-checked',
			'true'
		);
		expect(runQuery).toHaveBeenCalledTimes(1);
	});
});

describe('SqliteViewer query export', () => {
	async function runStatement(sql: string) {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		const panel = await screen.findByTestId('sqlite-query-panel');
		fireEvent.change(within(panel).getAllByRole('textbox')[0], { target: { value: sql } });
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		await screen.findByTestId('sqlite-query-grid');
	}

	it('stays off until a statement has rows to export', async () => {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		expect(await screen.findByTestId('sqlite-query-export')).toBeDisabled();
	});

	it('writes every row of the statement shown, with its values, to the file picked', async () => {
		saveFile.mockResolvedValue('/tmp/out.jsonl');
		await runStatement('SELECT * FROM users WHERE id > :min');
		// The editor moves on; the export is of what ran.
		fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'SELECT 2' } });
		fireEvent.click(screen.getByTestId('sqlite-query-export'));

		await waitFor(() => expect(exportQuery).toHaveBeenCalledTimes(1));
		expect(saveFile).toHaveBeenCalledWith({
			title: 'Export the query result',
			defaultPath: 'app-query.csv',
			filters: [
				{ name: 'CSV', extensions: ['csv'] },
				{ name: 'JSON Lines', extensions: ['jsonl'] },
			],
		});
		const request = exportQuery.mock.calls[0][0];
		expect(request).toMatchObject({
			handle: 'h1',
			sql: 'SELECT * FROM users WHERE id > :min',
			params: { ':min': { type: 'text', text: '' } },
			destPath: '/tmp/out.jsonl',
			format: 'jsonl',
		});
		expect(request.queryId).toEqual(expect.any(String));
		expect(await screen.findByTestId('sqlite-query-export-status')).toHaveTextContent(
			'Exported 3 rows to /tmp/out.jsonl'
		);
		expect(notifyToastMock).toHaveBeenCalledWith({
			color: 'green',
			title: 'Export complete',
			message: '3 rows written to /tmp/out.jsonl',
		});
	});

	it('does nothing when the save dialog is cancelled', async () => {
		saveFile.mockResolvedValue(null);
		await runStatement('SELECT 1');
		fireEvent.click(screen.getByTestId('sqlite-query-export'));
		await waitFor(() => expect(saveFile).toHaveBeenCalled());
		expect(exportQuery).not.toHaveBeenCalled();
		expect(screen.queryByTestId('sqlite-query-export-status')).not.toBeInTheDocument();
	});

	it('shows a failed export in the status line, not as a toast', async () => {
		saveFile.mockResolvedValue('/tmp/out.csv');
		exportQuery.mockRejectedValue(new Error('no such column: nope'));
		await runStatement('SELECT nope');
		fireEvent.click(screen.getByTestId('sqlite-query-export'));
		expect(await screen.findByTestId('sqlite-query-export-status')).toHaveTextContent(
			'Export failed: no such column: nope'
		);
		expect(notifyToastMock).not.toHaveBeenCalled();
	});

	it('stops an export in flight by its own id', async () => {
		saveFile.mockResolvedValue('/tmp/out.csv');
		exportQuery.mockImplementation(() => new Promise(() => {}));
		await runStatement('SELECT 1');
		fireEvent.click(screen.getByTestId('sqlite-query-export'));
		fireEvent.click(await screen.findByTestId('sqlite-query-export-stop'));
		const exportId = exportQuery.mock.calls[0][0].queryId;
		expect(cancelQuery).toHaveBeenCalledWith(exportId);
		expect(screen.getByTestId('sqlite-query-export')).toBeDisabled();
	});

	it('has nothing to export for a query plan', async () => {
		runQuery.mockResolvedValue({
			...queryWindow({ handle: 'h1', sql: '' }),
			plan: true,
			columns: ['id', 'parent', 'notused', 'detail'].map((name) => ({ name, declaredType: null })),
			rows: [[2, 0, 0, 'SCAN users']],
		});
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'SELECT 1' } });
		fireEvent.click(screen.getByTestId('sqlite-query-result-mode-plan'));
		await screen.findByTestId('sqlite-query-plan');
		expect(screen.getByTestId('sqlite-query-export')).toBeDisabled();
	});
});

describe('SqliteViewer query history', () => {
	const ENTRY: SqliteQueryHistoryEntry = {
		id: 'e1',
		sql: 'SELECT *\nFROM users WHERE id = :id',
		plan: true,
		params: { ':id': { type: 'number', text: '7' } },
		ranAt: Date.now() - 60_000,
		runs: 2,
		outcome: { ok: true, rows: 500, hasMore: true, returnsRows: true, elapsedMs: 3 },
	};
	const FAILED: SqliteQueryHistoryEntry = {
		...ENTRY,
		id: 'e2',
		sql: 'SELECT nope',
		plan: false,
		params: {},
		runs: 1,
		outcome: { ok: false, error: 'no such column: nope' },
	};

	async function openHistory() {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		fireEvent.click(await screen.findByTestId('sqlite-query-toggle-history'));
		return screen.findByTestId('sqlite-query-history');
	}

	it('is off by default, and the toggle opens it and is remembered', async () => {
		localStorage.setItem('sqlite-viewer-mode', 'query');
		renderViewer();
		await screen.findByTestId('sqlite-query-panel');
		expect(screen.queryByTestId('sqlite-query-history')).not.toBeInTheDocument();
		expect(readQueryHistory).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('sqlite-query-toggle-history'));
		expect(await screen.findByTestId('sqlite-query-history-empty')).toBeInTheDocument();
		expect(readQueryHistory).toHaveBeenCalledWith('h1');
		expect(localStorage.getItem('sqlite-query-history')).toBe('true');
	});

	it('lists the statements newest first, with how each last ended', async () => {
		readQueryHistory.mockResolvedValue({ path: '/data/app.db', entries: [ENTRY, FAILED] });
		await openHistory();
		const entries = await screen.findAllByTestId('sqlite-query-history-entry');
		expect(entries).toHaveLength(2);
		expect(entries[0]).toHaveTextContent('SELECT * FROM users WHERE id = :id');
		expect(entries[0]).toHaveTextContent('500+ rows');
		expect(entries[0]).toHaveTextContent('plan');
		expect(entries[0]).toHaveTextContent('x2');
		expect(entries[1]).toHaveTextContent('failed');
	});

	it('puts a picked statement back in the editor with its values and mode, without running it', async () => {
		readQueryHistory.mockResolvedValue({ path: '/data/app.db', entries: [ENTRY] });
		await openHistory();
		fireEvent.click(await screen.findByTestId('sqlite-query-history-pick'));

		expect(screen.getAllByRole('textbox')[0]).toHaveValue(ENTRY.sql);
		expect(await screen.findByTestId('sqlite-query-parameter-input-:id')).toHaveValue('7');
		expect(screen.getByTestId('sqlite-query-result-mode-plan')).toHaveAttribute(
			'aria-checked',
			'true'
		);
		expect(runQuery).not.toHaveBeenCalled();
	});

	it('reads the history again when a run settles', async () => {
		await openHistory();
		await waitFor(() => expect(readQueryHistory).toHaveBeenCalledTimes(1));
		fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'SELECT 1' } });
		fireEvent.click(screen.getByTestId('sqlite-query-run'));
		await screen.findByTestId('sqlite-query-grid');
		await waitFor(() => expect(readQueryHistory).toHaveBeenCalledTimes(2));
	});

	it('forgets one statement, and clears them all, showing what is left', async () => {
		readQueryHistory.mockResolvedValue({ path: '/data/app.db', entries: [ENTRY, FAILED] });
		forgetQueryHistory.mockResolvedValueOnce({ path: '/data/app.db', entries: [FAILED] });
		await openHistory();
		fireEvent.click((await screen.findAllByTestId('sqlite-query-history-forget'))[0]);
		await waitFor(() =>
			expect(screen.getAllByTestId('sqlite-query-history-entry')).toHaveLength(1)
		);
		expect(forgetQueryHistory).toHaveBeenCalledWith('h1', 'e1');

		fireEvent.click(screen.getByTestId('sqlite-query-history-clear'));
		expect(await screen.findByTestId('sqlite-query-history-empty')).toBeInTheDocument();
		expect(forgetQueryHistory).toHaveBeenLastCalledWith('h1', null);
	});

	it('says so when the history cannot be read', async () => {
		readQueryHistory.mockRejectedValue(new Error('EACCES'));
		await openHistory();
		expect(await screen.findByTestId('sqlite-query-history-error')).toHaveTextContent(
			'The history could not be read: EACCES'
		);
	});
});

describe('SqliteViewer cell edit', () => {
	/** events' columns, in grid order. */
	const COLUMN = { id: 0, kind: 1, payload: 2 } as const;

	/** The grid cell at a row and column: the row's children are the gutter, then the cells. */
	function cell(row: number, column: keyof typeof COLUMN): HTMLElement {
		return screen.getByTestId(`sqlite-row-${row}`).children[1 + COLUMN[column]] as HTMLElement;
	}

	async function renderEditing() {
		const view = render(
			<LayerStackProvider>
				<SqliteViewer filePath="/data/app.db" fileName="app.db" theme={mockTheme} />
			</LayerStackProvider>
		);
		await screen.findByTestId('sqlite-row-1');
		fireEvent.click(screen.getByTestId('sqlite-editing-enable'));
		await screen.findByTestId('sqlite-rows-editability');
		return view;
	}

	it('saves an edited cell as one UPDATE keyed on the whole primary key', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'kind'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		expect(editor).toHaveValue('click');

		fireEvent.change(editor, { target: { value: 'view' } });
		fireEvent.keyDown(editor, { key: 'Enter' });

		await waitFor(() => expect(updateCell).toHaveBeenCalledTimes(1));
		expect(updateCell).toHaveBeenCalledWith({
			handle: 'h1',
			editToken: 'token-1',
			name: 'events',
			column: 'kind',
			row: { kind: 'primary-key', values: { id: { type: 'integer', text: '2' } } },
			value: { type: 'text', text: 'view' },
		});
		await waitFor(() => expect(screen.queryByTestId('sqlite-cell-editor')).not.toBeInTheDocument());
		// The saved row replaces its line in place; nothing is read again.
		expect(cell(1, 'kind')).toHaveTextContent('view');
		expect(readRows).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('sqlite-edit-status')).toHaveTextContent('Saved kind in row 2');
		expect(screen.queryByTestId('sqlite-row-detail-modal')).not.toBeInTheDocument();
	});

	it('keeps a number a number, and re-keys the row when its key changes', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'id'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		fireEvent.change(editor, { target: { value: '20' } });
		fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() => expect(cell(1, 'id')).toHaveTextContent('20'));
		expect(updateCell).toHaveBeenLastCalledWith(
			expect.objectContaining({ column: 'id', value: { type: 'number', text: '20' } })
		);

		// The next edit of that row names it by its NEW key.
		fireEvent.doubleClick(cell(1, 'kind'));
		const next = await screen.findByTestId('sqlite-cell-editor');
		fireEvent.change(next, { target: { value: 'tap' } });
		fireEvent.keyDown(next, { key: 'Enter' });
		await waitFor(() => expect(updateCell).toHaveBeenCalledTimes(2));
		expect(updateCell).toHaveBeenLastCalledWith(
			expect.objectContaining({
				row: { kind: 'primary-key', values: { id: { type: 'integer', text: '20' } } },
			})
		);
	});

	it('writes nothing when the text did not change, so a NULL never becomes an empty string', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(0, 'payload'));
		// payload is generated: refused. id 1 opens unchanged and closes on Enter.
		expect(screen.queryByTestId('sqlite-cell-editor')).not.toBeInTheDocument();
		fireEvent.doubleClick(cell(0, 'id'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() => expect(screen.queryByTestId('sqlite-cell-editor')).not.toBeInTheDocument());
		expect(updateCell).not.toHaveBeenCalled();
	});

	it('sets NULL only through the NULL button, never by clearing the text', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'kind'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		const nullButton = screen.getByTestId('sqlite-cell-editor-null');
		expect(nullButton).toHaveAttribute('aria-pressed', 'false');

		fireEvent.click(nullButton);
		expect(nullButton).toHaveAttribute('aria-pressed', 'true');
		expect(editor).toHaveValue('');
		expect(editor).toHaveAttribute('placeholder', 'NULL');
		// Pressing the button is not leaving the cell: nothing saved yet.
		expect(updateCell).not.toHaveBeenCalled();

		fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() => expect(updateCell).toHaveBeenCalledTimes(1));
		expect(updateCell).toHaveBeenLastCalledWith(
			expect.objectContaining({ column: 'kind', value: { type: 'null', text: '' } })
		);
		await waitFor(() => expect(cell(1, 'kind')).toHaveTextContent('NULL'));
	});

	it('saves an emptied box as an empty string, and says so in the box', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'kind'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		fireEvent.change(editor, { target: { value: '' } });
		expect(editor).toHaveAttribute('placeholder', 'empty string');
		expect(screen.getByTestId('sqlite-cell-editor-null')).toHaveAttribute('aria-pressed', 'false');
		fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() => expect(updateCell).toHaveBeenCalledTimes(1));
		expect(updateCell).toHaveBeenLastCalledWith(
			expect.objectContaining({ column: 'kind', value: { type: 'text', text: '' } })
		);
	});

	it('sets an empty string to NULL with Alt+Cmd+Backspace, and typing leaves NULL again', async () => {
		await renderEditing();
		// Row 1's kind is an empty string, not NULL.
		fireEvent.doubleClick(cell(0, 'kind'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		const nullButton = screen.getByTestId('sqlite-cell-editor-null');
		expect(editor).toHaveAttribute('placeholder', 'empty string');

		fireEvent.keyDown(editor, { key: 'Backspace', altKey: true, metaKey: true });
		expect(nullButton).toHaveAttribute('aria-pressed', 'true');
		fireEvent.change(editor, { target: { value: 'x' } });
		expect(nullButton).toHaveAttribute('aria-pressed', 'false');
		expect(editor).toHaveValue('x');

		fireEvent.click(nullButton);
		fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() => expect(updateCell).toHaveBeenCalledTimes(1));
		expect(updateCell).toHaveBeenLastCalledWith(
			expect.objectContaining({
				column: 'kind',
				row: { kind: 'primary-key', values: { id: { type: 'integer', text: '1' } } },
				value: { type: 'null', text: '' },
			})
		);
	});

	it('cancels on Escape without writing', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'kind'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		fireEvent.change(editor, { target: { value: 'gone' } });
		fireEvent.keyDown(editor, { key: 'Escape' });
		expect(screen.queryByTestId('sqlite-cell-editor')).not.toBeInTheDocument();
		expect(cell(1, 'kind')).toHaveTextContent('click');
		expect(updateCell).not.toHaveBeenCalled();
	});

	it('says why a generated column cannot be edited instead of opening an editor', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'payload'));
		expect(screen.queryByTestId('sqlite-cell-editor')).not.toBeInTheDocument();
		expect(screen.getByTestId('sqlite-edit-status')).toHaveTextContent(
			'payload is a generated column: SQLite calculates its value from other columns.'
		);
		expect(screen.queryByTestId('sqlite-row-detail-modal')).not.toBeInTheDocument();
	});

	it("keeps the editor open with SQLite's words when the save is refused", async () => {
		updateCell.mockRejectedValueOnce(
			new Error(
				"Error invoking remote method 'sqlite:updateCell': Error: CHECK constraint failed: kind_known"
			)
		);
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'kind'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		fireEvent.change(editor, { target: { value: 'bogus' } });
		fireEvent.keyDown(editor, { key: 'Enter' });
		expect(await screen.findByTestId('sqlite-edit-status')).toHaveTextContent(
			'CHECK constraint failed: kind_known'
		);
		expect(screen.getByTestId('sqlite-cell-editor')).toHaveValue('bogus');
	});

	it('binds by the column affinity, so a TEXT column keeps 007 as typed', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'kind'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		expect(editor).toHaveAttribute(
			'title',
			'kind (TEXT, TEXT affinity): everything is stored as text, numbers included.'
		);
		fireEvent.change(editor, { target: { value: '007' } });
		fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() => expect(updateCell).toHaveBeenCalledTimes(1));
		expect(updateCell).toHaveBeenLastCalledWith(
			expect.objectContaining({ column: 'kind', value: { type: 'text', text: '007' } })
		);
	});

	it('reports text that is not a number in an INTEGER column, writing nothing', async () => {
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'id'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		expect(editor).toHaveAttribute(
			'title',
			'id (INTEGER, INTEGER affinity): a number is stored as a number; text that is not one is refused.'
		);
		fireEvent.change(editor, { target: { value: 'twenty' } });
		fireEvent.keyDown(editor, { key: 'Enter' });
		expect(await screen.findByTestId('sqlite-edit-status')).toHaveTextContent(
			"id has INTEGER affinity, and 'twenty' is not a number, so SQLite would keep it as TEXT. Enter a number, or set NULL."
		);
		// The editor stays open with the draft, so the value can be fixed.
		expect(screen.getByTestId('sqlite-cell-editor')).toHaveValue('twenty');
		expect(updateCell).not.toHaveBeenCalled();

		// An emptied box in a numeric column is refused too: NULL is the button.
		fireEvent.change(editor, { target: { value: '' } });
		fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() =>
			expect(screen.getByTestId('sqlite-edit-status')).toHaveTextContent(
				'an empty string is not a number'
			)
		);
		expect(updateCell).not.toHaveBeenCalled();
	});

	it('announces where the backup went on the first change', async () => {
		updateCell.mockImplementationOnce(async () => ({
			name: 'events',
			column: 'kind',
			columns: eventsPage({ handle: 'h1', name: 'events', offset: 0, limit: 2 }).columns,
			row: [2, 'view', null],
			key: { kind: 'primary-key', values: { id: { type: 'integer', text: '2' } } },
			backup: { path: '/data/app.maestro-backup-20261119.db', bytes: 8192, createdAt: 1 },
			elapsedMs: 4,
		}));
		await renderEditing();
		fireEvent.doubleClick(cell(1, 'kind'));
		const editor = await screen.findByTestId('sqlite-cell-editor');
		fireEvent.change(editor, { target: { value: 'view' } });
		fireEvent.keyDown(editor, { key: 'Enter' });
		await waitFor(() =>
			expect(notifyToastMock).toHaveBeenCalledWith({
				color: 'green',
				title: 'Database backed up before the first change',
				message: '8.0 KB copy saved to /data/app.maestro-backup-20261119.db',
			})
		);
	});

	it('opens the record view from the row number while editing, and from the row when locked', async () => {
		await renderEditing();
		fireEvent.doubleClick(screen.getByTestId('sqlite-row-1'));
		expect(await screen.findByTestId('sqlite-row-detail-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-cell-editor')).not.toBeInTheDocument();
	});

	it('does not edit while the tab is read-only, and Lock closes an open editor', async () => {
		render(
			<LayerStackProvider>
				<SqliteViewer filePath="/data/app.db" fileName="app.db" theme={mockTheme} />
			</LayerStackProvider>
		);
		await screen.findByTestId('sqlite-row-1');
		fireEvent.doubleClick(cell(1, 'kind'));
		expect(screen.queryByTestId('sqlite-cell-editor')).not.toBeInTheDocument();
		// Read-only: the double-click reaches the row, which opens the record view.
		expect(await screen.findByTestId('sqlite-row-detail-modal')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('sqlite-editing-enable'));
		await screen.findByTestId('sqlite-rows-editability');
		fireEvent.doubleClick(cell(1, 'kind'));
		await screen.findByTestId('sqlite-cell-editor');
		fireEvent.click(screen.getByTestId('sqlite-editing-disable'));
		await waitFor(() => expect(screen.queryByTestId('sqlite-cell-editor')).not.toBeInTheDocument());
		expect(updateCell).not.toHaveBeenCalled();
	});
});
