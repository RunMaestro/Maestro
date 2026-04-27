/**
 * Phase 15B — Integration test helpers.
 *
 * Exported utilities:
 *
 * - `createInMemoryCueDb()` — a high-fidelity in-memory implementation of
 *   the cue-db module contract. `better-sqlite3` is a native module compiled
 *   against Electron's ABI and does not load under vitest's Node runtime, so
 *   we cannot exercise real SQL in integration tests. Instead we mirror the
 *   module's public API (recordCueEvent / updateCueEventStatus /
 *   getRecentCueEvents / updateHeartbeat / pruneCueEvents /
 *   markGitHubItemSeen / isGitHubItemSeen / etc.) with plain data structures
 *   that preserve the SQL semantics cue-engine actually depends on: insert
 *   ordering, UNIQUE constraints (cue_github_seen), prune-by-age, and
 *   heartbeat upsert (single-row id=1). Exposes `setNowOverride`,
 *   `queueWriteFailure`, and `resetAll` for deterministic test control.
 *
 * - `buildCueDbModuleMock(getDb)` — a factory returning a module-shape object
 *   that delegates every cue-db function to the supplied InMemoryCueDb.
 *   Designed for `vi.mock('.../cue-db', () => buildCueDbModuleMock(() =>
 *   sharedDb))` — the lazy `getDb` getter accommodates vi.mock's hoisting,
 *   where the factory runs before any top-level `let sharedDb` has executed.
 *
 * - `canLoadBetterSqlite3()` — probe-instantiates a `:memory:` database so a
 *   `describe.skipIf(!canLoadBetterSqlite3())` block reflects the native
 *   binary's real availability. A plain `require('better-sqlite3')` returns
 *   true even when the prebuilt binary is ABI-mismatched (compiled for
 *   Electron's Node version, not vitest's); probing catches that.
 *
 * - `createOnCueRunSpy(defaultResponse?)` — a lightweight spy for the
 *   engine's `onCueRun` boundary callback, capturing a per-call summary
 *   (runId, sessionId, subscriptionName, prompt, event) so integration tests
 *   can assert the dispatch payload without re-reading every vi.fn() call
 *   tuple.
 *
 * Typical usage (from `cue-engine-integration.test.ts`):
 *
 *   let sharedDb: InMemoryCueDb | null = null;
 *   function getSharedDb() {
 *     if (!sharedDb) sharedDb = createInMemoryCueDb();
 *     return sharedDb;
 *   }
 *   vi.mock('../../../main/cue/cue-db', () =>
 *     buildCueDbModuleMock(() => getSharedDb())
 *   );
 */

import { vi } from 'vitest';
import type { CueEventRecord } from '../../../main/cue/cue-db';

// ────────────────────────────────────────────────────────────────────────────
// InMemoryCueDb — high-fidelity contract mirror of cue-db.ts
// ────────────────────────────────────────────────────────────────────────────

/**
 * Internal event row — mirrors the cue_events table's column set. Stored in
 * insertion order via a Map keyed by id, plus an array of ids so we can do
 * ORDER BY created_at DESC + LIMIT lookups without re-sorting on every read.
 */
interface InMemoryCueEventRow {
	id: string;
	type: string;
	triggerName: string;
	sessionId: string;
	subscriptionName: string;
	status: string;
	createdAt: number;
	completedAt: number | null;
	payload: string | null;
}

/** Phase 12A queue persistence row. */
export interface InMemoryCueQueueRow {
	id: string;
	sessionId: string;
	subscriptionName: string;
	eventJson: string;
	prompt: string;
	outputPrompt: string | null;
	cliOutputJson: string | null;
	action: string | null;
	commandJson: string | null;
	chainDepth: number;
	queuedAt: number;
}

export interface InMemoryCueDbState {
	events: Map<string, InMemoryCueEventRow>;
	/** Insertion order of event IDs, for ORDER BY created_at DESC semantics. */
	eventOrder: string[];
	heartbeat: number | null;
	githubSeen: Map<string, number>; // key = `${subscriptionId}\0${itemKey}`
	/** Phase 12A persistent queue rows, keyed by row id. Insertion order preserved. */
	queueRows: Map<string, InMemoryCueQueueRow>;
	closed: boolean;
	ready: boolean;
}

export interface InMemoryCueDb {
	// State accessors — for assertion convenience in tests.
	readonly state: InMemoryCueDbState;
	// Lifecycle
	initCueDb(onLog?: (level: string, msg: string) => void, dbPathOverride?: string): void;
	closeCueDb(): void;
	isCueDbReady(): boolean;
	// Events
	recordCueEvent(event: {
		id: string;
		type: string;
		triggerName: string;
		sessionId: string;
		subscriptionName: string;
		status: string;
		payload?: string;
	}): void;
	updateCueEventStatus(id: string, status: string): void;
	getRecentCueEvents(since: number, limit?: number): CueEventRecord[];
	safeRecordCueEvent(event: Parameters<InMemoryCueDb['recordCueEvent']>[0]): void;
	safeUpdateCueEventStatus(id: string, status: string): void;
	// Heartbeat
	updateHeartbeat(): void;
	getLastHeartbeat(): number | null;
	// Housekeeping
	pruneCueEvents(olderThanMs: number): void;
	// GitHub seen set
	isGitHubItemSeen(subscriptionId: string, itemKey: string): boolean;
	markGitHubItemSeen(subscriptionId: string, itemKey: string): void;
	hasAnyGitHubSeen(subscriptionId: string): boolean;
	pruneGitHubSeen(olderThanMs: number): void;
	clearGitHubSeenForSubscription(subscriptionId: string): void;
	// Phase 12A queue persistence
	persistQueuedEvent(record: InMemoryCueQueueRow): void;
	removeQueuedEvent(id: string): void;
	getQueuedEvents(sessionId?: string): InMemoryCueQueueRow[];
	clearPersistedQueue(sessionId?: string): void;
	safePersistQueuedEvent(record: InMemoryCueQueueRow): void;
	safeRemoveQueuedEvent(id: string): void;
	// Test-only controls
	/** Force a specific current time for prune/heartbeat tests. Reset with clearNowOverride(). */
	setNowOverride(ts: number): void;
	clearNowOverride(): void;
	/** Force the next write to throw — exercises safe-wrapper warn paths. */
	queueWriteFailure(err?: Error): void;
	resetAll(): void;
}

/**
 * Create a fresh in-memory Cue DB. Each test should create its own instance
 * (or call `resetAll()` in `beforeEach`) to avoid cross-test leakage.
 */
export function createInMemoryCueDb(): InMemoryCueDb {
	const state: InMemoryCueDbState = {
		events: new Map(),
		eventOrder: [],
		heartbeat: null,
		githubSeen: new Map(),
		queueRows: new Map(),
		closed: true,
		ready: false,
	};
	let nowOverride: number | null = null;
	let pendingFailure: Error | null = null;

	function now(): number {
		return nowOverride ?? Date.now();
	}

	function githubKey(subscriptionId: string, itemKey: string): string {
		return `${subscriptionId}\u0000${itemKey}`;
	}

	function requireReady(): void {
		if (!state.ready) {
			throw new Error('Cue database not initialized — call initCueDb() first');
		}
	}

	function consumePendingFailure(): void {
		if (pendingFailure) {
			const err = pendingFailure;
			pendingFailure = null;
			throw err;
		}
	}

	return {
		state,

		initCueDb(_onLog, _dbPathOverride) {
			// Idempotent — matches the real module's short-circuit on re-init.
			if (state.ready) return;
			state.ready = true;
			state.closed = false;
		},

		closeCueDb() {
			state.ready = false;
			state.closed = true;
		},

		isCueDbReady() {
			return state.ready;
		},

		recordCueEvent(event) {
			requireReady();
			consumePendingFailure();
			// `INSERT OR REPLACE` semantics: duplicate id overwrites the row and
			// moves it to the end of insertion order (real SQL would re-assign
			// the same PK row in place, but ordering is what we test for, and
			// upsert-with-move is close enough for assertions).
			const existedBefore = state.events.has(event.id);
			state.events.set(event.id, {
				id: event.id,
				type: event.type,
				triggerName: event.triggerName,
				sessionId: event.sessionId,
				subscriptionName: event.subscriptionName,
				status: event.status,
				createdAt: now(),
				completedAt: null,
				payload: event.payload ?? null,
			});
			if (existedBefore) {
				// Move id to end of order array.
				const idx = state.eventOrder.indexOf(event.id);
				if (idx >= 0) state.eventOrder.splice(idx, 1);
			}
			state.eventOrder.push(event.id);
		},

		updateCueEventStatus(id, status) {
			requireReady();
			consumePendingFailure();
			const row = state.events.get(id);
			if (!row) {
				// Real SQL is a silent no-op when WHERE id=? matches nothing.
				// Preserve that — don't throw.
				return;
			}
			row.status = status;
			row.completedAt = now();
		},

		getRecentCueEvents(since, limit) {
			requireReady();
			// ORDER BY created_at DESC, filter by created_at >= since.
			const rows = state.eventOrder
				.map((id) => state.events.get(id)!)
				.filter((row) => row.createdAt >= since)
				.sort((a, b) => b.createdAt - a.createdAt);

			const sliced = limit !== undefined ? rows.slice(0, limit) : rows;
			return sliced.map((row) => ({ ...row }));
		},

		safeRecordCueEvent(event) {
			try {
				this.recordCueEvent(event);
			} catch {
				// Silent-but-logged in the real module; tests just need the
				// no-throw behavior.
			}
		},

		safeUpdateCueEventStatus(id, status) {
			try {
				this.updateCueEventStatus(id, status);
			} catch {
				// Same contract as safeRecordCueEvent — non-throwing.
			}
		},

		updateHeartbeat() {
			requireReady();
			consumePendingFailure();
			// Upsert on single-row id=1 — just replace the scalar.
			state.heartbeat = now();
		},

		getLastHeartbeat() {
			requireReady();
			return state.heartbeat;
		},

		pruneCueEvents(olderThanMs) {
			requireReady();
			const cutoff = now() - olderThanMs;
			const keepOrder: string[] = [];
			for (const id of state.eventOrder) {
				const row = state.events.get(id);
				if (!row) continue;
				if (row.createdAt < cutoff) {
					state.events.delete(id);
				} else {
					keepOrder.push(id);
				}
			}
			state.eventOrder.length = 0;
			state.eventOrder.push(...keepOrder);
		},

		isGitHubItemSeen(subscriptionId, itemKey) {
			requireReady();
			return state.githubSeen.has(githubKey(subscriptionId, itemKey));
		},

		markGitHubItemSeen(subscriptionId, itemKey) {
			requireReady();
			consumePendingFailure();
			// INSERT OR IGNORE — only inserts if not already present.
			const key = githubKey(subscriptionId, itemKey);
			if (!state.githubSeen.has(key)) {
				state.githubSeen.set(key, now());
			}
		},

		hasAnyGitHubSeen(subscriptionId) {
			requireReady();
			const prefix = `${subscriptionId}\u0000`;
			for (const key of state.githubSeen.keys()) {
				if (key.startsWith(prefix)) return true;
			}
			return false;
		},

		pruneGitHubSeen(olderThanMs) {
			requireReady();
			const cutoff = now() - olderThanMs;
			for (const [key, seenAt] of [...state.githubSeen.entries()]) {
				if (seenAt < cutoff) state.githubSeen.delete(key);
			}
		},

		clearGitHubSeenForSubscription(subscriptionId) {
			requireReady();
			const prefix = `${subscriptionId}\u0000`;
			for (const key of [...state.githubSeen.keys()]) {
				if (key.startsWith(prefix)) state.githubSeen.delete(key);
			}
		},

		setNowOverride(ts) {
			nowOverride = ts;
		},

		clearNowOverride() {
			nowOverride = null;
		},

		queueWriteFailure(err) {
			pendingFailure = err ?? new Error('Simulated DB write failure');
		},

		// ── Phase 12A — queue persistence ──────────────────────────────────
		persistQueuedEvent(record) {
			requireReady();
			consumePendingFailure();
			state.queueRows.set(record.id, { ...record });
		},

		removeQueuedEvent(id) {
			requireReady();
			state.queueRows.delete(id);
		},

		getQueuedEvents(sessionId) {
			requireReady();
			const rows = Array.from(state.queueRows.values());
			const filtered = sessionId ? rows.filter((r) => r.sessionId === sessionId) : rows;
			return filtered.sort((a, b) => a.queuedAt - b.queuedAt);
		},

		clearPersistedQueue(sessionId) {
			requireReady();
			if (!sessionId) {
				state.queueRows.clear();
				return;
			}
			for (const [id, row] of state.queueRows) {
				if (row.sessionId === sessionId) state.queueRows.delete(id);
			}
		},

		safePersistQueuedEvent(record) {
			try {
				this.persistQueuedEvent(record);
			} catch {
				// non-throwing
			}
		},

		safeRemoveQueuedEvent(id) {
			try {
				this.removeQueuedEvent(id);
			} catch {
				// non-throwing
			}
		},

		resetAll() {
			state.events.clear();
			state.eventOrder.length = 0;
			state.heartbeat = null;
			state.githubSeen.clear();
			state.queueRows.clear();
			state.closed = true;
			state.ready = false;
			nowOverride = null;
			pendingFailure = null;
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Factory: mocks the `cue-db` module to delegate to an InMemoryCueDb instance.
// Use in test files via:
//
//   const sharedDb = createInMemoryCueDb();
//   vi.mock('../../../main/cue/cue-db', () => buildCueDbModuleMock(() => sharedDb));
//
// The () => sharedDb indirection lets the mock factory tolerate the test file's
// hoisting order — vi.mock factories run before any `import`, so the shared
// instance has to be constructed lazily on first access.
// ────────────────────────────────────────────────────────────────────────────

export function buildCueDbModuleMock(getDb: () => InMemoryCueDb) {
	return {
		initCueDb: (onLog?: (level: string, msg: string) => void, dbPathOverride?: string) =>
			getDb().initCueDb(onLog, dbPathOverride),
		closeCueDb: () => getDb().closeCueDb(),
		isCueDbReady: () => getDb().isCueDbReady(),
		recordCueEvent: (event: Parameters<InMemoryCueDb['recordCueEvent']>[0]) =>
			getDb().recordCueEvent(event),
		updateCueEventStatus: (id: string, status: string) => getDb().updateCueEventStatus(id, status),
		getRecentCueEvents: (since: number, limit?: number) => getDb().getRecentCueEvents(since, limit),
		safeRecordCueEvent: (event: Parameters<InMemoryCueDb['recordCueEvent']>[0]) =>
			getDb().safeRecordCueEvent(event),
		safeUpdateCueEventStatus: (id: string, status: string) =>
			getDb().safeUpdateCueEventStatus(id, status),
		updateHeartbeat: () => getDb().updateHeartbeat(),
		getLastHeartbeat: () => getDb().getLastHeartbeat(),
		pruneCueEvents: (olderThanMs: number) => getDb().pruneCueEvents(olderThanMs),
		isGitHubItemSeen: (subscriptionId: string, itemKey: string) =>
			getDb().isGitHubItemSeen(subscriptionId, itemKey),
		markGitHubItemSeen: (subscriptionId: string, itemKey: string) =>
			getDb().markGitHubItemSeen(subscriptionId, itemKey),
		hasAnyGitHubSeen: (subscriptionId: string) => getDb().hasAnyGitHubSeen(subscriptionId),
		pruneGitHubSeen: (olderThanMs: number) => getDb().pruneGitHubSeen(olderThanMs),
		clearGitHubSeenForSubscription: (subscriptionId: string) =>
			getDb().clearGitHubSeenForSubscription(subscriptionId),
		// Phase 12A queue persistence
		persistQueuedEvent: (record: InMemoryCueQueueRow) => getDb().persistQueuedEvent(record),
		removeQueuedEvent: (id: string) => getDb().removeQueuedEvent(id),
		getQueuedEvents: (sessionId?: string) => getDb().getQueuedEvents(sessionId),
		clearPersistedQueue: (sessionId?: string) => getDb().clearPersistedQueue(sessionId),
		safePersistQueuedEvent: (record: InMemoryCueQueueRow) => getDb().safePersistQueuedEvent(record),
		safeRemoveQueuedEvent: (id: string) => getDb().safeRemoveQueuedEvent(id),
	};
}

// ────────────────────────────────────────────────────────────────────────────
// canLoadBetterSqlite3 — lets Phase 15B add an optional smoke test against
// the real native module when it happens to be available (local dev on the
// same Node version as Electron). CI without a matching binary just skips.
// ────────────────────────────────────────────────────────────────────────────

export function canLoadBetterSqlite3(): boolean {
	// We check this lazily because `import` would fail loudly at module-eval
	// time if the binary is missing, which defeats the purpose of the
	// conditional. Also: `require('better-sqlite3')` alone is NOT enough —
	// the package resolves fine but `new Database()` may still throw
	// NODE_MODULE_VERSION mismatch when the binary was compiled against
	// Electron's ABI and we're running under plain Node. Instantiate against
	// an in-memory DB to catch the real failure mode.
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const Database = require('better-sqlite3');
		const probe = new Database(':memory:');
		probe.close();
		return true;
	} catch {
		return false;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Minimal wired-engine helpers — shared by cue-engine-integration.test.ts.
// ────────────────────────────────────────────────────────────────────────────

export interface WiredOnCueRunCall {
	runId: string;
	sessionId: string;
	subscriptionName: string;
	prompt: string;
	event: unknown;
}

export function createOnCueRunSpy(
	defaultResponse: () => Promise<unknown> = async () => ({
		runId: 'default',
		sessionId: 'session-1',
		sessionName: 'Session 1',
		subscriptionName: 'default',
		event: {
			id: 'evt',
			type: 'time.heartbeat',
			triggerName: 'default',
			timestamp: '',
			payload: {},
		},
		status: 'completed',
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 1,
		startedAt: '',
		endedAt: '',
	})
) {
	const calls: WiredOnCueRunCall[] = [];
	const fn = vi.fn(async (req: WiredOnCueRunCall) => {
		calls.push({
			runId: req.runId,
			sessionId: req.sessionId,
			subscriptionName: req.subscriptionName,
			prompt: req.prompt,
			event: req.event,
		});
		return (await defaultResponse()) as ReturnType<typeof fn> extends Promise<infer U> ? U : never;
	});
	return { fn, calls };
}
