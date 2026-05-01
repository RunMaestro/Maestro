/**
 * Query event write buffer.
 *
 * Replaces the previous one-write-per-event path on the `stats:record-query`
 * IPC channel. The renderer fires a recordQuery on every interactive turn
 * (and the auto-run path adds more on top); each fire used to do a single
 * `stmt.run()` against the stats SQLite DB. Under normal load that's many
 * synchronous writes per second on the main process's hot path.
 *
 * Mirrors the batching cadence already used elsewhere in the codebase
 * (logger 50ms, thinking-chunk 50ms — see commit `e475c0bad`):
 *
 *  - Auto-flush after FLUSH_INTERVAL_MS or when the buffer reaches BATCH_SIZE
 *  - Synchronous flush hook for app-quit so we don't lose buffered events
 *  - Single transaction per flush — better-sqlite3 wraps an arbitrary number
 *    of inserts atomically, so the per-event WAL + fsync overhead collapses
 *    into one
 *
 * The buffer is intentionally module-level (not a class). The IPC handler
 * calls `enqueueQueryEvent(db, event)`; main process registers
 * `flushQueryEventsSync()` on `app:before-quit`.
 *
 * See PR-B 1.5 and CLAUDE-PERFORMANCE.md §"Update Batching".
 */

import type Database from 'better-sqlite3';
import type { QueryEvent } from '../../shared/stats-types';
import { generateId, normalizePath, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

/** Flush when this many events accumulate. */
export const QUERY_EVENT_BATCH_SIZE = 50;
/** Auto-flush after this many ms since the first event in the current batch. */
export const QUERY_EVENT_FLUSH_INTERVAL_MS = 500;

const INSERT_SQL = `
  INSERT INTO query_events (id, session_id, agent_type, source, start_time, duration, project_path, tab_id, is_remote)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

interface PendingEvent {
	id: string;
	event: Omit<QueryEvent, 'id'>;
}

const stmtCache = new StatementCache();
let buffer: PendingEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastDb: Database.Database | null = null;

/**
 * Enqueue a query event for batched persistence.
 *
 * Returns the generated id immediately (synchronously). The actual SQL
 * INSERT happens later — when the batch fills up, the flush timer fires,
 * or `flushQueryEventsSync` is called explicitly. Callers that don't need
 * the id can ignore it.
 */
export function enqueueQueryEvent(db: Database.Database, event: Omit<QueryEvent, 'id'>): string {
	if (lastDb !== db) {
		// DB instance changed (rare — only at startup or in tests). Drop the
		// statement cache because prepared statements are bound to a DB.
		stmtCache.clear();
		lastDb = db;
	}

	const id = generateId();
	buffer.push({ id, event });

	if (buffer.length >= QUERY_EVENT_BATCH_SIZE) {
		flushQueryEventsSync();
	} else if (!flushTimer) {
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flushQueryEventsSync();
		}, QUERY_EVENT_FLUSH_INTERVAL_MS);
	}

	return id;
}

/**
 * Synchronously flush any buffered events to disk.
 *
 * Called automatically by the timer / batch threshold. Also called
 * explicitly on app-quit and when the test harness needs deterministic
 * write ordering.
 *
 * On flush failure, the buffered events are dropped (not retried). The
 * stats DB is best-effort telemetry — losing a handful of events on the
 * rare occasion the DB is unavailable is preferred to a retry loop that
 * could spin during a real DB-corruption incident.
 */
export function flushQueryEventsSync(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (!lastDb || buffer.length === 0) {
		return;
	}

	const events = buffer;
	buffer = [];

	const stmt = stmtCache.get(lastDb, INSERT_SQL);

	try {
		const tx = lastDb.transaction(() => {
			for (const { id, event } of events) {
				stmt.run(
					id,
					event.sessionId,
					event.agentType,
					event.source,
					event.startTime,
					event.duration,
					normalizePath(event.projectPath),
					event.tabId ?? null,
					event.isRemote !== undefined ? (event.isRemote ? 1 : 0) : null
				);
			}
		});
		tx();
		logger.debug(`Flushed ${events.length} query event(s)`, LOG_CONTEXT);
	} catch (err) {
		logger.error('Failed to flush query event buffer', LOG_CONTEXT, {
			count: events.length,
			error: err instanceof Error ? err.message : String(err),
		});
		// Surface to Sentry with the full Error object (not just .message) so
		// the stack trace makes it across the wire — matters for diagnosing
		// rare DB corruption / lock contention. Per CLAUDE.md §"Error
		// Handling & Sentry".
		void captureException(err instanceof Error ? err : new Error(String(err)), {
			operation: 'stats:flushQueryEventBuffer',
			count: events.length,
		});
		// Don't re-buffer — events are lost rather than risk an infinite
		// retry loop if the DB is in a permanently bad state.
	}
}

/** Number of events currently waiting to flush. Test/diagnostic helper. */
export function getQueryEventBufferSize(): number {
	return buffer.length;
}

/**
 * Reset internal state — tests only. Production has a single global buffer
 * for the lifetime of the process; tests need to reset between cases.
 */
export function resetQueryEventBufferForTests(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	buffer = [];
	stmtCache.clear();
	lastDb = null;
}
