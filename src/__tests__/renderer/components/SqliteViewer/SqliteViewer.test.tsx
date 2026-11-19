import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { SqliteViewer } from '../../../../renderer/components/SqliteViewer';
import { sqliteMeasurementOrder } from '../../../../shared/sqlite/objects';
import type {
	SqliteDatabaseInfo,
	SqliteObjectList,
	SqliteObjectSchema,
	SqliteObjectStats,
	SqliteObjectSummary,
} from '../../../../shared/sqlite/types';
import { mockTheme } from '../../../helpers/mockTheme';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

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
	(window as unknown as { maestro: unknown }).maestro = {
		sqlite: { open, listObjects, readObjectStats, readSchema, close },
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
