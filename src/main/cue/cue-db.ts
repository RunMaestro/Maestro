/**
 * Cue Database — lightweight SQLite persistence for Cue events and heartbeat.
 *
 * Uses the same `better-sqlite3` pattern as `src/main/stats/stats-db.ts`.
 * Stores event history (for the activity journal) and a single-row heartbeat
 * table used by the sleep/wake reconciler to detect missed intervals.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = '[CueDB]';

// ============================================================================
// Types
// ============================================================================

export interface CueEventRecord {
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

// ============================================================================
// Schema
// ============================================================================

const CREATE_CUE_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS cue_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    trigger_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    subscription_name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    payload TEXT
  )
`;

const CREATE_CUE_EVENTS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_cue_events_created ON cue_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_cue_events_session ON cue_events(session_id)
`;

const CREATE_CUE_HEARTBEAT_SQL = `
  CREATE TABLE IF NOT EXISTS cue_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_seen INTEGER NOT NULL
  )
`;

const CREATE_CUE_GITHUB_SEEN_SQL = `
  CREATE TABLE IF NOT EXISTS cue_github_seen (
    subscription_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, item_key)
  )
`;

const CREATE_CUE_GITHUB_SEEN_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_cue_github_seen_at ON cue_github_seen(seen_at)
`;

// Phase 12A — persisted queue table. Rows here survive engine shutdown / crash
// so the queue can be reconstructed on next start. Stores the full serialized
// event plus every param needed to redispatch via runManager.execute.
const CREATE_CUE_EVENT_QUEUE_SQL = `
  CREATE TABLE IF NOT EXISTS cue_event_queue (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    subscription_name TEXT NOT NULL,
    event_json TEXT NOT NULL,
    prompt TEXT NOT NULL,
    output_prompt TEXT,
    cli_output_json TEXT,
    action TEXT,
    command_json TEXT,
    chain_depth INTEGER DEFAULT 0,
    queued_at INTEGER NOT NULL
  )
`;

const CREATE_CUE_EVENT_QUEUE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_cue_event_queue_session ON cue_event_queue(session_id);
  CREATE INDEX IF NOT EXISTS idx_cue_event_queue_queued ON cue_event_queue(queued_at)
`;

// ============================================================================
// Module State
// ============================================================================

let db: Database.Database | null = null;
let logFn: ((level: string, message: string) => void) | null = null;

function log(level: string, message: string): void {
	if (logFn) {
		logFn(level, `${LOG_CONTEXT} ${message}`);
	}
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize the Cue database. Must be called before any other operations.
 * Optionally accepts a logger callback for consistent logging with CueEngine.
 */
export function initCueDb(
	onLog?: (level: string, message: string) => void,
	dbPathOverride?: string
): void {
	if (db) return;

	if (onLog) logFn = onLog;

	const dbPath = dbPathOverride ?? path.join(app.getPath('userData'), 'cue.db');
	const dir = path.dirname(dbPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	db = new Database(dbPath);

	// Tighten permissions so only the current user can read/write the DB. On
	// NTFS/Windows POSIX modes are largely ignored (near no-op); on network
	// mounts without POSIX support chmod can throw EPERM/ENOTSUP. Either way
	// this is best-effort — log and continue rather than failing DB init.
	try {
		fs.chmodSync(dbPath, 0o600);
	} catch (err) {
		log(
			'warn',
			`chmod 0o600 failed on ${dbPath}: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	db.pragma('journal_mode = WAL');

	// Create tables
	db.prepare(CREATE_CUE_EVENTS_SQL).run();
	for (const sql of CREATE_CUE_EVENTS_INDEXES_SQL.split(';').filter((s) => s.trim())) {
		db.prepare(sql).run();
	}
	db.prepare(CREATE_CUE_HEARTBEAT_SQL).run();
	db.prepare(CREATE_CUE_GITHUB_SEEN_SQL).run();
	db.prepare(CREATE_CUE_GITHUB_SEEN_INDEX_SQL).run();
	db.prepare(CREATE_CUE_EVENT_QUEUE_SQL).run();
	for (const sql of CREATE_CUE_EVENT_QUEUE_INDEXES_SQL.split(';').filter((s) => s.trim())) {
		db.prepare(sql).run();
	}

	log('info', `Cue database initialized at ${dbPath}`);
}

/**
 * Close the Cue database connection.
 */
export function closeCueDb(): void {
	if (db) {
		db.close();
		db = null;
		log('info', 'Cue database closed');
	}
}

/**
 * Check if the Cue database is initialized and ready.
 */
export function isCueDbReady(): boolean {
	return db !== null;
}

// ============================================================================
// Internal accessor
// ============================================================================

function getDb(): Database.Database {
	if (!db) throw new Error('Cue database not initialized — call initCueDb() first');
	return db;
}

// ============================================================================
// Event Journal
// ============================================================================

/**
 * Record a new Cue event in the journal.
 */
export function recordCueEvent(event: {
	id: string;
	type: string;
	triggerName: string;
	sessionId: string;
	subscriptionName: string;
	status: string;
	payload?: string;
}): void {
	getDb()
		.prepare(
			`INSERT OR REPLACE INTO cue_events (id, type, trigger_name, session_id, subscription_name, status, created_at, payload)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			event.id,
			event.type,
			event.triggerName,
			event.sessionId,
			event.subscriptionName,
			event.status,
			Date.now(),
			event.payload ?? null
		);
}

/**
 * Update the status (and optionally completed_at) of a previously recorded event.
 */
export function updateCueEventStatus(id: string, status: string): void {
	getDb()
		.prepare(`UPDATE cue_events SET status = ?, completed_at = ? WHERE id = ?`)
		.run(status, Date.now(), id);
}

/**
 * Safe wrapper: records a Cue event; logs warn on failure instead of throwing.
 * Non-fatal — callers must not rely on successful persistence.
 */
export function safeRecordCueEvent(event: Parameters<typeof recordCueEvent>[0]): void {
	try {
		recordCueEvent(event);
	} catch (err) {
		log(
			'warn',
			`Failed to record Cue event (id=${event.id}): ${err instanceof Error ? err.message : String(err)}`
		);
		// Persist warns to Sentry too — DB write failures here are silent at
		// runtime (callers must remain non-fatal) but accumulate observability
		// gaps if not surfaced; keep returning without throwing.
		// Strip event.payload before reporting: for agent.completed runs it
		// contains the upstream agent's stdout (sourceOutput), which can carry
		// user content / secrets. Send only identifiers + size.
		const sanitizedEvent = {
			id: event.id,
			type: event.type,
			triggerName: event.triggerName,
			sessionId: event.sessionId,
			subscriptionName: event.subscriptionName,
			status: event.status,
			payloadSize: event.payload?.length ?? 0,
			payloadRedacted: event.payload != null,
		};
		captureException(err, { operation: 'safeRecordCueEvent', event: sanitizedEvent });
	}
}

/**
 * Safe wrapper: updates Cue event status; logs warn on failure instead of throwing.
 * Non-fatal — callers must not rely on successful persistence.
 */
export function safeUpdateCueEventStatus(id: string, status: string): void {
	try {
		updateCueEventStatus(id, status);
	} catch (err) {
		log(
			'warn',
			`Failed to update Cue event status (id=${id}, status=${status}): ${err instanceof Error ? err.message : String(err)}`
		);
		captureException(err, { operation: 'safeUpdateCueEventStatus', id, status });
	}
}

/**
 * Retrieve recent Cue events created after a given timestamp.
 */
export function getRecentCueEvents(since: number, limit?: number): CueEventRecord[] {
	const sql = limit
		? `SELECT * FROM cue_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`
		: `SELECT * FROM cue_events WHERE created_at >= ? ORDER BY created_at DESC`;

	const rows = (
		limit ? getDb().prepare(sql).all(since, limit) : getDb().prepare(sql).all(since)
	) as Array<{
		id: string;
		type: string;
		trigger_name: string;
		session_id: string;
		subscription_name: string;
		status: string;
		created_at: number;
		completed_at: number | null;
		payload: string | null;
	}>;

	return rows.map((row) => ({
		id: row.id,
		type: row.type,
		triggerName: row.trigger_name,
		sessionId: row.session_id,
		subscriptionName: row.subscription_name,
		status: row.status,
		createdAt: row.created_at,
		completedAt: row.completed_at,
		payload: row.payload,
	}));
}

// ============================================================================
// Heartbeat
// ============================================================================

/**
 * Write the current timestamp as the heartbeat. Uses an upsert on the
 * single-row heartbeat table (id = 1).
 */
export function updateHeartbeat(): void {
	getDb()
		.prepare(`INSERT OR REPLACE INTO cue_heartbeat (id, last_seen) VALUES (1, ?)`)
		.run(Date.now());
}

/**
 * Read the last-seen heartbeat timestamp, or null if none exists.
 */
export function getLastHeartbeat(): number | null {
	const row = getDb().prepare(`SELECT last_seen FROM cue_heartbeat WHERE id = 1`).get() as
		| { last_seen: number }
		| undefined;
	return row?.last_seen ?? null;
}

// ============================================================================
// Housekeeping
// ============================================================================

/**
 * Delete events older than the specified age in milliseconds.
 */
export function pruneCueEvents(olderThanMs: number): void {
	const cutoff = Date.now() - olderThanMs;
	const result = getDb().prepare(`DELETE FROM cue_events WHERE created_at < ?`).run(cutoff);
	if (result.changes > 0) {
		log('info', `Pruned ${result.changes} old Cue event(s)`);
	}
}

// ============================================================================
// GitHub Seen Tracking
// ============================================================================

/**
 * Check if a GitHub item has been seen for a given subscription.
 */
export function isGitHubItemSeen(subscriptionId: string, itemKey: string): boolean {
	const row = getDb()
		.prepare(`SELECT 1 FROM cue_github_seen WHERE subscription_id = ? AND item_key = ?`)
		.get(subscriptionId, itemKey);
	return row !== undefined;
}

/**
 * Mark a GitHub item as seen for a given subscription.
 */
export function markGitHubItemSeen(subscriptionId: string, itemKey: string): void {
	getDb()
		.prepare(
			`INSERT OR IGNORE INTO cue_github_seen (subscription_id, item_key, seen_at) VALUES (?, ?, ?)`
		)
		.run(subscriptionId, itemKey, Date.now());
}

/**
 * Check if any GitHub items have been seen for a subscription.
 * Used for first-run seeding detection.
 */
export function hasAnyGitHubSeen(subscriptionId: string): boolean {
	const row = getDb()
		.prepare(`SELECT 1 FROM cue_github_seen WHERE subscription_id = ? LIMIT 1`)
		.get(subscriptionId);
	return row !== undefined;
}

/**
 * Delete GitHub seen records older than the specified age in milliseconds.
 */
export function pruneGitHubSeen(olderThanMs: number): void {
	const cutoff = Date.now() - olderThanMs;
	const result = getDb().prepare(`DELETE FROM cue_github_seen WHERE seen_at < ?`).run(cutoff);
	if (result.changes > 0) {
		log('info', `Pruned ${result.changes} old GitHub seen record(s)`);
	}
}

/**
 * Delete all GitHub seen records for a subscription.
 */
export function clearGitHubSeenForSubscription(subscriptionId: string): void {
	getDb().prepare(`DELETE FROM cue_github_seen WHERE subscription_id = ?`).run(subscriptionId);
}

// ============================================================================
// Phase 12A — Queue Persistence
// ============================================================================

export interface CueQueuedEventRecord {
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

/** Persist a queued event. Throws on DB failure — use safePersistQueuedEvent for
 *  non-fatal semantics in the run-manager hot path. */
export function persistQueuedEvent(record: CueQueuedEventRecord): void {
	getDb()
		.prepare(
			`INSERT OR REPLACE INTO cue_event_queue
			 (id, session_id, subscription_name, event_json, prompt, output_prompt,
			  cli_output_json, action, command_json, chain_depth, queued_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			record.id,
			record.sessionId,
			record.subscriptionName,
			record.eventJson,
			record.prompt,
			record.outputPrompt,
			record.cliOutputJson,
			record.action,
			record.commandJson,
			record.chainDepth,
			record.queuedAt
		);
}

/** Remove a persisted queued event by id. Missing rows are a no-op (matches
 *  the in-memory queue's tolerance for races between persist and drain). */
export function removeQueuedEvent(id: string): void {
	getDb().prepare(`DELETE FROM cue_event_queue WHERE id = ?`).run(id);
}

/** Fetch persisted queue entries. Scoped to a session if provided, or the full
 *  queue across all sessions when called without arguments. Rows are returned
 *  ordered by `queued_at ASC` so restore preserves FIFO semantics. */
export function getQueuedEvents(sessionId?: string): CueQueuedEventRecord[] {
	const rows = (
		sessionId
			? getDb()
					.prepare(`SELECT * FROM cue_event_queue WHERE session_id = ? ORDER BY queued_at ASC`)
					.all(sessionId)
			: getDb().prepare(`SELECT * FROM cue_event_queue ORDER BY queued_at ASC`).all()
	) as Array<{
		id: string;
		session_id: string;
		subscription_name: string;
		event_json: string;
		prompt: string;
		output_prompt: string | null;
		cli_output_json: string | null;
		action: string | null;
		command_json: string | null;
		chain_depth: number;
		queued_at: number;
	}>;

	return rows.map((row) => ({
		id: row.id,
		sessionId: row.session_id,
		subscriptionName: row.subscription_name,
		eventJson: row.event_json,
		prompt: row.prompt,
		outputPrompt: row.output_prompt,
		cliOutputJson: row.cli_output_json,
		action: row.action,
		commandJson: row.command_json,
		chainDepth: row.chain_depth,
		queuedAt: row.queued_at,
	}));
}

/** Clear persisted queue for a session, or the entire persisted queue when
 *  called without arguments. Used by stopAll/reset to drop every trace of the
 *  in-memory queue from disk. */
export function clearPersistedQueue(sessionId?: string): void {
	if (sessionId) {
		getDb().prepare(`DELETE FROM cue_event_queue WHERE session_id = ?`).run(sessionId);
	} else {
		getDb().prepare(`DELETE FROM cue_event_queue`).run();
	}
}

/** Safe wrapper: persist a queued event; logs warn and reports to Sentry on
 *  failure instead of throwing. The in-memory queue is unaffected by a failed
 *  persist — the only loss surface is app crash before a successful persist. */
export function safePersistQueuedEvent(record: CueQueuedEventRecord): void {
	try {
		persistQueuedEvent(record);
	} catch (err) {
		log(
			'warn',
			`Failed to persist queued event (id=${record.id}): ${err instanceof Error ? err.message : String(err)}`
		);
		// Strip prompt + payload before reporting — they may carry user content.
		const sanitized = {
			id: record.id,
			sessionId: record.sessionId,
			subscriptionName: record.subscriptionName,
			action: record.action,
			chainDepth: record.chainDepth,
			promptLen: record.prompt.length,
			outputPromptLen: record.outputPrompt?.length ?? 0,
			eventJsonLen: record.eventJson.length,
		};
		captureException(err, { operation: 'safePersistQueuedEvent', record: sanitized });
	}
}

/** Safe wrapper: remove a persisted queued event by id; non-throwing. */
export function safeRemoveQueuedEvent(id: string): void {
	try {
		removeQueuedEvent(id);
	} catch (err) {
		log(
			'warn',
			`Failed to remove queued event (id=${id}): ${err instanceof Error ? err.message : String(err)}`
		);
		captureException(err, { operation: 'safeRemoveQueuedEvent', id });
	}
}
