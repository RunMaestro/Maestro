/**
 * @vitest-environment node
 *
 * Migration v22 against a real SQLite engine: the telemetry columns of
 * `proxy_requests` (the mode a request was carried as, what compress mode did
 * with each block, how each provider count got its number).
 *
 * What is pinned here is the one thing the migration is for: a row written
 * before v22 stays UNKNOWN in every new column. Nothing is backfilled, nothing
 * defaults, and `effective_mode` is not read off `mode` (a stored `compress` is
 * `compress` or `compress-early`) or off the agent's setting today. Around that:
 * every old value survives, a second run changes nothing, a version number that
 * already covers v22 still gets the columns, and a failure part way leaves the
 * table as it was.
 *
 * The old table is built from the definition v21 shipped, written out below. It
 * must not be imported from schema.ts: that constant is the CURRENT shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	getCurrentVersion,
	getMigrationHistory,
	getTargetVersion,
	runMigrations,
} from '../../../main/stats/migrations';
import { ADD_PROXY_REQUEST_TELEMETRY_COLUMNS } from '../../../main/stats/schema';
import {
	clearProxyRequestsCache,
	getProxyRequestUsage,
	recordProxyRequest,
} from '../../../main/stats/proxy-requests';
import { logger } from '../../../main/utils/logger';
import {
	isCompressingTokenProxyMode,
	TOKEN_PROXY_MODES,
} from '../../../shared/local-models/token-proxy';
import { PROXY_PROVIDER_USAGE_CLASSES, STATS_DB_VERSION } from '../../../shared/stats-types';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';
import {
	CONSISTENT_BLOCK_COUNTS,
	currentProxyRow,
	legacyProxyRow,
	type ProxyRow,
} from '../../helpers/proxyTelemetryFixtures';

/** `proxy_requests` exactly as migration v21 left it, before v22. */
const V21_PROXY_REQUESTS_SQL = `
  CREATE TABLE proxy_requests (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    route TEXT NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('passthrough', 'compress')),
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    request_bytes INTEGER NOT NULL,
    sent_bytes INTEGER NOT NULL,
    response_bytes INTEGER NOT NULL,
    original_tokens INTEGER,
    sent_tokens INTEGER,
    added_latency_ms INTEGER,
    blocks_compressed INTEGER NOT NULL DEFAULT 0,
    cache_hits INTEGER NOT NULL DEFAULT 0,
    compressor_counts TEXT,
    new_blocks TEXT,
    skip_reason TEXT,
    routed_to TEXT,
    provider_input_tokens INTEGER,
    provider_cache_read_tokens INTEGER,
    provider_cache_write_tokens INTEGER,
    provider_output_tokens INTEGER
  )
`;

const V21_PROXY_REQUESTS_INDEXES_SQL = [
	'CREATE INDEX idx_proxy_requests_started ON proxy_requests(started_at)',
	'CREATE INDEX idx_proxy_requests_agent ON proxy_requests(agent_id, started_at)',
];

interface OldRow {
	id: string;
	agent_id: string | null;
	route: string;
	kind: string;
	mode: 'passthrough' | 'compress';
	started_at: number;
	duration_ms: number;
	status: number;
	outcome: string;
	request_bytes: number;
	sent_bytes: number;
	response_bytes: number;
	original_tokens: number | null;
	sent_tokens: number | null;
	added_latency_ms: number | null;
	blocks_compressed: number;
	cache_hits: number;
	compressor_counts: string | null;
	new_blocks: string | null;
	skip_reason: string | null;
	routed_to: string | null;
	provider_input_tokens: number | null;
	provider_cache_read_tokens: number | null;
	provider_cache_write_tokens: number | null;
	provider_output_tokens: number | null;
}

/** The v21 columns, in table order. */
const V21_COLUMNS = [
	'id',
	'agent_id',
	'route',
	'kind',
	'mode',
	'started_at',
	'duration_ms',
	'status',
	'outcome',
	'request_bytes',
	'sent_bytes',
	'response_bytes',
	'original_tokens',
	'sent_tokens',
	'added_latency_ms',
	'blocks_compressed',
	'cache_hits',
	'compressor_counts',
	'new_blocks',
	'skip_reason',
	'routed_to',
	'provider_input_tokens',
	'provider_cache_read_tokens',
	'provider_cache_write_tokens',
	'provider_output_tokens',
] as const satisfies readonly (keyof OldRow)[];

const TELEMETRY_NAMES: string[] = ADD_PROXY_REQUEST_TELEMETRY_COLUMNS.map(({ name }) => name);

function oldRow(overrides: Partial<OldRow> & Pick<OldRow, 'id'>): OldRow {
	return {
		agent_id: 'agent-alpha-0001',
		route: 'anthropic',
		kind: 'anthropic-messages',
		mode: 'passthrough',
		started_at: 1_790_000_000_000,
		duration_ms: 900,
		status: 200,
		outcome: 'completed',
		request_bytes: 40_000,
		sent_bytes: 40_000,
		response_bytes: 1_500,
		original_tokens: null,
		sent_tokens: null,
		added_latency_ms: null,
		blocks_compressed: 0,
		cache_hits: 0,
		compressor_counts: null,
		new_blocks: null,
		skip_reason: null,
		routed_to: null,
		provider_input_tokens: null,
		provider_cache_read_tokens: null,
		provider_cache_write_tokens: null,
		provider_output_tokens: null,
		...overrides,
	};
}

/**
 * Rows a v21 install can hold. Both stored modes (a `compress` row may have been
 * `compress` or `compress-early`: the row cannot say), an answer that named no
 * usage, a body forwarded unread, a routed request, every nullable column both set
 * and NULL, zeros that must not read as NULL, and an id, an agent and a timestamp
 * that punish a copy built by string splicing.
 */
const OLD_ROWS: OldRow[] = [
	oldRow({
		id: 'old-passthrough',
		provider_input_tokens: 4_000,
		provider_cache_read_tokens: 120_000,
		provider_cache_write_tokens: 0,
		provider_output_tokens: 600,
	}),
	oldRow({
		id: 'old-compress',
		mode: 'compress',
		sent_bytes: 30_000,
		original_tokens: 10_000,
		sent_tokens: 7_500,
		added_latency_ms: 12,
		blocks_compressed: 3,
		cache_hits: 2,
		compressor_counts: '{"logs":2,"json":1}',
		new_blocks: `[{"hash":"${'a'.repeat(64)}","originalTokens":2400,"compressedTokens":300,"compressors":["logs"]}]`,
		provider_input_tokens: 4_000,
		provider_cache_read_tokens: 120_000,
		provider_cache_write_tokens: 0,
		provider_output_tokens: 600,
	}),
	oldRow({
		id: 'old-compress-no-usage',
		mode: 'compress',
		original_tokens: 8_000,
		sent_tokens: 8_000,
		added_latency_ms: 4,
	}),
	oldRow({ id: 'old-skipped', mode: 'compress', skip_reason: 'too-large' }),
	oldRow({ id: 'old-routed', routed_to: 'maestro-server:qwen3.5-4b' }),
	oldRow({
		id: 'old-zeros',
		mode: 'compress',
		original_tokens: 0,
		sent_tokens: 0,
		added_latency_ms: 0,
		provider_input_tokens: 0,
		provider_cache_read_tokens: 0,
		provider_cache_write_tokens: 0,
		provider_output_tokens: 0,
	}),
	oldRow({
		id: 'old-\'quoted"-id',
		agent_id: null,
		started_at: 9_007_199_254_740_000,
		duration_ms: 86_400_000,
		request_bytes: 2_147_483_648,
	}),
];

function openDb(): Database.Database {
	const Shim = nodeSqliteBetterSqlite3Mock().default;
	return new Shim(':memory:') as unknown as Database.Database;
}

function columnNames(db: Database.Database, table: string): string[] {
	return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

/** Every column of a table as SQLite describes it: name, type, nullability, default, key. */
function tableInfo(db: Database.Database, table: string): Array<Record<string, unknown>> {
	return (db.pragma(`table_info(${table})`) as Array<Record<string, unknown>>).map((row) => ({
		...row,
	}));
}

function hasTable(db: Database.Database, table: string): boolean {
	return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

/** The indexes a migration created. SQLite's own primary-key index has no SQL and is left out. */
function indexNames(db: Database.Database, table: string): string[] {
	return (
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name"
			)
			.all(table) as Array<{ name: string }>
	).map((row) => row.name);
}

function tableSql(db: Database.Database, table: string): string {
	return (
		db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table) as {
			sql: string;
		}
	).sql;
}

function plainRows(rows: unknown[]): Array<Record<string, unknown>> {
	return rows.map((row) => ({ ...(row as object) }));
}

/** Every old column of every row, as plain objects in a fixed order. */
function oldRows(db: Database.Database): Array<Record<string, unknown>> {
	return plainRows(
		db.prepare(`SELECT ${V21_COLUMNS.join(', ')} FROM proxy_requests ORDER BY id`).all()
	);
}

/** The id and every new column of every row. */
function telemetryRows(db: Database.Database): Array<Record<string, unknown>> {
	return plainRows(
		db.prepare(`SELECT id, ${TELEMETRY_NAMES.join(', ')} FROM proxy_requests ORDER BY id`).all()
	);
}

function insertOldRow(db: Database.Database, row: OldRow): void {
	db.prepare(
		`INSERT INTO proxy_requests (${V21_COLUMNS.join(', ')})
		 VALUES (${V21_COLUMNS.map(() => '?').join(', ')})`
	).run(...V21_COLUMNS.map((column) => row[column]));
}

/**
 * A database as a v21 build left it, holding {@link OLD_ROWS}: migrate fully,
 * then put `proxy_requests` back the way v21 left it and stamp 21.
 */
function seededV21Db(): Database.Database {
	const db = openDb();
	runMigrations(db);

	db.prepare('DROP TABLE proxy_requests').run();
	db.prepare(V21_PROXY_REQUESTS_SQL).run();
	for (const sql of V21_PROXY_REQUESTS_INDEXES_SQL) db.prepare(sql).run();
	db.prepare('DELETE FROM _migrations WHERE version = 22').run();
	db.pragma('user_version = 21');
	for (const row of OLD_ROWS) insertOldRow(db, row);

	vi.mocked(logger.warn).mockClear();
	vi.mocked(logger.error).mockClear();
	return db;
}

/** The same database object, failing the one statement whose SQL matches. */
function failingOn(db: Database.Database, pattern: RegExp, message: string): Database.Database {
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property !== 'prepare') return Reflect.get(target, property, receiver);
			return (sql: string) => {
				if (pattern.test(sql)) throw new Error(message);
				return target.prepare(sql);
			};
		},
	});
}

const snake = (word: string): string =>
	word.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * A row's telemetry, as the columns that hold it. The writer that fills them is
 * a later task; this is the reference these tests store with, spelled out.
 */
function telemetryColumnValues(row: ProxyRow): Record<string, string | number | null> {
	const counts = row.blockCounts;
	const reportedness = row.providerUsageReportedness;
	return {
		effective_mode: row.effectiveMode ?? null,
		blocks_protected: counts?.protected ?? null,
		blocks_vetoed_failed: counts?.vetoed.failed ?? null,
		blocks_vetoed_recovery: counts?.vetoed.recovery ?? null,
		blocks_vetoed_retrieval: counts?.vetoed.retrieval ?? null,
		blocks_candidates: counts?.candidates ?? null,
		blocks_below_threshold: counts?.belowThreshold ?? null,
		blocks_kept: counts?.kept ?? null,
		blocks_store_failed: counts?.storeFailed ?? null,
		blocks_model_failed: counts?.modelFailed ?? null,
		provider_input_reportedness: reportedness?.input ?? null,
		provider_cache_read_reportedness: reportedness?.cacheRead ?? null,
		provider_cache_write_reportedness: reportedness?.cacheWrite ?? null,
		provider_output_reportedness: reportedness?.output ?? null,
	};
}

/** Store one row whole, new columns included, by name. */
function insertFullRow(db: Database.Database, id: string, row: ProxyRow): void {
	const values: Record<string, string | number | null> = {
		id,
		agent_id: row.agentId ?? null,
		route: row.route,
		kind: row.kind,
		mode: row.mode,
		started_at: row.startedAt,
		duration_ms: row.durationMs,
		status: row.status,
		outcome: row.outcome,
		request_bytes: row.requestBytes,
		sent_bytes: row.sentBytes,
		response_bytes: row.responseBytes,
		blocks_compressed: row.blocksCompressed,
		cache_hits: row.cacheHits,
		...telemetryColumnValues(row),
	};
	const columns = Object.keys(values);
	db.prepare(
		`INSERT INTO proxy_requests (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
	).run(...Object.values(values));
}

describe.skipIf(!canLoadNodeSqlite())('stats migration v22', () => {
	beforeEach(() => {
		clearProxyRequestsCache();
		vi.mocked(logger.warn).mockClear();
		vi.mocked(logger.error).mockClear();
	});

	it('is the target version', () => {
		expect(getTargetVersion()).toBe(22);
		expect(STATS_DB_VERSION).toBe(22);
	});

	describe('the seeded fixture', () => {
		it('really is the v21 shape: no telemetry column, the mode CHECK, and rows to carry', () => {
			const db = seededV21Db();

			expect(getCurrentVersion(db)).toBe(21);
			expect(columnNames(db, 'proxy_requests')).toEqual([...V21_COLUMNS]);
			expect(oldRows(db)).toHaveLength(OLD_ROWS.length);
			expect(() => insertOldRow(db, oldRow({ id: 'x', mode: 'compress-early' as never }))).toThrow(
				/CHECK constraint/
			);
		});
	});

	describe('upgrading a version 21 database', () => {
		it('brings the database to version 22 as an ordinary upgrade', () => {
			const db = seededV21Db();

			runMigrations(db);

			expect(getCurrentVersion(db)).toBe(22);
			expect(getMigrationHistory(db).find((m) => m.version === 22)).toMatchObject({
				status: 'success',
			});
			// A repair would warn; this is the normal path.
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('adds the fourteen columns after the old ones, in the order a fresh table lists them', () => {
			const db = seededV21Db();

			runMigrations(db);

			expect(TELEMETRY_NAMES).toHaveLength(14);
			expect(columnNames(db, 'proxy_requests')).toEqual([...V21_COLUMNS, ...TELEMETRY_NAMES]);
		});

		it('carries every old row over with every old value unchanged', () => {
			const db = seededV21Db();
			const before = oldRows(db);

			runMigrations(db);

			expect(oldRows(db)).toEqual(before);
			// And against what was written, not only against the read before it.
			expect(oldRows(db)).toEqual(
				[...OLD_ROWS].sort((a, b) => (a.id < b.id ? -1 : 1)).map((row) => ({ ...row }))
			);
		});

		it('leaves every new fact unknown in every old row, whichever mode it was stored with', () => {
			const db = seededV21Db();

			runMigrations(db);

			// Both stored modes are in the fixture: a `compress` row may have been
			// `compress-early`, and a `passthrough` row has no counts to infer either.
			expect(new Set(OLD_ROWS.map((row) => row.mode))).toEqual(
				new Set(['passthrough', 'compress'])
			);
			const allNull = Object.fromEntries(TELEMETRY_NAMES.map((name) => [name, null]));
			expect(telemetryRows(db)).toEqual(
				OLD_ROWS.map((row) => ({ id: row.id, ...allNull })).sort((a, b) => (a.id < b.id ? -1 : 1))
			);
			expect(
				db
					.prepare('SELECT COUNT(*) AS n FROM proxy_requests WHERE effective_mode IS NOT NULL')
					.get()
			).toEqual({ n: 0 });
		});

		it('adds the columns bare: nullable, no default, no key, no new CHECK, no new index', () => {
			const db = seededV21Db();
			const indexesBefore = indexNames(db, 'proxy_requests');

			runMigrations(db);

			const added = tableInfo(db, 'proxy_requests').filter((column) =>
				TELEMETRY_NAMES.includes(column.name as string)
			);
			expect(added).toHaveLength(TELEMETRY_NAMES.length);
			for (const column of added) {
				expect(column).toMatchObject({ notnull: 0, dflt_value: null, pk: 0 });
			}
			expect(indexNames(db, 'proxy_requests')).toEqual(indexesBefore);
			expect(indexesBefore).toEqual(['idx_proxy_requests_agent', 'idx_proxy_requests_started']);
			// The one CHECK in the table is still the one on `mode`.
			expect(tableSql(db, 'proxy_requests').match(/CHECK/g)).toHaveLength(1);
		});

		it('keeps the mode CHECK: a compress-early request is stored as compress, with its mode in effective_mode', () => {
			const db = seededV21Db();
			runMigrations(db);

			expect(tableSql(db, 'proxy_requests')).toContain(
				"CHECK(mode IN ('passthrough', 'compress'))"
			);
			expect(() =>
				insertFullRow(db, 'bad', currentProxyRow({ mode: 'compress-early' as never }))
			).toThrow(/CHECK constraint/);

			// The request modes are the proxy's own. Each round-trips through
			// effective_mode, paired with the stored mode the contract gives it.
			const modes = TOKEN_PROXY_MODES.filter((mode) => mode !== 'off');
			expect(modes).toContain('compress-early');
			for (const mode of modes) {
				insertFullRow(
					db,
					`mode-${mode}`,
					currentProxyRow({
						mode: isCompressingTokenProxyMode(mode) ? 'compress' : 'passthrough',
						effectiveMode: mode,
					})
				);
				expect(
					db
						.prepare('SELECT mode, effective_mode FROM proxy_requests WHERE id = ?')
						.get(`mode-${mode}`)
				).toMatchObject({
					mode: isCompressingTokenProxyMode(mode) ? 'compress' : 'passthrough',
					effective_mode: mode,
				});
			}
		});

		it('keeps the primary key and the NOT NULL columns', () => {
			const db = seededV21Db();
			runMigrations(db);

			expect(() => insertOldRow(db, oldRow({ id: 'old-passthrough' }))).toThrow(
				/UNIQUE constraint/
			);
			expect(() =>
				db
					.prepare(
						`INSERT INTO proxy_requests (id, route, kind, mode, started_at, duration_ms, status, outcome,
						   request_bytes, sent_bytes)
						 VALUES ('no-response-bytes', 'anthropic', 'anthropic-messages', 'passthrough', 1, 1, 200, 'completed', 1, 1)`
					)
					.run()
			).toThrow(/NOT NULL constraint/);
		});
	});

	describe('a fresh database', () => {
		it('is created in the v22 shape and needs no repair', () => {
			const db = openDb();

			runMigrations(db);

			expect(getCurrentVersion(db)).toBe(22);
			expect(columnNames(db, 'proxy_requests')).toEqual([...V21_COLUMNS, ...TELEMETRY_NAMES]);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('describes every column exactly as an upgraded database does, and has the same indexes', () => {
			const fresh = openDb();
			runMigrations(fresh);
			const upgraded = seededV21Db();
			runMigrations(upgraded);

			expect(tableInfo(fresh, 'proxy_requests')).toEqual(tableInfo(upgraded, 'proxy_requests'));
			expect(indexNames(fresh, 'proxy_requests')).toEqual(indexNames(upgraded, 'proxy_requests'));
		});

		it('has a column for every fact the ProxyRequest contract adds, and no other', () => {
			// Named from the contract (the fixture's counts and the provider classes), not from the schema.
			const { vetoed, ...own } = CONSISTENT_BLOCK_COUNTS;
			const counts = [
				...Object.keys(own).map((key) => `blocks_${snake(key)}`),
				...Object.keys(vetoed).map((key) => `blocks_vetoed_${snake(key)}`),
			];
			const reportedness = PROXY_PROVIDER_USAGE_CLASSES.map(
				(usageClass) => `provider_${snake(usageClass)}_reportedness`
			);

			expect([...TELEMETRY_NAMES].sort()).toEqual(
				['effective_mode', ...counts, ...reportedness].sort()
			);
			const types = Object.fromEntries(
				ADD_PROXY_REQUEST_TELEMETRY_COLUMNS.map(({ name, type }) => [name, type])
			);
			for (const column of counts) expect(types[column]).toBe('INTEGER');
			for (const column of ['effective_mode', ...reportedness]) expect(types[column]).toBe('TEXT');
		});
	});

	describe('running it again', () => {
		it('changes nothing on a second run', () => {
			const db = seededV21Db();
			runMigrations(db);
			const rows = telemetryRows(db);
			const oldOnce = oldRows(db);
			const sqlOnce = tableSql(db, 'proxy_requests');
			const history = getMigrationHistory(db);

			runMigrations(db);

			expect(telemetryRows(db)).toEqual(rows);
			expect(oldRows(db)).toEqual(oldOnce);
			expect(tableSql(db, 'proxy_requests')).toBe(sqlOnce);
			expect(getCurrentVersion(db)).toBe(22);
			expect(getMigrationHistory(db)).toEqual(history);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('adds nothing and fails nothing when the body runs against a table that has the columns', () => {
			const db = seededV21Db();
			runMigrations(db);
			insertFullRow(db, 'new-current', currentProxyRow());
			const rows = telemetryRows(db);
			const sqlOnce = tableSql(db, 'proxy_requests');

			// Stamp the version back so the runner applies v22 again, not just checks it.
			db.prepare('DELETE FROM _migrations WHERE version = 22').run();
			db.pragma('user_version = 21');
			runMigrations(db);

			expect(telemetryRows(db)).toEqual(rows);
			expect(tableSql(db, 'proxy_requests')).toBe(sqlOnce);
			expect(getCurrentVersion(db)).toBe(22);
			expect(getMigrationHistory(db).find((m) => m.version === 22)).toMatchObject({
				status: 'success',
			});
		});

		it('takes only the missing columns from a table that already has some, keeping their values', () => {
			const db = seededV21Db();
			// What another build, or a hand repair, may have left behind.
			db.prepare('ALTER TABLE proxy_requests ADD COLUMN effective_mode TEXT').run();
			db.prepare('ALTER TABLE proxy_requests ADD COLUMN blocks_kept INTEGER').run();
			db.prepare(
				"UPDATE proxy_requests SET effective_mode = 'compress', blocks_kept = 7 WHERE id = 'old-compress'"
			).run();

			runMigrations(db);

			expect([...columnNames(db, 'proxy_requests')].sort()).toEqual(
				[...V21_COLUMNS, ...TELEMETRY_NAMES].sort()
			);
			const row = telemetryRows(db).find((r) => r.id === 'old-compress');
			expect(row).toMatchObject({ effective_mode: 'compress', blocks_kept: 7 });
			expect(row?.blocks_candidates).toBeNull();
			expect(oldRows(db)).toHaveLength(OLD_ROWS.length);
		});
	});

	describe('a version number that already covers v22', () => {
		it('adds the columns to a database stamped 22 without them, keeping its rows', () => {
			// v22 declares isApplied for the same reason v15 does: rc may number a
			// different migration 22, and user_version is only a number.
			const db = seededV21Db();
			const before = oldRows(db);
			db.pragma('user_version = 22');

			runMigrations(db);

			expect(columnNames(db, 'proxy_requests')).toEqual([...V21_COLUMNS, ...TELEMETRY_NAMES]);
			expect(oldRows(db)).toEqual(before);
			expect(
				telemetryRows(db).every((row) => TELEMETRY_NAMES.every((name) => row[name] === null))
			).toBe(true);
			expect(getCurrentVersion(db)).toBe(22);
			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v22');
		});

		it('adds only what is missing to a database stamped 22 that lacks some of the columns', () => {
			const db = openDb();
			runMigrations(db);
			insertFullRow(db, 'new-current', currentProxyRow());
			db.prepare('ALTER TABLE proxy_requests DROP COLUMN blocks_model_failed').run();
			db.prepare('ALTER TABLE proxy_requests DROP COLUMN provider_output_reportedness').run();
			vi.mocked(logger.warn).mockClear();

			runMigrations(db);

			expect([...columnNames(db, 'proxy_requests')].sort()).toEqual(
				[...V21_COLUMNS, ...TELEMETRY_NAMES].sort()
			);
			// The columns it still had keep what the row stored; the ones it lost read unknown.
			expect(telemetryRows(db)[0]).toMatchObject({
				effective_mode: 'compress-early',
				blocks_kept: CONSISTENT_BLOCK_COUNTS.kept,
				provider_input_reportedness: 'reported',
				blocks_model_failed: null,
				provider_output_reportedness: null,
			});
			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v22');
		});

		it('leaves a complete database stamped 22 alone', () => {
			const db = openDb();
			runMigrations(db);
			insertFullRow(db, 'new-current', currentProxyRow());
			const rows = telemetryRows(db);

			runMigrations(db);

			expect(telemetryRows(db)).toEqual(rows);
			expect(getCurrentVersion(db)).toBe(22);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('repairs v21 and v22 together, v21 first, for a database stamped 22 without either', () => {
			const db = openDb();
			runMigrations(db);
			for (const column of [
				'provider_input_tokens',
				'provider_cache_read_tokens',
				'provider_cache_write_tokens',
				'provider_output_tokens',
				...TELEMETRY_NAMES,
			]) {
				db.prepare(`ALTER TABLE proxy_requests DROP COLUMN ${column}`).run();
			}
			vi.mocked(logger.warn).mockClear();

			runMigrations(db);

			expect(columnNames(db, 'proxy_requests')).toEqual([...V21_COLUMNS, ...TELEMETRY_NAMES]);
			expect(vi.mocked(logger.warn).mock.calls.map(([message]) => String(message))).toEqual([
				expect.stringContaining('v21'),
				expect.stringContaining('v22'),
			]);
		});

		it('recreates the table whole, through v16, for a database stamped 22 without it', () => {
			const db = openDb();
			runMigrations(db);
			db.prepare('DROP TABLE proxy_requests').run();
			vi.mocked(logger.warn).mockClear();

			runMigrations(db);

			// v16 creates the table with every column it has today, so v17, v21 and v22
			// find nothing to add.
			expect(hasTable(db, 'proxy_requests')).toBe(true);
			expect(columnNames(db, 'proxy_requests')).toEqual([...V21_COLUMNS, ...TELEMETRY_NAMES]);
			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v16');
		});
	});

	describe('a failure part way through', () => {
		it('leaves the table, every row and the version exactly as they were', () => {
			const db = seededV21Db();
			const before = oldRows(db);
			const sqlBefore = tableSql(db, 'proxy_requests');
			// Five columns have been added when this statement runs.
			const failing = failingOn(db, /ADD COLUMN blocks_candidates /, 'disk I/O error');

			expect(() => runMigrations(failing)).toThrow('disk I/O error');

			expect(oldRows(db)).toEqual(before);
			expect(tableSql(db, 'proxy_requests')).toBe(sqlBefore);
			expect(columnNames(db, 'proxy_requests')).toEqual([...V21_COLUMNS]);
			expect(indexNames(db, 'proxy_requests')).toEqual([
				'idx_proxy_requests_agent',
				'idx_proxy_requests_started',
			]);
			expect(getCurrentVersion(db)).toBe(21);
			expect(getMigrationHistory(db).find((m) => m.version === 22)).toMatchObject({
				status: 'failed',
				errorMessage: 'disk I/O error',
			});
		});

		it('succeeds on the next start with nothing lost', () => {
			const db = seededV21Db();
			const before = oldRows(db);
			expect(() =>
				runMigrations(failingOn(db, /ADD COLUMN blocks_candidates /, 'disk I/O error'))
			).toThrow();

			runMigrations(db);

			expect(oldRows(db)).toEqual(before);
			expect(columnNames(db, 'proxy_requests')).toEqual([...V21_COLUMNS, ...TELEMETRY_NAMES]);
			expect(getCurrentVersion(db)).toBe(22);
			expect(getMigrationHistory(db).find((m) => m.version === 22)).toMatchObject({
				status: 'success',
			});
		});
	});

	describe('storing and reading the new facts', () => {
		it('stores a current row whole and reads it back', () => {
			const db = seededV21Db();
			runMigrations(db);
			const row = currentProxyRow();

			insertFullRow(db, 'new-current', row);

			expect(telemetryRows(db).find((r) => r.id === 'new-current')).toEqual({
				id: 'new-current',
				effective_mode: 'compress-early',
				blocks_protected: 0,
				blocks_vetoed_failed: 1,
				blocks_vetoed_recovery: 0,
				blocks_vetoed_retrieval: 2,
				blocks_candidates: 9,
				blocks_below_threshold: 3,
				blocks_kept: 2,
				blocks_store_failed: 1,
				blocks_model_failed: 1,
				provider_input_reportedness: 'reported',
				provider_cache_read_reportedness: 'reported',
				provider_cache_write_reportedness: 'reported',
				provider_output_reportedness: 'reported',
			});
		});

		it('keeps a counted zero apart from an unknown, so a query can tell them apart', () => {
			const db = seededV21Db();
			runMigrations(db);
			// compress-early lifts the protection rules, so it counts 0 protected blocks.
			insertFullRow(db, 'new-early', currentProxyRow());
			insertFullRow(
				db,
				'new-delayed',
				currentProxyRow({
					effectiveMode: 'compress',
					blockCounts: {
						...CONSISTENT_BLOCK_COUNTS,
						protected: 4,
						vetoed: { ...CONSISTENT_BLOCK_COUNTS.vetoed },
					},
				})
			);

			const coverage = db
				.prepare(
					`SELECT COUNT(*) AS requests,
					        COUNT(blocks_candidates) AS counted,
					        SUM(blocks_protected) AS protected,
					        SUM(blocks_kept) AS kept
					 FROM proxy_requests`
				)
				.get();
			expect({ ...(coverage as object) }).toEqual({
				requests: OLD_ROWS.length + 2,
				counted: 2,
				protected: 4,
				kept: 2 * CONSISTENT_BLOCK_COUNTS.kept,
			});
			// The zero is a count, not a gap: only the rows nothing was counted for are NULL.
			expect(
				db.prepare("SELECT blocks_protected FROM proxy_requests WHERE id = 'new-early'").get()
			).toEqual({ blocks_protected: 0 });
			// Summed over rows that hold no count, SQL gives NULL, which is not 0.
			expect(
				db
					.prepare("SELECT SUM(blocks_kept) AS kept FROM proxy_requests WHERE id LIKE 'old-%'")
					.get()
			).toEqual({ kept: null });
		});

		it('stores each class of provider usage with its own reportedness', () => {
			const db = seededV21Db();
			runMigrations(db);

			insertFullRow(
				db,
				'new-partial',
				currentProxyRow({
					providerUsageReportedness: {
						input: 'unreported',
						cacheRead: 'derived',
						cacheWrite: 'not-applicable',
						output: 'reported',
					},
				})
			);

			expect(
				db
					.prepare(
						`SELECT provider_input_reportedness AS input, provider_cache_read_reportedness AS cacheRead,
						        provider_cache_write_reportedness AS cacheWrite, provider_output_reportedness AS output
						 FROM proxy_requests WHERE id = 'new-partial'`
					)
					.get()
			).toEqual({
				input: 'unreported',
				cacheRead: 'derived',
				cacheWrite: 'not-applicable',
				output: 'reported',
			});
		});

		it('still takes a row from the writer that predates v22, and stores it as unknown', () => {
			const db = seededV21Db();
			runMigrations(db);

			// A request that carries none of the new facts has none to store.
			const id = recordProxyRequest(db, legacyProxyRow());

			expect(telemetryRows(db).find((r) => r.id === id)).toEqual({
				id,
				...Object.fromEntries(TELEMETRY_NAMES.map((name) => [name, null])),
			});
			expect(getProxyRequestUsage(db, 'all').totals.requests).toBe(OLD_ROWS.length + 1);
		});
	});
});
