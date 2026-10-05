/**
 * The runtime's usage recorder, against the desktop's real `stats.db` schema.
 *
 * `better-sqlite3` is a native addon built for Electron, so most dev machines cannot load it in
 * a test. Node's built-in `node:sqlite` can, so a thin adapter gives the recorder the
 * connection shape it uses, and the schema is built by the desktop's own `runMigrations`. That
 * keeps the assertion honest: the row the recorder writes is read back from the schema the
 * desktop creates, not from a copy of it written for the test.
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warnings: string[] = [];
const errors: string[] = [];

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../../../../main/stats/migrations';
import { setMaestroLibLogger } from '../../../../shared/maestro-lib/host';
import {
	createStatsRecorder,
	type StatsConnection,
	type StatsConnectionConstructor,
} from '../../../../shared/maestro-lib/turns/stats';
import { QUERY_EVENT_COLUMNS } from '../../../../shared/maestro-lib/stats/query-event-insert';
import { STATS_DB_VERSION } from '../../../../shared/stats-types';

interface NodeStatement {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}
interface NodeDatabase {
	prepare(sql: string): NodeStatement;
	exec(sql: string): void;
	close(): void;
}

const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: (new (file: string) => NodeDatabase) | undefined;
try {
	DatabaseSync = (nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
} catch {
	DatabaseSync = undefined;
}

/** `better-sqlite3`'s surface, as far as the recorder and the desktop's migrations use it. */
class AdaptedDatabase implements StatsConnection {
	private readonly db: NodeDatabase;
	constructor(file: string) {
		this.db = new DatabaseSync!(file);
	}
	pragma(source: string): unknown {
		return this.db.prepare(`PRAGMA ${source}`).all();
	}
	prepare(sql: string) {
		return this.db.prepare(sql);
	}
	transaction<T>(fn: () => T): () => T {
		return () => {
			this.db.exec('BEGIN');
			try {
				const value = fn();
				this.db.exec('COMMIT');
				return value;
			} catch (error) {
				this.db.exec('ROLLBACK');
				throw error;
			}
		};
	}
	close(): void {
		this.db.close();
	}
}

const Adapted = AdaptedDatabase as unknown as StatsConnectionConstructor;

const EVENT = {
	sessionId: 'agent-1',
	agentType: 'claude-code',
	source: 'user' as const,
	startTime: 1_700_000_000_000,
	duration: 4200,
	projectPath: 'C:\\work\\proj',
	tabId: 'tab-1',
	isRemote: false,
	isWorktree: true,
	inputTokens: 1000,
	outputTokens: 250,
	cacheReadTokens: 900,
	cacheCreationTokens: 80,
	costUsd: 0.42,
};

describe.skipIf(!DatabaseSync)('createStatsRecorder', () => {
	let dir: string;
	let statsFile: string;

	/** A database the desktop would have made: every migration applied. */
	function createDesktopDatabase(): void {
		const db = new Adapted(statsFile);
		runMigrations(db as never);
		db.close();
	}

	function rows(): Array<Record<string, unknown>> {
		const db = new DatabaseSync!(statsFile);
		try {
			return db.prepare('SELECT * FROM query_events').all() as Array<Record<string, unknown>>;
		} finally {
			db.close();
		}
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-recorder-test-'));
		statsFile = path.join(dir, 'stats.db');
		warnings.length = 0;
		errors.length = 0;
		setMaestroLibLogger({
			debug: () => undefined,
			info: () => undefined,
			warn: (message) => void warnings.push(message),
			error: (message) => void errors.push(message),
		});
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes one query_events row in the desktop schema, with every column the desktop writes', () => {
		createDesktopDatabase();
		const recorder = createStatsRecorder({ paths: { statsFile }, loadSqlite: () => Adapted });
		return recorder.recordQuery(EVENT).then((result) => {
			expect(result.ok).toBe(true);
			const [row] = rows();
			expect(Object.keys(row)).toEqual(expect.arrayContaining([...QUERY_EVENT_COLUMNS]));
			expect(row).toMatchObject({
				id: result.ok ? result.id : '',
				session_id: 'agent-1',
				agent_type: 'claude-code',
				source: 'user',
				start_time: 1_700_000_000_000,
				duration: 4200,
				// Forward slashes, as the desktop stores every path.
				project_path: 'C:/work/proj',
				tab_id: 'tab-1',
				is_remote: 0,
				is_worktree: 1,
				user_name: null,
				input_tokens: 1000,
				output_tokens: 250,
				cache_read_tokens: 900,
				cache_creation_tokens: 80,
				cost_usd: 0.42,
			});
			// The id has the desktop's `timestamp-random` shape.
			expect(String(row.id)).toMatch(/^\d+-[a-z0-9]+$/);
		});
	});

	it('stores NULL, not 0, for a turn whose provider reported no usage', async () => {
		createDesktopDatabase();
		const recorder = createStatsRecorder({ paths: { statsFile }, loadSqlite: () => Adapted });
		await recorder.recordQuery({
			sessionId: 'agent-1',
			agentType: 'codex',
			source: 'user',
			startTime: 1,
			duration: 2,
		});
		expect(rows()[0]).toMatchObject({
			input_tokens: null,
			output_tokens: null,
			cache_read_tokens: null,
			cache_creation_tokens: null,
			cost_usd: null,
			project_path: null,
		});
	});

	it('leaves the schema version and the migration record alone, and opens the file in WAL mode', async () => {
		createDesktopDatabase();
		const before = new DatabaseSync!(statsFile);
		const versionBefore = before.prepare('PRAGMA user_version').all();
		before.close();
		await createStatsRecorder({ paths: { statsFile }, loadSqlite: () => Adapted }).recordQuery(
			EVENT
		);
		const after = new DatabaseSync!(statsFile);
		expect(after.prepare('PRAGMA user_version').all()).toEqual(versionBefore);
		expect(versionBefore).toEqual([{ user_version: STATS_DB_VERSION }]);
		expect(after.prepare('PRAGMA journal_mode').all()).toEqual([{ journal_mode: 'wal' }]);
		after.close();
	});

	it('does not create stats.db: the desktop owns its creation and migration', async () => {
		const result = await createStatsRecorder({
			paths: { statsFile },
			loadSqlite: () => Adapted,
		}).recordQuery(EVENT);
		expect(result).toMatchObject({ ok: false, reason: 'no-database' });
		expect(fs.existsSync(statsFile)).toBe(false);
	});

	it('skips the row and keeps going when the native module will not load, logging once', async () => {
		createDesktopDatabase();
		const recorder = createStatsRecorder({
			paths: { statsFile },
			loadSqlite: () => {
				throw Object.assign(new Error("Maestro's database module cannot be loaded."), {
					name: 'SqliteUnavailableError',
				});
			},
		});
		const first = await recorder.recordQuery(EVENT);
		const second = await recorder.recordQuery(EVENT);
		expect(first).toMatchObject({
			ok: false,
			reason: 'unavailable',
			message: "Maestro's database module cannot be loaded.",
		});
		expect(second).toMatchObject({ ok: false, reason: 'unavailable' });
		expect(warnings).toEqual(["Maestro's database module cannot be loaded."]);
		expect(rows()).toEqual([]);
	});

	it('skips a file that predates the columns it writes instead of altering it', async () => {
		const old = new DatabaseSync!(statsFile);
		old.exec(
			`CREATE TABLE query_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT NOT NULL,
			 source TEXT NOT NULL, start_time INTEGER NOT NULL, duration INTEGER NOT NULL, project_path TEXT, tab_id TEXT)`
		);
		old.close();
		const result = await createStatsRecorder({
			paths: { statsFile },
			loadSqlite: () => Adapted,
		}).recordQuery(EVENT);
		expect(result).toMatchObject({ ok: false, reason: 'schema' });
		expect(result.ok ? '' : result.message).toContain('is_remote');
		expect(warnings).toHaveLength(1);
		expect(rows()).toEqual([]);
	});

	it('records nothing when usage statistics are turned off', async () => {
		createDesktopDatabase();
		const result = await createStatsRecorder({
			paths: { statsFile },
			loadSqlite: () => Adapted,
			isEnabled: () => false,
		}).recordQuery(EVENT);
		expect(result).toMatchObject({ ok: false, reason: 'disabled' });
		expect(rows()).toEqual([]);
	});

	it('records nothing once another process owns the data directory', async () => {
		createDesktopDatabase();
		const result = await createStatsRecorder({
			paths: { statsFile },
			loadSqlite: () => Adapted,
			fence: () => ({ ok: false, reason: 'taken over' }),
		}).recordQuery(EVENT);
		expect(result).toMatchObject({ ok: false, reason: 'fenced', message: 'taken over' });
		expect(rows()).toEqual([]);
	});

	it('reports a failed insert as a result and closes the connection', async () => {
		createDesktopDatabase();
		let closed = false;
		class Failing implements StatsConnection {
			pragma(source: string) {
				return source.startsWith('table_info') ? QUERY_EVENT_COLUMNS.map((name) => ({ name })) : [];
			}
			prepare() {
				return {
					run: () => {
						throw new Error('database is locked');
					},
				};
			}
			close() {
				closed = true;
			}
		}
		const result = await createStatsRecorder({
			paths: { statsFile },
			loadSqlite: () => Failing as unknown as StatsConnectionConstructor,
		}).recordQuery(EVENT);
		expect(result).toMatchObject({ ok: false, reason: 'failed', message: 'database is locked' });
		expect(closed).toBe(true);
		expect(errors[0]).toContain('database is locked');
	});

	describe('an Auto Run', () => {
		function table(name: string): Array<Record<string, unknown>> {
			const db = new DatabaseSync!(statsFile);
			try {
				return db.prepare(`SELECT * FROM ${name}`).all() as Array<Record<string, unknown>>;
			} finally {
				db.close();
			}
		}

		it('is opened, given its tasks, and closed in the rows the Usage Dashboard reads', async () => {
			createDesktopDatabase();
			const recorder = createStatsRecorder({ paths: { statsFile }, loadSqlite: () => Adapted });

			const started = await recorder.startAutoRun({
				sessionId: 'agent-1',
				agentType: 'claude-code',
				documentPath: 'one, two',
				startTime: 1_700_000_000_000,
				duration: 0,
				tasksTotal: 3,
				projectPath: 'C:\\work\\proj',
			});
			if (!started.ok) throw new Error(started.message);
			await recorder.recordAutoTask({
				autoRunSessionId: started.id,
				sessionId: 'agent-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Did the first task.',
				startTime: 1_700_000_001_000,
				duration: 900,
				success: true,
			});
			const closed = await recorder.endAutoRun(started.id, 5000, 3);
			expect(closed.ok).toBe(true);

			expect(table('auto_run_sessions')).toMatchObject([
				{
					id: started.id,
					session_id: 'agent-1',
					agent_type: 'claude-code',
					// Forward slashes, as the desktop stores every path.
					document_path: 'one, two',
					project_path: 'C:/work/proj',
					start_time: 1_700_000_000_000,
					duration: 5000,
					tasks_total: 3,
					tasks_completed: 3,
				},
			]);
			expect(table('auto_run_tasks')).toMatchObject([
				{
					auto_run_session_id: started.id,
					task_index: 0,
					task_content: 'Did the first task.',
					duration: 900,
					success: 1,
				},
			]);
		});

		it('skips a file that predates the Auto Run tables instead of creating them', async () => {
			const old = new DatabaseSync!(statsFile);
			old.exec('CREATE TABLE query_events (id TEXT PRIMARY KEY)');
			old.close();
			const result = await createStatsRecorder({
				paths: { statsFile },
				loadSqlite: () => Adapted,
			}).startAutoRun({
				sessionId: 'agent-1',
				agentType: 'claude-code',
				startTime: 1,
				duration: 0,
			});
			expect(result).toMatchObject({ ok: false, reason: 'schema' });
			expect(result.ok ? '' : result.message).toContain('auto_run_sessions');
		});

		it('is not recorded when usage statistics are turned off', async () => {
			createDesktopDatabase();
			const result = await createStatsRecorder({
				paths: { statsFile },
				loadSqlite: () => Adapted,
				isEnabled: () => false,
			}).startAutoRun({
				sessionId: 'agent-1',
				agentType: 'claude-code',
				startTime: 1,
				duration: 0,
			});
			expect(result).toMatchObject({ ok: false, reason: 'disabled' });
			expect(table('auto_run_sessions')).toEqual([]);
		});
	});
});
