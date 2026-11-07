/**
 * Tests for the System One decision ledger's table (`s1_decisions`).
 *
 * The SQL is what is under test here (the migration, the filter predicates,
 * the ordering, the prune), so these run against a real SQLite through the
 * `node:sqlite` shim instead of a statement recorder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getCurrentVersion, getTargetVersion, runMigrations } from '../../../main/stats/migrations';
import {
	clearSystemOneDecisionsCache,
	getSystemOneAgentSpend,
	getSystemOneDecisions,
	insertSystemOneDecision,
	pruneSystemOneDecisions,
} from '../../../main/stats/s1-decisions';
import type { SystemOneDecision } from '../../../shared/local-models/system-one-ledger';
import { STATS_DB_VERSION } from '../../../shared/stats-types';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;

function openDb(): Database.Database {
	const Shim = nodeSqliteBetterSqlite3Mock().default;
	return new Shim(':memory:') as unknown as Database.Database;
}

function columnNames(db: Database.Database, table: string): string[] {
	return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function answered(overrides: Partial<SystemOneDecision> = {}): SystemOneDecision {
	return {
		taskId: 'cue-gate',
		engine: 'jev-cloud',
		model: 'jev-1.13.0',
		questionIds: ['proceed'],
		answers: { proceed: { type: 'noul', probability: 0.93 } },
		outcome: 'ok',
		startedAt: NOW,
		latencyMs: 241.6,
		usage: { inputTokens: 412, outputTokens: 3 },
		costUsd: 0.0000173,
		...overrides,
	};
}

function noAnswer(overrides: Partial<SystemOneDecision> = {}): SystemOneDecision {
	return {
		taskId: 'cue-gate',
		engine: 'jev-cloud',
		questionIds: ['proceed'],
		outcome: 'failed-open',
		code: 'timeout',
		startedAt: NOW,
		latencyMs: 1500,
		...overrides,
	};
}

const everything = { since: 0, limit: 100 };

describe.skipIf(!canLoadNodeSqlite())('s1_decisions', () => {
	let db: Database.Database;

	beforeEach(() => {
		clearSystemOneDecisionsCache();
		db = openDb();
		runMigrations(db);
	});

	describe('migrations v18 and v19', () => {
		it('creates the table with the ledger columns and brings the database to the target version', () => {
			expect(columnNames(db, 's1_decisions')).toEqual([
				'id',
				'started_at',
				'task_id',
				'engine',
				'model',
				'question_ids',
				'answers',
				'outcome',
				'error_code',
				'latency_ms',
				'tokens_in',
				'tokens_out',
				'cost_usd',
				'agent_id',
				'input',
				'tab_id',
				'cached',
			]);
			expect(getCurrentVersion(db)).toBe(20);
			expect(getTargetVersion()).toBe(20);
			expect(STATS_DB_VERSION).toBe(20);
		});

		it('indexes the two columns a read filters on', () => {
			const indexes = (
				db
					.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='s1_decisions'")
					.all() as Array<{ name: string }>
			).map((row) => row.name);

			expect(indexes).toEqual(
				expect.arrayContaining(['idx_s1_decisions_started', 'idx_s1_decisions_task'])
			);
		});

		it('adds the table to a database that stopped at version 17, and keeps its rows', () => {
			const older = openDb();
			runMigrations(older);
			older.prepare('DROP TABLE s1_decisions').run();
			older.pragma('user_version = 17');
			older
				.prepare(
					`INSERT INTO local_model_runs
					 (id, task_id, source_type, model_id, started_at, duration_ms, outcome)
					 VALUES ('run-1', 'tab-naming', 'local', 'qwen', 1, 2, 'ok')`
				)
				.run();

			runMigrations(older);

			expect(getCurrentVersion(older)).toBe(20);
			expect(columnNames(older, 's1_decisions')).toContain('outcome');
			expect(older.prepare('SELECT COUNT(*) AS n FROM local_model_runs').get()).toEqual({ n: 1 });
		});

		it('refuses an outcome the ledger does not have', () => {
			expect(() => insertSystemOneDecision(db, answered({ outcome: 'timeout' as never }))).toThrow(
				/CHECK constraint/
			);
		});
	});

	describe('insertSystemOneDecision and getSystemOneDecisions', () => {
		it('round-trips an answered decision, with the latency rounded', () => {
			const id = insertSystemOneDecision(db, answered({ agentId: 'agent-1' }));

			const { entries, total } = getSystemOneDecisions(db, everything);

			expect(total).toBe(1);
			expect(entries).toEqual([{ ...answered({ agentId: 'agent-1' }), id, latencyMs: 242 }]);
		});

		it('round-trips a decision with no answer: no model, answers, usage, cost, agent or input', () => {
			const id = insertSystemOneDecision(db, noAnswer());

			const [entry] = getSystemOneDecisions(db, everything).entries;

			expect(entry).toEqual({ ...noAnswer(), id });
			for (const absent of [
				'model',
				'answers',
				'usage',
				'costUsd',
				'agentId',
				'tabId',
				'cached',
				'input',
			]) {
				expect(entry).not.toHaveProperty(absent);
			}
		});

		it("round-trips an agent's request: its verb as the source, the tab, and the cached mark", () => {
			const asked = answered({
				taskId: 'agent:rank',
				agentId: 'agent-1',
				tabId: 'tab-7',
				questionIds: ['c0', 'c1'],
				answers: {
					c0: { type: 'noul', probability: 0.9 },
					c1: { type: 'noul', probability: 0.1 },
				},
			});
			const fromCache = answered({
				taskId: 'agent:yes',
				agentId: 'agent-1',
				startedAt: NOW - 1,
				latencyMs: 0,
				usage: { inputTokens: 0, outputTokens: 0 },
				costUsd: 0,
				cached: true,
			});
			const first = insertSystemOneDecision(db, asked);
			const second = insertSystemOneDecision(db, fromCache);

			const { entries } = getSystemOneDecisions(db, everything);

			expect(entries).toEqual([
				{ ...asked, id: first, latencyMs: 242 },
				{ ...fromCache, id: second },
			]);
			// Not cached is the absence of the mark, never `cached: false`.
			expect(entries[0]).not.toHaveProperty('cached');
		});

		it("filters by an agent's verb the way it filters by a task", () => {
			insertSystemOneDecision(db, answered());
			insertSystemOneDecision(db, answered({ taskId: 'agent:rank' }));
			insertSystemOneDecision(db, answered({ taskId: 'agent:batch' }));

			const { entries, total } = getSystemOneDecisions(db, { ...everything, taskId: 'agent:rank' });

			expect(total).toBe(1);
			expect(entries[0].taskId).toBe('agent:rank');
		});

		it('keeps an input only on the record that carries one', () => {
			insertSystemOneDecision(db, answered({ startedAt: NOW - 1 }));
			insertSystemOneDecision(db, answered({ input: '{"state":"kept"}' }));

			const { entries } = getSystemOneDecisions(db, everything);

			expect(entries[0].input).toBe('{"state":"kept"}');
			expect(entries[1]).not.toHaveProperty('input');
		});

		it('returns the newest first', () => {
			insertSystemOneDecision(db, answered({ startedAt: NOW - 2000, model: 'oldest' }));
			insertSystemOneDecision(db, answered({ startedAt: NOW, model: 'newest' }));
			insertSystemOneDecision(db, answered({ startedAt: NOW - 1000, model: 'middle' }));

			expect(getSystemOneDecisions(db, everything).entries.map((entry) => entry.model)).toEqual([
				'newest',
				'middle',
				'oldest',
			]);
		});

		it('filters by task', () => {
			insertSystemOneDecision(db, answered());
			insertSystemOneDecision(db, answered({ taskId: 'injection-screen' }));

			const { entries, total } = getSystemOneDecisions(db, {
				...everything,
				taskId: 'injection-screen',
			});

			expect(total).toBe(1);
			expect(entries[0].taskId).toBe('injection-screen');
		});

		it('filters by outcome', () => {
			insertSystemOneDecision(db, answered());
			insertSystemOneDecision(db, noAnswer({ outcome: 'failed-closed', code: 'auth' }));
			insertSystemOneDecision(db, noAnswer());

			const { entries, total } = getSystemOneDecisions(db, {
				...everything,
				outcome: 'failed-closed',
			});

			expect(total).toBe(1);
			expect(entries[0].code).toBe('auth');
		});

		it('matches a timeout by its code, whichever way the run failed', () => {
			insertSystemOneDecision(db, answered());
			insertSystemOneDecision(db, noAnswer({ outcome: 'failed-open', code: 'timeout' }));
			insertSystemOneDecision(db, noAnswer({ outcome: 'failed-closed', code: 'timeout' }));
			insertSystemOneDecision(db, noAnswer({ outcome: 'failed-open', code: 'unavailable' }));

			const { entries, total } = getSystemOneDecisions(db, { ...everything, outcome: 'timeout' });

			expect(total).toBe(2);
			expect(entries.map((entry) => entry.outcome).sort()).toEqual([
				'failed-closed',
				'failed-open',
			]);
		});

		it('leaves out what started before the floor', () => {
			insertSystemOneDecision(db, answered({ startedAt: NOW - 2 * DAY_MS }));
			insertSystemOneDecision(db, answered({ startedAt: NOW }));

			const { entries, total } = getSystemOneDecisions(db, { since: NOW - DAY_MS, limit: 100 });

			expect(total).toBe(1);
			expect(entries[0].startedAt).toBe(NOW);
		});

		it('caps the rows at the limit and still counts every match', () => {
			for (let i = 0; i < 5; i++) insertSystemOneDecision(db, answered({ startedAt: NOW - i }));

			const { entries, total } = getSystemOneDecisions(db, { since: 0, limit: 2 });

			expect(entries).toHaveLength(2);
			expect(total).toBe(5);
		});

		it('reads a JSON column that does not parse as absent, never as a throw', () => {
			const id = insertSystemOneDecision(db, answered());
			db.prepare("UPDATE s1_decisions SET answers = '{not json', question_ids = 'nope'").run();

			const [entry] = getSystemOneDecisions(db, everything).entries;

			expect(entry.id).toBe(id);
			expect(entry.questionIds).toEqual([]);
			expect(entry).not.toHaveProperty('answers');
		});
	});

	describe('getSystemOneAgentSpend', () => {
		const spent = (overrides: Partial<SystemOneDecision>): SystemOneDecision =>
			answered({ taskId: 'agent:rank', agentId: 'agent-1', costUsd: 0.01, ...overrides });

		it('sums each agent since the floor: requests, cache hits, tokens, cost and mean latency', () => {
			insertSystemOneDecision(db, spent({ latencyMs: 100 }));
			insertSystemOneDecision(db, spent({ taskId: 'agent:yes', latencyMs: 300, costUsd: 0.02 }));
			insertSystemOneDecision(
				db,
				spent({
					latencyMs: 0,
					usage: { inputTokens: 0, outputTokens: 0 },
					costUsd: 0,
					cached: true,
				})
			);
			insertSystemOneDecision(db, spent({ agentId: 'agent-2', costUsd: 0.5 }));

			expect(getSystemOneAgentSpend(db, NOW - DAY_MS)).toEqual([
				{
					agentId: 'agent-2',
					requests: 1,
					cachedRequests: 0,
					tokensIn: 412,
					tokensOut: 3,
					costUsd: 0.5,
					averageLatencyMs: 242,
				},
				{
					agentId: 'agent-1',
					requests: 3,
					cachedRequests: 1,
					tokensIn: 824,
					tokensOut: 6,
					costUsd: expect.closeTo(0.03, 10),
					// The cached request sent nothing, so it is not in the mean.
					averageLatencyMs: 200,
				},
			]);
		});

		it("leaves out a task's run, which is Maestro's spend even when it names an agent", () => {
			insertSystemOneDecision(db, answered({ taskId: 'cue-gate', agentId: 'agent-1', costUsd: 9 }));
			insertSystemOneDecision(db, spent({}));

			const rows = getSystemOneAgentSpend(db, 0);

			expect(rows).toHaveLength(1);
			expect(rows[0].costUsd).toBeCloseTo(0.01, 10);
		});

		it('leaves out what started before the floor, and keeps a request that named no agent', () => {
			insertSystemOneDecision(db, spent({ startedAt: NOW - 2 * DAY_MS, costUsd: 5 }));
			insertSystemOneDecision(db, spent({ agentId: undefined, costUsd: 0.25 }));

			expect(getSystemOneAgentSpend(db, NOW - DAY_MS)).toEqual([
				expect.objectContaining({ agentId: null, requests: 1, costUsd: 0.25 }),
			]);
		});

		it('counts a request with no answer, at no cost and outside the mean latency', () => {
			insertSystemOneDecision(
				db,
				noAnswer({ taskId: 'agent:batch', agentId: 'agent-1', outcome: 'unavailable' })
			);

			expect(getSystemOneAgentSpend(db, 0)).toEqual([
				{
					agentId: 'agent-1',
					requests: 1,
					cachedRequests: 0,
					tokensIn: 0,
					tokensOut: 0,
					costUsd: 0,
					averageLatencyMs: 0,
				},
			]);
		});

		it('answers with nothing when no agent has asked', () => {
			insertSystemOneDecision(db, answered());

			expect(getSystemOneAgentSpend(db, 0)).toEqual([]);
		});
	});

	describe('pruneSystemOneDecisions', () => {
		it('deletes what started before the cutoff and keeps the rest', () => {
			insertSystemOneDecision(db, answered({ startedAt: NOW - 31 * DAY_MS, model: 'old' }));
			insertSystemOneDecision(db, answered({ startedAt: NOW - 30 * DAY_MS, model: 'edge' }));
			insertSystemOneDecision(db, answered({ startedAt: NOW - 29 * DAY_MS, model: 'kept' }));

			const deleted = pruneSystemOneDecisions(db, NOW - 30 * DAY_MS);

			expect(deleted).toBe(1);
			// A row exactly at the cutoff is inside the window.
			expect(getSystemOneDecisions(db, everything).entries.map((entry) => entry.model)).toEqual([
				'kept',
				'edge',
			]);
		});

		it('deletes a kept input with its row', () => {
			insertSystemOneDecision(
				db,
				answered({ startedAt: NOW - 40 * DAY_MS, input: '{"state":"secret-free text"}' })
			);

			pruneSystemOneDecisions(db, NOW - 30 * DAY_MS);

			expect(db.prepare('SELECT COUNT(*) AS n FROM s1_decisions').get()).toEqual({ n: 0 });
		});

		it('deletes nothing when every row is inside the window', () => {
			insertSystemOneDecision(db, answered());

			expect(pruneSystemOneDecisions(db, NOW - 30 * DAY_MS)).toBe(0);
			expect(getSystemOneDecisions(db, everything).total).toBe(1);
		});
	});
});
