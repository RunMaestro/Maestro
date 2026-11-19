import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import {
	SqliteViewer,
	type SqliteViewerHandle,
} from '../../../../renderer/components/SqliteViewer';
import { AUTO_COUNT_PASSES } from '../../../../renderer/components/SqliteViewer/SqliteTableView';
import { sqliteMeasurementOrder } from '../../../../shared/sqlite/objects';
import type {
	SqliteCountRequest,
	SqliteDatabaseInfo,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
	SqliteObjectSummary,
	SqliteRowCount,
	SqliteRowsPage,
	SqliteRowsRequest,
} from '../../../../shared/sqlite/types';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

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
let readRows: ReturnType<typeof vi.fn>;
let countRows: ReturnType<typeof vi.fn>;

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
		offset: request.offset,
		hasMore: request.offset + count < total,
		orderedBy: request.sort ? [request.sort.column, 'id'] : ['id'],
		elapsedMs: 3,
		filtered: Boolean(request.filter),
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
	readRows = vi.fn(async (request: SqliteRowsRequest) => eventsPage(request));
	// The count never answers unless a test says so: a settled count would
	// replace the rail's capped counts that other tests assert on.
	countRows = vi.fn(() => new Promise<SqliteRowCount>(() => {}));
	(window as unknown as { maestro: unknown }).maestro = {
		sqlite: { open, listObjects, readObjectStats, readSchema, readRows, countRows, close },
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
		const second = screen.getByTestId('sqlite-row-1');
		expect(second).toHaveTextContent('click');
		expect(second).toHaveTextContent('BLOB 2.0 KB');
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
