/**
 * Phase 15B — Cue database contract / integration tests.
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
 * real-SQLite smoke round-trip when the binary is available locally — this
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

describe('Phase 15B — cue-db in-memory contract', () => {
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

		it('initCueDb is idempotent — second call is a no-op', () => {
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
			// The failed write left no row — non-fatal, as documented.
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
	// microtasks — there's no real concurrency. What we exercise here is a
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
		it('a fresh InMemoryCueDb starts empty — documents the test-helper contract', () => {
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
			// Data MUST survive (we never clear state on close — only `ready`).
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

describe.skipIf(!canLoadBetterSqlite3())('Phase 15B — real SQLite smoke test', () => {
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
		} finally {
			if (cueDb) {
				try {
					cueDb.closeCueDb();
				} catch {
					/* best effort — double-close is safe, other errors are non-fatal here */
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
