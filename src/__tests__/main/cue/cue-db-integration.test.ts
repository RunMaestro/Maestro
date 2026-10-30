/**
 * Phase 15B - Cue database contract / integration tests.
 *
 * Exercises the contract cue-engine depends on (ordering, UNIQUE, prune-by-age,
 * heartbeat upsert, safe-wrapper no-throw) through the in-memory mirror
 * defined in `cue-integration-test-helpers.ts`. We cannot use real
 * `better-sqlite3` under vitest because the native binary is built for
 * Electron's ABI and fails to load in plain Node; the in-memory mirror
 * preserves the SQL semantics that actually matter for the rest of the
 * engine (ordering, UNIQUE constraints, prune cutoff).
 *
 * A `describe.skipIf(!canLoadBetterSqlite3())` block at the bottom runs one
 * real-SQLite smoke round-trip when the binary is available locally - this
 * catches drift between the mirror and the native module without breaking CI
 * on hosts that can't load it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
	createInMemoryCueDb,
	canLoadBetterSqlite3,
	type InMemoryCueDb,
} from './cue-integration-test-helpers';

describe('Phase 15B - cue-db in-memory contract', () => {
	let db: InMemoryCueDb;

	beforeEach(() => {
		db = createInMemoryCueDb();
		db.initCueDb();
	});

	// ─── Lifecycle ────────────────────────────────────────────────────────

	describe('lifecycle', () => {
		it('is ready after init and not ready after close', () => {
			expect(db.isCueDbReady()).toBe(true);
			db.closeCueDb();
			expect(db.isCueDbReady()).toBe(false);
		});

		it('initCueDb is idempotent - second call is a no-op', () => {
			// Calling init twice must not throw nor reset the current state.
			db.recordCueEvent({
				id: 'e1',
				type: 'time.heartbeat',
				triggerName: 't',
				sessionId: 'session-1',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.initCueDb(); // second call
			expect(db.getRecentCueEvents(0).length).toBe(1);
		});

		it('getRecentCueEvents throws when DB is not initialized', () => {
			db.closeCueDb();
			expect(() => db.getRecentCueEvents(0)).toThrow(/not initialized/);
		});
	});

	// ─── Event journal ────────────────────────────────────────────────────

	// ─── Historical Conductor credit ──────────────────────────────────────

	describe('historical conductor credit', () => {
		const MINUTE = 60_000;

		/** Record an event at `startMs` and complete it `durationMs` later. */
		function runFor(id: string, startMs: number, durationMs: number, status = 'completed') {
			db.setNowOverride(startMs);
			db.recordCueEvent({
				id,
				type: 'time.heartbeat',
				triggerName: 'hb',
				sessionId: 'session-1',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.setNowOverride(startMs + durationMs);
			db.updateCueEventStatus(id, status);
		}

		it('returns 0 with no events', () => {
			expect(db.getHistoricalConductorCreditMs()).toBe(0);
		});

		it('floors each run to whole minutes independently', () => {
			// 90s + 90s credits 1m + 1m, NOT the 3m a sum-then-floor would give.
			runFor('a', 1_000_000, 90_000);
			runFor('b', 2_000_000, 90_000);
			expect(db.getHistoricalConductorCreditMs()).toBe(2 * MINUTE);
		});

		it('ignores sub-minute runs, matching the live credit rule', () => {
			runFor('a', 1_000_000, 59_999);
			expect(db.getHistoricalConductorCreditMs()).toBe(0);
		});

		it('counts only completed runs', () => {
			runFor('ok', 1_000_000, 5 * MINUTE);
			runFor('bad', 2_000_000, 30 * MINUTE, 'failed');
			runFor('gone', 3_000_000, 10 * MINUTE, 'timeout');
			// A hung run that failed after 30 minutes is wall-clock time, not
			// credited agent work - the Usage Dashboard's total duration counts it
			// but the Conductor level must not.
			expect(db.getHistoricalConductorCreditMs()).toBe(5 * MINUTE);
		});

		it('skips in-flight runs that have no completion timestamp', () => {
			db.setNowOverride(1_000_000);
			db.recordCueEvent({
				id: 'running',
				type: 'time.heartbeat',
				triggerName: 'hb',
				sessionId: 'session-1',
				subscriptionName: 'sub',
				status: 'running',
			});
			expect(db.getHistoricalConductorCreditMs()).toBe(0);
		});
	});

	describe('event journal', () => {
		it('records and retrieves a single event', () => {
			db.recordCueEvent({
				id: 'evt-1',
				type: 'time.heartbeat',
				triggerName: 'hb',
				sessionId: 'session-1',
				subscriptionName: 'sub-1',
				status: 'running',
				payload: '{"x":1}',
			});
			const events = db.getRecentCueEvents(0);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				id: 'evt-1',
				type: 'time.heartbeat',
				status: 'running',
				payload: '{"x":1}',
			});
			expect(events[0].completedAt).toBeNull();
		});

		it('returns events in ORDER BY created_at DESC', () => {
			db.setNowOverride(1000);
			db.recordCueEvent({
				id: 'e1',
				type: 'time.heartbeat',
				triggerName: 't',
				sessionId: 'session-1',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.setNowOverride(2000);
			db.recordCueEvent({
				id: 'e2',
				type: 'time.heartbeat',
				triggerName: 't',
				sessionId: 'session-1',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.setNowOverride(3000);
			db.recordCueEvent({
				id: 'e3',
				type: 'time.heartbeat',
				triggerName: 't',
				sessionId: 'session-1',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.clearNowOverride();
			const events = db.getRecentCueEvents(0);
			expect(events.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
		});

		it('LIMIT clause caps the result set', () => {
			for (let i = 0; i < 10; i++) {
				db.setNowOverride(1000 + i);
				db.recordCueEvent({
					id: `e${i}`,
					type: 'time.heartbeat',
					triggerName: 't',
					sessionId: 'session-1',
					subscriptionName: 'sub',
					status: 'running',
				});
			}
			db.clearNowOverride();
			expect(db.getRecentCueEvents(0, 3)).toHaveLength(3);
			expect(db.getRecentCueEvents(0).length).toBe(10);
		});

		it('filters events by created_at >= since', () => {
			db.setNowOverride(1000);
			db.recordCueEvent({
				id: 'old',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'x',
			});
			db.setNowOverride(2000);
			db.recordCueEvent({
				id: 'new',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'x',
			});
			db.clearNowOverride();
			expect(db.getRecentCueEvents(1500).map((e) => e.id)).toEqual(['new']);
		});

		it('INSERT OR REPLACE overwrites a duplicate id', () => {
			db.recordCueEvent({
				id: 'dup',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.recordCueEvent({
				id: 'dup',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'completed',
			});
			const events = db.getRecentCueEvents(0);
			expect(events).toHaveLength(1);
			expect(events[0].status).toBe('completed');
		});

		it('updateCueEventStatus flips status and sets completedAt', () => {
			db.setNowOverride(1000);
			db.recordCueEvent({
				id: 'e1',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.setNowOverride(5000);
			db.updateCueEventStatus('e1', 'completed');
			const events = db.getRecentCueEvents(0);
			expect(events[0].status).toBe('completed');
			expect(events[0].completedAt).toBe(5000);
			db.clearNowOverride();
		});

		it('updateCueEventStatus is a no-op when id does not exist (mirrors WHERE match fails)', () => {
			expect(() => db.updateCueEventStatus('nonexistent', 'completed')).not.toThrow();
			expect(db.getRecentCueEvents(0)).toHaveLength(0);
		});

		it('updateCueEventStatus stamps error_message + exit_code when failure info is passed', () => {
			db.recordCueEvent({
				id: 'e-fail',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.updateCueEventStatus('e-fail', 'timeout', null, {
				errorMessage: 'first_byte_timeout',
				exitCode: 5,
			});
			const [event] = db.getRecentCueEvents(0);
			expect(event.status).toBe('timeout');
			expect(event.errorMessage).toBe('first_byte_timeout');
			expect(event.exitCode).toBe(5);
		});

		it('updateCueEventStatus leaves error_message + exit_code untouched when no failure info is passed', () => {
			db.recordCueEvent({
				id: 'e-ok',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'running',
			});
			// A status flip with no failure object (e.g. 'stopped') must not write
			// the failure columns - they stay null/undefined.
			db.updateCueEventStatus('e-ok', 'stopped');
			const [event] = db.getRecentCueEvents(0);
			expect(event.status).toBe('stopped');
			expect(event.errorMessage ?? null).toBeNull();
			expect(event.exitCode ?? null).toBeNull();
		});

		it('safeRecordCueEvent swallows errors and is non-throwing', () => {
			db.queueWriteFailure(new Error('disk full'));
			expect(() =>
				db.safeRecordCueEvent({
					id: 'e1',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'running',
				})
			).not.toThrow();
			// The failed write left no row - non-fatal, as documented.
			expect(db.getRecentCueEvents(0)).toHaveLength(0);
		});

		it('safeUpdateCueEventStatus swallows errors and is non-throwing', () => {
			db.recordCueEvent({
				id: 'e1',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.queueWriteFailure(new Error('disk full'));
			expect(() => db.safeUpdateCueEventStatus('e1', 'completed')).not.toThrow();
			// Status unchanged because the failure short-circuited the update.
			expect(db.getRecentCueEvents(0)[0].status).toBe('running');
		});
	});

	// ─── Rapid successive writes ──────────────────────────────────────────
	//
	// JS is single-threaded and `Promise.resolve().then(...)` just schedules
	// microtasks - there's no real concurrency. What we exercise here is a
	// microtask flood: 100 writes serialized through the event loop in
	// immediate succession. Still worth pinning because the mirror uses a
	// Map + array pair for ordering, and a naive refactor that rebuilt the
	// ordering array from the Map on every write would silently lose events.

	describe('rapid successive writes', () => {
		it('preserves all 100 events written in rapid succession', async () => {
			const writes = Array.from({ length: 100 }, (_, i) =>
				Promise.resolve().then(() =>
					db.recordCueEvent({
						id: `c${i}`,
						type: 't',
						triggerName: 't',
						sessionId: 'session-1',
						subscriptionName: 'sub',
						status: 'running',
					})
				)
			);
			await Promise.all(writes);
			expect(db.getRecentCueEvents(0)).toHaveLength(100);
		});
	});

	// ─── Heartbeat ────────────────────────────────────────────────────────

	describe('heartbeat', () => {
		it('returns null before first heartbeat', () => {
			expect(db.getLastHeartbeat()).toBeNull();
		});

		it('upserts single-row heartbeat (id=1 replacement semantics)', () => {
			db.setNowOverride(100);
			db.updateHeartbeat();
			expect(db.getLastHeartbeat()).toBe(100);
			db.setNowOverride(200);
			db.updateHeartbeat();
			expect(db.getLastHeartbeat()).toBe(200); // replaced, not appended
			db.clearNowOverride();
		});
	});

	// ─── Prune ────────────────────────────────────────────────────────────

	describe('pruneCueEvents', () => {
		it('deletes events older than the cutoff', () => {
			// Step `now` forward deterministically: old event at 1_000,
			// recent event at 9_500, prune call at 10_000. With
			// olderThanMs=5_000 the cutoff is 10_000 - 5_000 = 5_000, so the
			// old event (1_000 < 5_000) is dropped and the recent event
			// (9_500 >= 5_000) survives.
			db.setNowOverride(1000);
			db.recordCueEvent({
				id: 'old',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'x',
			});
			db.setNowOverride(9500);
			db.recordCueEvent({
				id: 'recent',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'x',
			});
			db.setNowOverride(10000);
			db.pruneCueEvents(5000); // cutoff = 10_000 - 5_000 = 5_000

			const ids = db.getRecentCueEvents(0).map((e) => e.id);
			expect(ids).toEqual(['recent']);
			db.clearNowOverride();
		});

		it('is a no-op when no events predate the cutoff', () => {
			db.setNowOverride(10000);
			db.recordCueEvent({
				id: 'new',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'x',
			});
			db.pruneCueEvents(5000);
			expect(db.getRecentCueEvents(0)).toHaveLength(1);
			db.clearNowOverride();
		});

		it('preserves ordering of the remaining events', () => {
			db.setNowOverride(1000);
			db.recordCueEvent({
				id: 'a',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'x',
			});
			db.setNowOverride(2000);
			db.recordCueEvent({
				id: 'b',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'x',
			});
			db.setNowOverride(3000);
			db.recordCueEvent({
				id: 'c',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'x',
			});
			db.setNowOverride(4000);
			// cutoff = now - olderThanMs = 4000 - 2500 = 1500 → drops only 'a' (createdAt=1000).
			db.pruneCueEvents(2500);
			const ids = db.getRecentCueEvents(0).map((e) => e.id);
			expect(ids).toEqual(['c', 'b']);
			db.clearNowOverride();
		});
	});

	// ─── GitHub seen set ──────────────────────────────────────────────────

	describe('GitHub seen tracking', () => {
		it('markGitHubItemSeen is idempotent (UNIQUE on (sub, key))', () => {
			db.markGitHubItemSeen('sub-1', 'pr-42');
			db.markGitHubItemSeen('sub-1', 'pr-42');
			expect(db.isGitHubItemSeen('sub-1', 'pr-42')).toBe(true);
			// State assertion: only one row present.
			expect(db.state.githubSeen.size).toBe(1);
		});

		it('differentiates items across subscriptions', () => {
			db.markGitHubItemSeen('sub-1', 'pr-42');
			db.markGitHubItemSeen('sub-2', 'pr-42');
			expect(db.isGitHubItemSeen('sub-1', 'pr-42')).toBe(true);
			expect(db.isGitHubItemSeen('sub-2', 'pr-42')).toBe(true);
			expect(db.state.githubSeen.size).toBe(2);
		});

		it('hasAnyGitHubSeen returns true when at least one row exists for the subscription', () => {
			expect(db.hasAnyGitHubSeen('sub-1')).toBe(false);
			db.markGitHubItemSeen('sub-1', 'pr-1');
			expect(db.hasAnyGitHubSeen('sub-1')).toBe(true);
			expect(db.hasAnyGitHubSeen('sub-2')).toBe(false);
		});

		it('clearGitHubSeenForSubscription removes only matching rows', () => {
			db.markGitHubItemSeen('sub-1', 'pr-1');
			db.markGitHubItemSeen('sub-1', 'pr-2');
			db.markGitHubItemSeen('sub-2', 'pr-3');
			db.clearGitHubSeenForSubscription('sub-1');
			expect(db.isGitHubItemSeen('sub-1', 'pr-1')).toBe(false);
			expect(db.isGitHubItemSeen('sub-1', 'pr-2')).toBe(false);
			expect(db.isGitHubItemSeen('sub-2', 'pr-3')).toBe(true);
		});

		it('pruneGitHubSeen deletes rows older than cutoff', () => {
			db.setNowOverride(1000);
			db.markGitHubItemSeen('sub', 'old');
			db.setNowOverride(5000);
			db.markGitHubItemSeen('sub', 'new');
			db.setNowOverride(10000);
			db.pruneGitHubSeen(4000); // cutoff = 6000
			expect(db.isGitHubItemSeen('sub', 'old')).toBe(false);
			expect(db.isGitHubItemSeen('sub', 'new')).toBe(false);
			// Both 'old' (seen at 1000 < 6000) and 'new' (seen at 5000 < 6000) are
			// pruned because the cutoff is 6000. Document that.
			// Add a third after cutoff to verify the surviving path.
			db.setNowOverride(9000);
			db.markGitHubItemSeen('sub', 'surviving');
			db.setNowOverride(10000);
			db.pruneGitHubSeen(2000); // cutoff = 8000 → 'surviving' (seen 9000) stays
			expect(db.isGitHubItemSeen('sub', 'surviving')).toBe(true);
			db.clearNowOverride();
		});
	});

	// ─── Close / reinit persistence (in-memory simulation) ────────────────

	describe('restart simulation', () => {
		it('a fresh InMemoryCueDb starts empty - documents the test-helper contract', () => {
			// This makes explicit what cue-engine-integration.test.ts relies on:
			// `simulateRestart()` should use `resetAll()` to get a clean DB but
			// if the caller creates a NEW instance, it is also empty. If you
			// want persistence across a simulated restart, hang on to the SAME
			// InMemoryCueDb instance across close → init.
			db.recordCueEvent({
				id: 'e1',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'running',
			});
			expect(db.getRecentCueEvents(0)).toHaveLength(1);

			// Simulate an app restart with the SAME instance: close then init.
			// Data MUST survive (we never clear state on close - only `ready`).
			db.closeCueDb();
			db.initCueDb();
			expect(db.getRecentCueEvents(0)).toHaveLength(1);
		});

		it('resetAll wipes all state AND marks the DB not-ready', () => {
			db.recordCueEvent({
				id: 'e1',
				type: 't',
				triggerName: 't',
				sessionId: 's',
				subscriptionName: 'sub',
				status: 'running',
			});
			db.markGitHubItemSeen('sub', 'x');
			db.updateHeartbeat();
			db.resetAll();
			expect(db.isCueDbReady()).toBe(false);
			db.initCueDb();
			expect(db.getRecentCueEvents(0)).toHaveLength(0);
			expect(db.state.githubSeen.size).toBe(0);
			expect(db.getLastHeartbeat()).toBeNull();
		});
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Optional smoke test against real better-sqlite3 when the binary is available.
// Drift-catcher: if the mirror diverges from native behavior on a core
// round-trip, the smoke block surfaces that when run locally. CI usually skips.
// ────────────────────────────────────────────────────────────────────────────

describe.skipIf(!canLoadBetterSqlite3())('Phase 15B - real SQLite smoke test', () => {
	it('real cue-db persists and retrieves one event through a full round-trip', async () => {
		// Isolate this test from the rest of the file's mocks. We cannot use
		// the top-level `vi.mock('better-sqlite3', ...)` that other cue-db
		// tests install (it would short-circuit this smoke). Pull in cue-db
		// via dynamic import after confirming the binary loads.
		const dbPath = path.join(
			os.tmpdir(),
			`maestro-cue-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
		);
		// Capture the cue-db module lazily so the finally block can close the
		// SQLite handle even if an assertion above throws. Leaving the handle
		// open before `fs.unlinkSync` would fail on Windows (file locked) and
		// leak the connection on POSIX.
		let cueDb: typeof import('../../../main/cue/cue-db') | null = null;
		try {
			cueDb = await import('../../../main/cue/cue-db');
			cueDb.initCueDb(undefined, dbPath);
			cueDb.recordCueEvent({
				id: 'smoke-1',
				type: 'time.heartbeat',
				triggerName: 't',
				sessionId: 'session-1',
				subscriptionName: 'sub',
				status: 'running',
			});
			const events = cueDb.getRecentCueEvents(0);
			expect(events).toHaveLength(1);
			expect(events[0].id).toBe('smoke-1');

			// Failure diagnostics round-trip: a non-completed run stamps
			// error_message + exit_code (INTEGER column, so it comes back as a
			// number, not a string) and they survive read-back.
			cueDb.updateCueEventStatus('smoke-1', 'timeout', null, {
				errorMessage: 'first_byte_timeout: no transcript output',
				exitCode: 5,
			});
			const afterFailure = cueDb.getRecentCueEvents(0);
			expect(afterFailure[0].status).toBe('timeout');
			expect(afterFailure[0].errorMessage).toBe('first_byte_timeout: no transcript output');
			expect(afterFailure[0].exitCode).toBe(5);
		} finally {
			if (cueDb) {
				try {
					cueDb.closeCueDb();
				} catch {
					/* best effort - double-close is safe, other errors are non-fatal here */
				}
			}
			try {
				fs.unlinkSync(dbPath);
			} catch {
				/* best effort */
			}
		}
	});
});

describe.skipIf(!canLoadBetterSqlite3())('real SQLite: status reads cue.db read-only', () => {
	it('reads a live engine database without changing its schema, mode or files', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-ro-'));
		const dbPath = path.join(dir, 'cue.db');
		const { default: Database } = await import('better-sqlite3');
		const cueDb = await import('../../../main/cue/cue-db');
		const schemaOf = () => {
			const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
			try {
				return probe.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
			} finally {
				probe.close();
			}
		};
		try {
			// The engine's handle stays open, as it is while an engine runs.
			cueDb.initCueDb(undefined, dbPath);
			cueDb.updateHeartbeat();
			const schemaBefore = schemaOf();
			const filesBefore = fs.readdirSync(dir).sort();
			const modeBefore = fs.statSync(dbPath).mode;

			const figures = cueDb.readCueDbStatusFigures(dbPath);

			expect(figures.ok).toBe(true);
			if (figures.ok) {
				expect(figures.lastHeartbeatMs).toEqual(expect.any(Number));
				expect(figures.totalEvents).toBe(0);
			}
			expect(schemaOf()).toEqual(schemaBefore);
			expect(fs.readdirSync(dir).sort()).toEqual(filesBefore);
			if (process.platform !== 'win32') expect(fs.statSync(dbPath).mode).toBe(modeBefore);
		} finally {
			cueDb.closeCueDb();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!canLoadBetterSqlite3())(
	'real SQLite: activity history reads cue.db read-only',
	() => {
		/**
		 * Every file in `dir` with its bytes and mode, to prove nothing changed.
		 * The `-shm` file is shared memory, not data: every WAL reader records its
		 * read mark there, so its bytes are left out and only its presence counts.
		 */
		function snapshotDir(dir: string): Record<string, { bytes?: string; mode: number }> {
			const out: Record<string, { bytes?: string; mode: number }> = {};
			for (const name of fs.readdirSync(dir).sort()) {
				const file = path.join(dir, name);
				out[name] = {
					...(name.endsWith('-shm') ? {} : { bytes: fs.readFileSync(file).toString('base64') }),
					mode: fs.statSync(file).mode,
				};
			}
			return out;
		}

		async function seed(dbPath: string) {
			const cueDb = await import('../../../main/cue/cue-db');
			cueDb.initCueDb(undefined, dbPath);
			for (const [i, status] of ['completed', 'timeout', 'running'].entries()) {
				cueDb.recordCueEvent({
					id: `run-${i}`,
					type: 'time.scheduled',
					triggerName: 't',
					sessionId: 'agent-1',
					subscriptionName: `sub-${i}`,
					status: 'running',
				});
				// created_at is Date.now(); keep the rows apart so the order is defined.
				const until = Date.now() + 3;
				while (Date.now() < until) {
					/* spin */
				}
				if (status !== 'running') cueDb.updateCueEventStatus(`run-${i}`, status);
			}
			return cueDb;
		}

		it('reads beside an open engine handle without changing any file', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-history-live-'));
			const dbPath = path.join(dir, 'cue.db');
			const cueDb = await seed(dbPath);
			try {
				// The engine's handle stays open, so -wal and -shm exist.
				const before = snapshotDir(dir);

				const result = cueDb.readRecentCueEventsReadOnly(1000, dbPath);

				expect(result).toMatchObject({ ok: true, source: 'live' });
				if (result.ok) expect(result.records.map((r) => r.id)).toEqual(['run-2', 'run-1', 'run-0']);
				expect(snapshotDir(dir)).toEqual(before);
			} finally {
				cueDb.closeCueDb();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('reads a closed WAL database with no sidecars, creating and modifying nothing', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-history-closed-'));
			const dbPath = path.join(dir, 'cue.db');
			const cueDb = await seed(dbPath);
			cueDb.closeCueDb();
			try {
				// A clean close checkpoints and removes the sidecars: nothing has it open.
				expect(fs.readdirSync(dir)).toEqual(['cue.db']);
				const before = snapshotDir(dir);

				const result = cueDb.readRecentCueEventsReadOnly(2, dbPath);

				expect(result).toMatchObject({ ok: true, source: 'snapshot' });
				if (result.ok) {
					expect(result.records.map((r) => r.id)).toEqual(['run-2', 'run-1']);
					expect(result.records.map((r) => r.status)).toEqual(['running', 'timeout']);
				}
				expect(snapshotDir(dir)).toEqual(before);
				expect(cueDb.isCueDbReady()).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}
);

describe.skipIf(!canLoadBetterSqlite3())('real SQLite: plugin receipt uninstall lifecycle', () => {
	it.each([
		'a'.repeat(64),
		'receipt-v3:' + 'b'.repeat(64),
		'receipt-v2:' + 'g'.repeat(64),
		'receipt-v2:' + 'a'.repeat(63),
	])(
		'retains unresolved receipt format %s and blocks only its owner before a stable write',
		async (legacyKey) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-plugin-legacy-'));
			const cueDb = await import('../../../main/cue/cue-db');
			const receipt = { receiptId: 'receipt', payloadHash: 'hash', proof: 'proof' };
			const stableKey = 'receipt-v2:' + 'c'.repeat(64);
			try {
				cueDb.initCueDb(undefined, path.join(dir, 'cue.db'));
				// Historical/malformed input is seeded directly, not through the new-format writer.
				cueDb.writePluginEventReceipt('com.example.seed', 'seed', receipt);
				const Database = (await import('better-sqlite3')).default;
				const raw = new Database(path.join(dir, 'cue.db'));
				try {
					raw
						.prepare('INSERT INTO cue_plugin_receipts VALUES (?,?,?,?,?)')
						.run(
							'com.example.owner',
							legacyKey,
							receipt.receiptId,
							receipt.payloadHash,
							receipt.proof
						);
				} finally {
					raw.close();
				}
				expect(() =>
					cueDb.pluginEventReceiptCapacityAvailable('com.example.owner', { stableFormatOnly: true })
				).toThrow(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
				expect(() =>
					cueDb.writePluginEventReceipt('com.example.owner', stableKey, receipt)
				).toThrow(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
				expect(cueDb.readPluginEventReceipt('com.example.owner', legacyKey)).toEqual(receipt);
				expect(cueDb.readPluginEventReceipt('com.example.owner', stableKey)).toBeNull();
				expect(
					cueDb.pluginEventReceiptCapacityAvailable('com.example.other', { stableFormatOnly: true })
				).toBe(true);
				cueDb.writePluginEventReceipt('com.example.other', stableKey, receipt);
				expect(cueDb.readPluginEventReceipt('com.example.other', stableKey)).toEqual(receipt);
				expect(
					cueDb.pluginEventReceiptCapacityAvailable('com.example.other', { stableFormatOnly: true })
				).toBe(true);
				// Read/admission checks do not rewrite the unresolved namespace.
				expect(cueDb.readPluginEventReceipt('com.example.owner', legacyKey)).toEqual(receipt);
			} finally {
				cueDb.closeCueDb();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	);
	it('restores capacity for only the uninstalled plugin and permits a fresh installation', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-plugin-purge-'));
		const cueDb = await import('../../../main/cue/cue-db');
		const receipt = { receiptId: 'receipt', payloadHash: 'hash', proof: 'proof' };
		try {
			cueDb.initCueDb(undefined, path.join(dir, 'cue.db'));
			for (let index = 0; index < 4096; index++)
				cueDb.writePluginEventReceipt('com.example.owner', String(index), receipt);
			cueDb.writePluginEventReceipt('com.example.other', 'kept', receipt);
			expect(cueDb.pluginEventReceiptCapacityAvailable('com.example.owner')).toBe(false);
			cueDb.closeCueDb();
			cueDb.purgePluginEventReceipts('com.example.owner', path.join(dir, 'cue.db'));
			cueDb.initCueDb(undefined, path.join(dir, 'cue.db'));
			expect(cueDb.pluginEventReceiptCapacityAvailable('com.example.owner')).toBe(true);
			expect(cueDb.readPluginEventReceipt('com.example.owner', '0')).toBeNull();
			expect(cueDb.readPluginEventReceipt('com.example.other', 'kept')).toEqual(receipt);
			cueDb.writePluginEventReceipt('com.example.owner', '0', receipt);
			expect(cueDb.readPluginEventReceipt('com.example.owner', '0')).toEqual(receipt);
		} finally {
			cueDb.closeCueDb();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe.skipIf(!canLoadBetterSqlite3())(
	'authenticated historical plugin receipt migration',
	() => {
		it('checkpoints exact HMAC evidence across reconsent/restart; rejects tamper and unknown history', async () => {
			const { AuthorizationStore } = await import('../../../main/plugins/authorization-ledger');
			const { canonicalJson } = await import('../../../shared/canonicalJson');
			const { createHash } = await import('node:crypto');
			const cue = await import('../../../main/cue/cue-db');
			const Database = (await import('better-sqlite3')).default;
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-migration-'));
			let anchor: import('../../../main/utils/keyring-anchor').Anchor | null = null;
			const deps = {
				ledgerPath: path.join(dir, 'auth.sealed'),
				seal: {
					available: () => true,
					seal: (text: string) => Buffer.from(text),
					unseal: (data: Buffer) => data.toString(),
				},
				anchor: {
					available: () => true,
					read: () => anchor,
					write: (value: typeof anchor) => {
						anchor = value;
					},
					clear: () => {
						anchor = null;
					},
				},
			};
			const store = new AuthorizationStore(deps);
			const plugin = 'com.example.owner';
			const identity = {
				contentHash: 'a'.repeat(64),
				signatureStatus: 'trusted' as const,
				signerKey: 'old-signer',
			};
			const current = { ...identity, contentHash: 'b'.repeat(64) };
			const consumer = 'consumer',
				event = 'event',
				payloadHash = 'c'.repeat(64),
				receiptId = 'd'.repeat(64);
			const id = createHash('sha256')
				.update(canonicalJson([plugin, identity, consumer, event]))
				.digest('hex');
			store.mint(plugin, [], identity);
			const row = {
				receiptId,
				payloadHash,
				proof: store.pluginEventProof(plugin, identity, { id, receiptId }, { payloadHash }),
			};
			try {
				cue.initCueDb(undefined, path.join(dir, 'cue.db'));
				cue.writePluginEventReceipt(plugin, id, row);
				const before = anchor;
				expect(cue.checkpointPluginEventReceipts(plugin, store)).toBe(1);
				expect(cue.readPluginEventReceipt(plugin, id)).toEqual(row); // preceding code still sees the blocking v1 original
				expect(anchor).toEqual(before);
				expect(cue.checkpointPluginEventReceipts(plugin, store)).toBe(0);
				expect(cue.pluginEventReceiptCapacityAvailable(plugin, { stableFormatOnly: true })).toBe(
					true
				);
				store.onPluginAuthorizationChange((id) => {
					try {
						cue.checkpointPluginEventReceipts(id, store);
					} catch {
						/* revoke remains mandatory */
					}
				});
				store.revoke(plugin);
				expect(store.readGrants(plugin)).toEqual([]);
				store.mint(plugin, [], current);
				cue.closeCueDb();
				cue.initCueDb(undefined, path.join(dir, 'cue.db'));
				const reopened = new AuthorizationStore(deps);
				expect(
					cue.readHistoricalPluginEventReceipt(
						plugin,
						current,
						consumer,
						event,
						payloadHash,
						reopened
					)
				).toBe(receiptId);
				expect(
					cue.readHistoricalPluginEventReceipt(
						plugin,
						current,
						consumer,
						'different',
						payloadHash,
						reopened
					)
				).toBeNull();
				expect(() =>
					cue.readHistoricalPluginEventReceipt(
						plugin,
						current,
						consumer,
						event,
						'e'.repeat(64),
						reopened
					)
				).toThrow();
				expect(() =>
					cue.readHistoricalPluginEventReceipt(
						plugin,
						identity,
						consumer,
						event,
						payloadHash,
						reopened
					)
				).toThrow();
				const raw = new Database(path.join(dir, 'cue.db'));
				raw
					.prepare('UPDATE cue_plugin_legacy_receipts SET receipt_id=? WHERE plugin_id=?')
					.run('f'.repeat(64), plugin);
				expect(() =>
					cue.readHistoricalPluginEventReceipt(
						plugin,
						current,
						consumer,
						event,
						payloadHash,
						reopened
					)
				).toThrow();
				raw.close();
				const unknown = 'e'.repeat(64);
				cue.writePluginEventReceipt(plugin, unknown, { ...row, proof: 'f'.repeat(64) });
				expect(cue.checkpointPluginEventReceipts(plugin, reopened)).toBe(0);
				expect(() =>
					cue.pluginEventReceiptCapacityAvailable(plugin, { stableFormatOnly: true })
				).toThrow();
				expect(cue.readPluginEventReceipt(plugin, unknown)).toEqual({
					...row,
					proof: 'f'.repeat(64),
				});
				expect(
					cue.pluginEventReceiptCapacityAvailable('com.example.other', { stableFormatOnly: true })
				).toBe(true);
			} finally {
				cue.closeCueDb();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}
);
