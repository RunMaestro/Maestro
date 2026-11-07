/**
 * @vitest-environment node
 *
 * Migration v20 against a real SQLite engine: the `local_model_runs` rebuild
 * and the three model columns on `query_events`.
 *
 * SQLite cannot alter a CHECK constraint, so v20 builds the table again beside
 * the old one, copies every row, drops the old one and renames the new one
 * into place. That is the one migration in this file's history that DROPS a
 * table holding the user's data, so what is pinned here is not the happy path
 * alone: every row and every value survives, the copy is undone as a whole
 * when any step after it fails, a second run changes nothing, and a database
 * another branch stamped past v20 still gets the schema with its rows intact.
 *
 * The old table is built from the definition v15 shipped, written out below.
 * It must not be imported from schema.ts: that constant is the CURRENT shape.
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
import {
	ADD_QUERY_EVENT_MODEL_COLUMNS,
	LOCAL_MODEL_RUNS_REBUILD_TABLE,
} from '../../../main/stats/schema';
import { INSERT_QUERY_EVENT_SQL, bindQueryEvent } from '../../../main/stats/query-event-insert';
import { mapQueryEventRow, type QueryEventRow } from '../../../main/stats/row-mappers';
import {
	clearLocalModelRunsCache,
	getLocalModelRuns,
	recordLocalModelRun,
} from '../../../main/stats/local-model-runs';
import { logger } from '../../../main/utils/logger';
import { LOCAL_MODEL_RUN_SOURCE_TYPES, STATS_DB_VERSION } from '../../../shared/stats-types';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

/** `local_model_runs` exactly as migration v15 created it, before v20. */
const V15_LOCAL_MODEL_RUNS_SQL = `
  CREATE TABLE local_model_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('local', 'endpoint')),
    model_id TEXT NOT NULL,
    endpoint_id TEXT,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'error', 'cancelled')),
    error_code TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER
  )
`;

const V15_LOCAL_MODEL_RUNS_INDEXES_SQL = [
	'CREATE INDEX idx_local_model_runs_started ON local_model_runs(started_at)',
	'CREATE INDEX idx_local_model_runs_task ON local_model_runs(task_id, started_at)',
];

interface OldRun {
	id: string;
	task_id: string;
	source_type: 'local' | 'endpoint';
	model_id: string;
	endpoint_id: string | null;
	started_at: number;
	duration_ms: number;
	outcome: 'ok' | 'error' | 'cancelled';
	error_code: string | null;
	tokens_in: number | null;
	tokens_out: number | null;
}

/**
 * Rows a v19 install can hold: both sources, all three outcomes, every nullable
 * column both set and NULL, a zero that must not read as NULL, a timestamp past
 * 32 bits, and ids and names that punish a copy built by string splicing.
 */
const OLD_RUNS: OldRun[] = [
	{
		id: 'run-local-ok',
		task_id: 'tab-naming',
		source_type: 'local',
		model_id: 'qwen3-1.7b-instruct-q4km',
		endpoint_id: null,
		started_at: 1_790_000_000_001,
		duration_ms: 412,
		outcome: 'ok',
		error_code: null,
		tokens_in: 96,
		tokens_out: 7,
	},
	{
		id: 'run-endpoint-ok',
		task_id: 'git-drafts',
		source_type: 'endpoint',
		model_id: 'llama3.2:latest',
		endpoint_id: 'ep-ollama',
		started_at: 1_790_000_000_002,
		duration_ms: 1830,
		outcome: 'ok',
		error_code: null,
		tokens_in: 2048,
		tokens_out: 311,
	},
	{
		id: 'run-local-missing',
		task_id: 'cue-gate',
		source_type: 'local',
		model_id: 'qwen3.5-4b',
		endpoint_id: null,
		started_at: 1_790_000_000_003,
		duration_ms: 3,
		outcome: 'error',
		error_code: 'model-not-installed',
		tokens_in: null,
		tokens_out: null,
	},
	{
		id: 'run-endpoint-down',
		task_id: 'tab-summary',
		source_type: 'endpoint',
		model_id: 'gpt-oss-20b',
		endpoint_id: 'ep-lm-studio',
		started_at: 1_790_000_000_004,
		duration_ms: 30_000,
		outcome: 'error',
		error_code: 'network',
		tokens_in: null,
		tokens_out: null,
	},
	{
		id: 'run-cancelled',
		task_id: 'ai-command',
		source_type: 'local',
		model_id: 'qwen3.5-4b',
		endpoint_id: null,
		started_at: 1_790_000_000_005,
		duration_ms: 220,
		outcome: 'cancelled',
		error_code: 'cancelled',
		tokens_in: null,
		tokens_out: null,
	},
	{
		id: 'run-zero-tokens',
		task_id: 'semantic-search',
		source_type: 'local',
		model_id: 'bge-small-en-v1.5',
		endpoint_id: null,
		started_at: 1_790_000_000_006,
		duration_ms: 0,
		outcome: 'ok',
		error_code: null,
		tokens_in: 0,
		tokens_out: 0,
	},
	{
		id: 'run-\'quoted"-id',
		task_id: 'model-routing',
		source_type: 'endpoint',
		model_id: "模型 with 'quotes', commas; and a ) paren",
		endpoint_id: 'ep-with space',
		started_at: 9_007_199_254_740_000,
		duration_ms: 86_400_000,
		outcome: 'ok',
		error_code: null,
		tokens_in: 2_147_483_648,
		tokens_out: 1,
	},
	{
		// The maestro-server endpoint, filed as an endpoint before `server` existed.
		id: 'run-old-server',
		task_id: 'tab-naming',
		source_type: 'endpoint',
		model_id: 'qwen3.5-4b',
		endpoint_id: 'maestro-server',
		started_at: 1_790_000_000_008,
		duration_ms: 95,
		outcome: 'ok',
		error_code: null,
		tokens_in: 80,
		tokens_out: 5,
	},
];

function openDb(): Database.Database {
	const Shim = nodeSqliteBetterSqlite3Mock().default;
	return new Shim(':memory:') as unknown as Database.Database;
}

function columnNames(db: Database.Database, table: string): string[] {
	return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
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

/** Every run, as plain objects in a fixed order, so two reads compare by value. */
function allRuns(db: Database.Database): Array<Record<string, unknown>> {
	return (
		db.prepare('SELECT * FROM local_model_runs ORDER BY id').all() as Array<Record<string, unknown>>
	).map((row) => ({ ...row }));
}

function insertOldRun(db: Database.Database, run: OldRun): void {
	db.prepare(
		`INSERT INTO local_model_runs
		 (id, task_id, source_type, model_id, endpoint_id, started_at, duration_ms, outcome, error_code, tokens_in, tokens_out)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		run.id,
		run.task_id,
		run.source_type,
		run.model_id,
		run.endpoint_id,
		run.started_at,
		run.duration_ms,
		run.outcome,
		run.error_code,
		run.tokens_in,
		run.tokens_out
	);
}

/** Put `local_model_runs` back the way v15 left it. Takes its rows with it. */
function revertLocalModelRuns(db: Database.Database): void {
	db.prepare('DROP TABLE local_model_runs').run();
	db.prepare(V15_LOCAL_MODEL_RUNS_SQL).run();
	for (const sql of V15_LOCAL_MODEL_RUNS_INDEXES_SQL) db.prepare(sql).run();
}

/**
 * A database as a v19 build left it, holding {@link OLD_RUNS} and two agent
 * turns: migrate fully, then take away exactly what v20 adds and stamp 19.
 */
function seededV19Db(): Database.Database {
	const db = openDb();
	runMigrations(db);

	revertLocalModelRuns(db);
	for (const column of ADD_QUERY_EVENT_MODEL_COLUMNS) {
		db.prepare(`ALTER TABLE query_events DROP COLUMN ${column}`).run();
	}
	db.prepare('DELETE FROM _migrations WHERE version = 20').run();
	db.pragma('user_version = 19');

	for (const run of OLD_RUNS) insertOldRun(db, run);
	db.prepare(
		`INSERT INTO query_events (id, session_id, agent_type, source, start_time, duration, tab_id, input_tokens, cost_usd)
		 VALUES ('q-1', 'agent-1', 'claude-code', 'user', 1790000000000, 5000, 'tab-1', 1200, 0.25),
		        ('q-2', 'agent-2', 'codex', 'auto', 1790000001000, 9000, NULL, NULL, NULL)`
	).run();

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

describe.skipIf(!canLoadNodeSqlite())('stats migration v20', () => {
	beforeEach(() => {
		clearLocalModelRunsCache();
		vi.mocked(logger.warn).mockClear();
		vi.mocked(logger.error).mockClear();
	});

	it('is the target version', () => {
		expect(getTargetVersion()).toBe(20);
		expect(STATS_DB_VERSION).toBe(20);
	});

	describe('the seeded fixture', () => {
		it('really is the old shape: the wider sources are refused before the migration', () => {
			const db = seededV19Db();

			expect(getCurrentVersion(db)).toBe(19);
			expect(columnNames(db, 'local_model_runs')).not.toContain('agent_id');
			expect(columnNames(db, 'query_events')).not.toContain('run_on_endpoint');
			expect(allRuns(db)).toHaveLength(OLD_RUNS.length);
			expect(() =>
				db
					.prepare(
						`INSERT INTO local_model_runs (id, task_id, source_type, model_id, started_at, duration_ms, outcome)
						 VALUES ('x', 'tab-naming', 'server', 'qwen', 1, 1, 'ok')`
					)
					.run()
			).toThrow(/CHECK constraint/);
		});
	});

	describe('rebuilding local_model_runs', () => {
		it('carries every row over with every value unchanged', () => {
			const db = seededV19Db();
			const before = allRuns(db);

			runMigrations(db);

			const after = allRuns(db);
			expect(after).toHaveLength(OLD_RUNS.length);
			// Every old column of every old row, byte for byte, plus the new column as NULL.
			expect(after).toEqual(before.map((row) => ({ ...row, agent_id: null })));
			// And against what was written, not only against the read before it.
			expect(after).toEqual(
				[...OLD_RUNS]
					.sort((a, b) => (a.id < b.id ? -1 : 1))
					.map((run) => ({ ...run, agent_id: null }))
			);
		});

		it('brings the database to version 20 as an ordinary upgrade', () => {
			const db = seededV19Db();

			runMigrations(db);

			expect(getCurrentVersion(db)).toBe(20);
			expect(getMigrationHistory(db).find((m) => m.version === 20)).toMatchObject({
				status: 'success',
			});
			// A repair would warn; this is the normal path.
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('widens the source CHECK to every source type and keeps the outcome CHECK', () => {
			const db = seededV19Db();
			runMigrations(db);

			for (const sourceType of LOCAL_MODEL_RUN_SOURCE_TYPES) {
				db.prepare(
					`INSERT INTO local_model_runs (id, task_id, source_type, model_id, started_at, duration_ms, outcome)
					 VALUES (?, 'tab-naming', ?, 'm', 1, 1, 'ok')`
				).run(`new-${sourceType}`, sourceType);
			}
			expect(allRuns(db)).toHaveLength(OLD_RUNS.length + LOCAL_MODEL_RUN_SOURCE_TYPES.length);

			const insert = (sourceType: string, outcome: string) =>
				db
					.prepare(
						`INSERT INTO local_model_runs (id, task_id, source_type, model_id, started_at, duration_ms, outcome)
						 VALUES ('bad', 'tab-naming', ?, 'm', 1, 1, ?)`
					)
					.run(sourceType, outcome);
			expect(() => insert('cloud', 'ok')).toThrow(/CHECK constraint/);
			expect(() => insert('local', 'timeout')).toThrow(/CHECK constraint/);
		});

		it('keeps the primary key and the NOT NULL columns', () => {
			const db = seededV19Db();
			runMigrations(db);

			expect(() =>
				db
					.prepare(
						`INSERT INTO local_model_runs (id, task_id, source_type, model_id, started_at, duration_ms, outcome)
						 VALUES ('run-local-ok', 'tab-naming', 'local', 'm', 1, 1, 'ok')`
					)
					.run()
			).toThrow(/UNIQUE constraint/);
			expect(() =>
				db
					.prepare(
						`INSERT INTO local_model_runs (id, task_id, source_type, started_at, duration_ms, outcome)
						 VALUES ('no-model', 'tab-naming', 'local', 1, 1, 'ok')`
					)
					.run()
			).toThrow(/NOT NULL constraint/);
		});

		it('puts the indexes back, adds the agent index, and leaves no scratch table', () => {
			const db = seededV19Db();
			runMigrations(db);

			expect(indexNames(db, 'local_model_runs')).toEqual(
				expect.arrayContaining([
					'idx_local_model_runs_agent',
					'idx_local_model_runs_started',
					'idx_local_model_runs_task',
				])
			);
			expect(hasTable(db, LOCAL_MODEL_RUNS_REBUILD_TABLE)).toBe(false);
			expect(columnNames(db, 'local_model_runs')).toEqual([
				'id',
				'task_id',
				'source_type',
				'model_id',
				'endpoint_id',
				'started_at',
				'duration_ms',
				'outcome',
				'error_code',
				'tokens_in',
				'tokens_out',
				'agent_id',
			]);
		});

		it('changes nothing on a second run', () => {
			const db = seededV19Db();
			runMigrations(db);
			const once = allRuns(db);
			const sqlOnce = tableSql(db, 'local_model_runs');

			runMigrations(db);

			expect(allRuns(db)).toEqual(once);
			expect(tableSql(db, 'local_model_runs')).toBe(sqlOnce);
			expect(getCurrentVersion(db)).toBe(20);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('keeps agent_id values on a table that has the column under the old CHECK', () => {
			const db = seededV19Db();
			db.prepare('ALTER TABLE local_model_runs ADD COLUMN agent_id TEXT').run();
			db.prepare(
				"UPDATE local_model_runs SET agent_id = 'agent-7' WHERE id = 'run-local-ok'"
			).run();

			runMigrations(db);

			const rows = allRuns(db);
			expect(rows).toHaveLength(OLD_RUNS.length);
			expect(rows.find((row) => row.id === 'run-local-ok')?.agent_id).toBe('agent-7');
			expect(tableSql(db, 'local_model_runs')).toContain("'system-one'");
		});

		it('rebuilds an empty table', () => {
			const db = seededV19Db();
			db.prepare('DELETE FROM local_model_runs').run();

			runMigrations(db);

			expect(allRuns(db)).toEqual([]);
			expect(columnNames(db, 'local_model_runs')).toContain('agent_id');
		});

		it('clears a scratch table left behind by hand before it copies', () => {
			const db = seededV19Db();
			db.prepare(`CREATE TABLE ${LOCAL_MODEL_RUNS_REBUILD_TABLE} (junk TEXT)`).run();
			db.prepare(`INSERT INTO ${LOCAL_MODEL_RUNS_REBUILD_TABLE} VALUES ('stale')`).run();

			runMigrations(db);

			expect(allRuns(db)).toHaveLength(OLD_RUNS.length);
			expect(hasTable(db, LOCAL_MODEL_RUNS_REBUILD_TABLE)).toBe(false);
		});
	});

	describe('a failure part way through', () => {
		it('leaves the old table and every row exactly as they were', () => {
			const db = seededV19Db();
			const before = allRuns(db);
			const sqlBefore = tableSql(db, 'local_model_runs');
			// The copy has been made and the old table DROPPED when this statement runs.
			const failing = failingOn(db, /RENAME TO local_model_runs/, 'disk I/O error');

			expect(() => runMigrations(failing)).toThrow('disk I/O error');

			expect(allRuns(db)).toEqual(before);
			expect(tableSql(db, 'local_model_runs')).toBe(sqlBefore);
			expect(indexNames(db, 'local_model_runs')).toEqual([
				'idx_local_model_runs_started',
				'idx_local_model_runs_task',
			]);
			expect(hasTable(db, LOCAL_MODEL_RUNS_REBUILD_TABLE)).toBe(false);
			expect(getCurrentVersion(db)).toBe(19);
			expect(getMigrationHistory(db).find((m) => m.version === 20)).toMatchObject({
				status: 'failed',
				errorMessage: 'disk I/O error',
			});
		});

		it('undoes the rebuild when the query_events step after it fails', () => {
			const db = seededV19Db();
			const before = allRuns(db);
			const failing = failingOn(
				db,
				/ALTER TABLE query_events ADD COLUMN routed_tier/,
				'database is locked'
			);

			expect(() => runMigrations(failing)).toThrow('database is locked');

			// One transaction for the whole migration: no half-applied v20.
			expect(allRuns(db)).toEqual(before);
			expect(columnNames(db, 'local_model_runs')).not.toContain('agent_id');
			expect(columnNames(db, 'query_events')).not.toContain('run_on_endpoint');
			expect(getCurrentVersion(db)).toBe(19);
		});

		it('succeeds on the next start with nothing lost', () => {
			const db = seededV19Db();
			const before = allRuns(db);
			expect(() =>
				runMigrations(failingOn(db, /RENAME TO local_model_runs/, 'disk I/O error'))
			).toThrow();

			runMigrations(db);

			expect(allRuns(db)).toEqual(before.map((row) => ({ ...row, agent_id: null })));
			expect(getCurrentVersion(db)).toBe(20);
			expect(getMigrationHistory(db).find((m) => m.version === 20)).toMatchObject({
				status: 'success',
			});
		});
	});

	describe('query_events', () => {
		it('adds the three model columns and leaves old turns NULL in them', () => {
			const db = seededV19Db();

			runMigrations(db);

			expect(columnNames(db, 'query_events')).toEqual(
				expect.arrayContaining([...ADD_QUERY_EVENT_MODEL_COLUMNS])
			);
			const rows = db
				.prepare(
					'SELECT id, input_tokens, cost_usd, run_on_endpoint, run_on_model, routed_tier FROM query_events ORDER BY id'
				)
				.all()
				.map((row) => ({ ...(row as object) }));
			expect(rows).toEqual([
				{
					id: 'q-1',
					input_tokens: 1200,
					cost_usd: 0.25,
					run_on_endpoint: null,
					run_on_model: null,
					routed_tier: null,
				},
				{
					id: 'q-2',
					input_tokens: null,
					cost_usd: null,
					run_on_endpoint: null,
					run_on_model: null,
					routed_tier: null,
				},
			]);
		});

		it('writes and reads back a turn that ran on a source Auto chose', () => {
			const db = seededV19Db();
			runMigrations(db);

			db.prepare(INSERT_QUERY_EVENT_SQL).run(
				...bindQueryEvent('q-3', {
					sessionId: 'agent-1',
					agentType: 'claude-code',
					source: 'user',
					startTime: 1_790_000_002_000,
					duration: 3000,
					runOnEndpoint: 'maestro-server',
					runOnModel: 'qwen3.5-4b',
					routedTier: 'low',
				})
			);

			const row = db.prepare("SELECT * FROM query_events WHERE id = 'q-3'").get() as QueryEventRow;
			expect(mapQueryEventRow(row)).toMatchObject({
				runOnEndpoint: 'maestro-server',
				runOnModel: 'qwen3.5-4b',
				routedTier: 'low',
			});
			// A turn from before the columns maps to none of the three.
			const old = db.prepare("SELECT * FROM query_events WHERE id = 'q-1'").get() as QueryEventRow;
			const mapped = mapQueryEventRow(old);
			expect(mapped.runOnEndpoint).toBeUndefined();
			expect(mapped.runOnModel).toBeUndefined();
			expect(mapped.routedTier).toBeUndefined();
		});
	});

	describe('a fresh database', () => {
		it('is created in the v20 shape with nothing to rebuild', () => {
			const db = openDb();

			runMigrations(db);

			expect(getCurrentVersion(db)).toBe(20);
			expect(columnNames(db, 'local_model_runs')).toContain('agent_id');
			expect(tableSql(db, 'local_model_runs')).toContain("'system-one'");
			expect(indexNames(db, 'local_model_runs')).toContain('idx_local_model_runs_agent');
			expect(columnNames(db, 'query_events')).toEqual(
				expect.arrayContaining([...ADD_QUERY_EVENT_MODEL_COLUMNS])
			);
			expect(logger.warn).not.toHaveBeenCalled();
		});
	});

	describe('a version number that already covers v20', () => {
		it('rebuilds the table of a database stamped 20 without the schema, keeping its rows', () => {
			// v20 declares isApplied for the same reason v15 does: rc may number a
			// different migration 20, and user_version is only a number.
			const db = seededV19Db();
			const before = allRuns(db);
			db.pragma('user_version = 20');

			runMigrations(db);

			expect(allRuns(db)).toEqual(before.map((row) => ({ ...row, agent_id: null })));
			expect(columnNames(db, 'query_events')).toEqual(
				expect.arrayContaining([...ADD_QUERY_EVENT_MODEL_COLUMNS])
			);
			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v20');
		});

		it('repairs a database that has the rebuilt table and lacks one query_events column', () => {
			const db = openDb();
			runMigrations(db);
			db.prepare('ALTER TABLE query_events DROP COLUMN routed_tier').run();
			vi.mocked(logger.warn).mockClear();

			runMigrations(db);

			expect(columnNames(db, 'query_events')).toContain('routed_tier');
			expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v20');
		});

		it('creates the table in the v20 shape when an earlier build never made it', () => {
			const db = seededV19Db();
			db.prepare('DROP TABLE local_model_runs').run();

			runMigrations(db);

			expect(columnNames(db, 'local_model_runs')).toContain('agent_id');
			expect(indexNames(db, 'local_model_runs')).toEqual(
				expect.arrayContaining([
					'idx_local_model_runs_agent',
					'idx_local_model_runs_started',
					'idx_local_model_runs_task',
				])
			);
			expect(getCurrentVersion(db)).toBe(20);
		});
	});

	describe('recording into the rebuilt table', () => {
		it('stores a model server run and a System One run with their agent, beside the old rows', () => {
			const db = seededV19Db();
			runMigrations(db);

			recordLocalModelRun(db, {
				taskId: 'model-routing',
				sourceType: 'server',
				modelId: 'qwen3.5-4b',
				agentId: 'agent-1',
				startedAt: 1_790_000_100_000,
				durationMs: 88,
				outcome: 'ok',
				tokensIn: 300,
				tokensOut: 12,
			});
			recordLocalModelRun(db, {
				taskId: 'agent:rank',
				sourceType: 'system-one',
				modelId: 'jev-1.13.0',
				endpointId: 'jev-cloud',
				agentId: 'agent-2',
				startedAt: 1_790_000_200_000,
				durationMs: 241,
				outcome: 'error',
				errorCode: 'timeout',
			});

			const runs = getLocalModelRuns(db, 'all');
			expect(runs).toHaveLength(OLD_RUNS.length + 2);
			expect(runs.find((run) => run.sourceType === 'server')).toMatchObject({
				taskId: 'model-routing',
				modelId: 'qwen3.5-4b',
				agentId: 'agent-1',
				tokensIn: 300,
			});
			expect(runs.find((run) => run.sourceType === 'system-one')).toMatchObject({
				taskId: 'agent:rank',
				endpointId: 'jev-cloud',
				agentId: 'agent-2',
				errorCode: 'timeout',
			});
			// A row from before the column has no agent, and says so by omission.
			const old = runs.find((run) => run.id === 'run-local-ok');
			expect(old).toBeDefined();
			expect(old).not.toHaveProperty('agentId');
		});
	});
});
