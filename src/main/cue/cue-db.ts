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
	db.pragma('journal_mode = WAL');

	// Create tables
	db.prepare(CREATE_CUE_EVENTS_SQL).run();
	for (const sql of CREATE_CUE_EVENTS_INDEXES_SQL.split(';').filter((s) => s.trim())) {
		db.prepare(sql).run();
	}
	db.prepare(CREATE_CUE_HEARTBEAT_SQL).run();

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
