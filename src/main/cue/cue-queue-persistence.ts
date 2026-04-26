/**
 * Cue Queue Persistence — Phase 12A.
 *
 * Thin façade over cue-db's queue-row CRUD that owns serialization and
 * rehydration. Lets cue-run-manager stay narrowly focused on concurrency and
 * keeps the JSON shape of queued events in one place.
 *
 * Fail-open: every persist / remove / clear call uses the non-throwing
 * safe-wrapper variants so a DB failure degrades to "live only" rather than
 * breaking the queue. Restore skips and eagerly deletes malformed rows so a
 * single corrupt entry can't poison the whole queue across restarts.
 */

import type { MainLogLevel } from '../../shared/logger-types';
import type { CueLogPayload } from '../../shared/cue-log-types';
import type { CueCommand, CueEvent, CueSubscription } from './cue-types';
import {
	getQueuedEvents,
	clearPersistedQueue,
	safePersistQueuedEvent,
	safeRemoveQueuedEvent,
	safeRecordCueEvent,
	type CueQueuedEventRecord,
} from './cue-db';
import { captureException } from '../utils/sentry';

/** Shape matching cue-run-manager's QueuedEvent (subset — only what's persisted). */
export interface PersistableQueueEntry {
	event: CueEvent;
	subscriptionName: string;
	prompt: string;
	outputPrompt?: string;
	cliOutput?: { target: string };
	action?: CueSubscription['action'];
	command?: CueCommand;
	chainDepth?: number;
	queuedAt: number;
}

export interface RestoredQueueEntry extends PersistableQueueEntry {
	persistId: string;
}

export interface CueQueuePersistence {
	persist(sessionId: string, persistId: string, entry: PersistableQueueEntry): void;
	remove(persistId: string): void;
	clearSession(sessionId: string): void;
	clearAll(): void;
	restoreAll(): Map<string, RestoredQueueEntry[]>;
}

export interface CueQueuePersistenceDeps {
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	/** Per-session timeout — used to discard stale rows at restore time. */
	getSessionTimeoutMs: (sessionId: string) => number;
	/** Membership check: drop persisted entries whose session is no longer registered. */
	knownSessionIds: () => Set<string>;
	/** Override for testing — defaults to Date.now. */
	now?: () => number;
}

export function createCueQueuePersistence(deps: CueQueuePersistenceDeps): CueQueuePersistence {
	const now = deps.now ?? (() => Date.now());

	function persist(sessionId: string, persistId: string, entry: PersistableQueueEntry): void {
		const record: CueQueuedEventRecord = {
			id: persistId,
			sessionId,
			subscriptionName: entry.subscriptionName,
			eventJson: JSON.stringify(entry.event),
			prompt: entry.prompt,
			outputPrompt: entry.outputPrompt ?? null,
			cliOutputJson: entry.cliOutput ? JSON.stringify(entry.cliOutput) : null,
			action: entry.action ?? null,
			commandJson: entry.command ? JSON.stringify(entry.command) : null,
			chainDepth: entry.chainDepth ?? 0,
			queuedAt: entry.queuedAt,
		};
		safePersistQueuedEvent(record);
	}

	function remove(persistId: string): void {
		safeRemoveQueuedEvent(persistId);
	}

	function clearSession(sessionId: string): void {
		try {
			clearPersistedQueue(sessionId);
		} catch (err) {
			void captureException(err, {
				operation: 'cueQueuePersistence.clearSession',
				sessionId,
			});
			deps.onLog(
				'warn',
				`[CUE] Failed to clear persisted queue for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	function clearAll(): void {
		try {
			clearPersistedQueue();
		} catch (err) {
			void captureException(err, { operation: 'cueQueuePersistence.clearAll' });
			deps.onLog(
				'warn',
				`[CUE] Failed to clear all persisted queue: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	function restoreAll(): Map<string, RestoredQueueEntry[]> {
		let rows: CueQueuedEventRecord[];
		try {
			rows = getQueuedEvents();
		} catch (err) {
			void captureException(err, { operation: 'cueQueuePersistence.restoreAll' });
			deps.onLog(
				'warn',
				`[CUE] Failed to read persisted queue — starting empty: ${err instanceof Error ? err.message : String(err)}`
			);
			return new Map();
		}

		const currentTime = now();
		const knownSessions = deps.knownSessionIds();
		const restored = new Map<string, RestoredQueueEntry[]>();
		let droppedStale = 0;
		let droppedMalformed = 0;
		let droppedMissingSession = 0;

		/**
		 * Record a restore-path drop in `cue_events` so users see WHY a
		 * queued run never fired. Wrapped in try/catch so a DB write failure
		 * during restore doesn't abort the entire restore loop.
		 *
		 * The event's `status` column is typed as CueRunStatus downstream, so
		 * all restore drops are persisted as 'timeout' (the closest valid
		 * run-status for "was queued, never ran"). The precise drop cause
		 * lives in the payload under `reason`, matching the CueLogPayload
		 * `queueDropped` reason enum.
		 */
		function recordRestoredDrop(
			row: CueQueuedEventRecord,
			reason: 'stale' | 'malformed' | 'session-missing',
			extraPayload: Record<string, unknown> = {}
		): void {
			try {
				safeRecordCueEvent({
					id: row.id,
					type: 'restored',
					triggerName: row.subscriptionName,
					sessionId: row.sessionId,
					subscriptionName: row.subscriptionName,
					status: 'timeout',
					payload: JSON.stringify({ droppedFromQueue: true, reason, ...extraPayload }),
				});
			} catch {
				// safeRecordCueEvent already reports to Sentry; swallow here.
			}
		}

		for (const row of rows) {
			// Drop rows whose session is no longer registered — they'd just be
			// dead weight in the DB otherwise. Record the drop so a user
			// inspecting history after deleting/recreating a session still
			// sees what happened to their queued events.
			if (!knownSessions.has(row.sessionId)) {
				recordRestoredDrop(row, 'session-missing');
				safeRemoveQueuedEvent(row.id);
				droppedMissingSession++;
				continue;
			}

			// Staleness check (mirrors cue-run-manager's runtime drainQueue check).
			const ageMs = currentTime - row.queuedAt;
			const timeoutMs = deps.getSessionTimeoutMs(row.sessionId);
			if (timeoutMs > 0 && ageMs > timeoutMs) {
				recordRestoredDrop(row, 'stale', { queuedForMs: ageMs });
				safeRemoveQueuedEvent(row.id);
				droppedStale++;
				continue;
			}

			// Deserialize. Any JSON failure is a data integrity problem — drop the
			// row so it doesn't stall restore every time the engine starts.
			let event: CueEvent;
			let cliOutput: { target: string } | undefined;
			let command: CueCommand | undefined;
			try {
				event = JSON.parse(row.eventJson);
				cliOutput = row.cliOutputJson ? JSON.parse(row.cliOutputJson) : undefined;
				command = row.commandJson ? JSON.parse(row.commandJson) : undefined;
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				deps.onLog(
					'warn',
					`[CUE] Dropping malformed persisted queue row (id=${row.id}): ${errorMessage}`
				);
				recordRestoredDrop(row, 'malformed', {
					parseError: errorMessage,
				});
				safeRemoveQueuedEvent(row.id);
				droppedMalformed++;
				continue;
			}

			const entry: RestoredQueueEntry = {
				persistId: row.id,
				event,
				subscriptionName: row.subscriptionName,
				prompt: row.prompt,
				outputPrompt: row.outputPrompt ?? undefined,
				cliOutput,
				action: (row.action as CueSubscription['action']) ?? undefined,
				command,
				chainDepth: row.chainDepth,
				queuedAt: row.queuedAt,
			};
			if (!restored.has(row.sessionId)) restored.set(row.sessionId, []);
			restored.get(row.sessionId)!.push(entry);
		}

		// Emit aggregated structured logs so the renderer's activity feed can
		// surface "queue restored N entries" on reopen. These aggregates cover
		// drops across multiple sessions at restore time, so sessionId is
		// intentionally omitted (the union member now marks it optional).
		if (droppedMissingSession > 0) {
			deps.onLog(
				'warn',
				`[CUE] Dropped ${droppedMissingSession} persisted queue row(s) whose session is no longer registered`,
				{
					type: 'queueDropped',
					count: droppedMissingSession,
					reason: 'session-missing',
				} satisfies CueLogPayload
			);
		}
		if (droppedStale > 0) {
			deps.onLog(
				'cue',
				`[CUE] Dropped ${droppedStale} stale persisted queue row(s) past session timeout`,
				{
					type: 'queueDropped',
					count: droppedStale,
					reason: 'stale',
				} satisfies CueLogPayload
			);
		}
		if (droppedMalformed > 0) {
			deps.onLog('warn', `[CUE] Dropped ${droppedMalformed} malformed persisted queue row(s)`, {
				type: 'queueDropped',
				count: droppedMalformed,
				reason: 'malformed',
			} satisfies CueLogPayload);
		}

		for (const [sessionId, entries] of restored) {
			const noun = entries.length === 1 ? 'entry' : 'entries';
			deps.onLog('cue', `[CUE] Restored ${entries.length} persisted queue ${noun}`, {
				type: 'queueRestored',
				sessionId,
				count: entries.length,
			} satisfies CueLogPayload);
		}

		return restored;
	}

	return { persist, remove, clearSession, clearAll, restoreAll };
}
