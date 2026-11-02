import { CUE_EVENT_TYPES } from '../../shared/cue/contracts';
import { isDurableCueEvent } from './triggers/cue-plugin-trigger-source';
/**
 * Cue Queue Persistence - Phase 12A.
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
import type {
	CueAutoRunConfig,
	CueCommand,
	CueEvent,
	CueNotifyConfig,
	CueSubscription,
} from './cue-types';
import type { CueTurnSettings } from '../../shared/cue/turn-settings';
import {
	getQueuedEvents,
	removeQueuedEvent,
	safePersistQueuedEvent,
	persistQueuedEvent,
	safeRemoveQueuedEvent,
	safeRecordCueEvent,
	type CueQueuedEventRecord,
} from './cue-db';
import { captureException } from '../utils/sentry';

/** Shape matching cue-run-manager's QueuedEvent (subset - only what's persisted). */
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
	/** Phase 01 - chain lineage propagated from the parent run so a restored
	 *  queue entry stays attached to its chain root after a crash. Undefined
	 *  for root events (and for any entry queued while usageStats is off). */
	chainRootId?: string;
	parentEventId?: string;
	/**
	 * Set when a drain (`CueEngine.drain`) deferred this entry to the next
	 * start: the epoch ms the engine stopped. Restore then measures staleness
	 * as the time the entry waited while an engine was UP (`drainedAt -
	 * queuedAt`), so a server that was down longer than the session timeout
	 * does not throw away work it acknowledged. Unset for every other row (a
	 * crash leftover), which keeps the wall-clock rule.
	 */
	drainedAt?: number;
	/** Captured Auto Run payload for `action: autorun`. The run launches from
	 *  THIS, not from the subscription, so it has to survive a restart with the
	 *  row or the restored run has no documents. */
	autoRun?: CueAutoRunConfig;
	/** Resolved notify config for `action: notify`. The message also rides the
	 *  `prompt` slot, but `sticky` lives nowhere else. */
	notify?: CueNotifyConfig;
	/** The subscription's model choice, so a restored run keeps it. */
	turnSettings?: CueTurnSettings;
}

export type DurableRestoreState = 'ready' | 'deferred' | 'removed';

export interface RestoredQueueEntry extends PersistableQueueEntry {
	/** Owner/config not yet discovered; this entry must not be executed. */
	deferred?: boolean;
	persistId: string;
}

/**
 * Where the drain stamp lives: a reserved key inside the stored `event_json`.
 * `cue_event_queue` itself is unchanged; this module owns the row's JSON shape
 * and strips the key before the event reaches anything else.
 */
const DRAINED_AT_KEY = 'maestroDrainedAt';

export interface CueQueuePersistence {
	persist(sessionId: string, persistId: string, entry: PersistableQueueEntry): void | boolean;
	remove(persistId: string): void;
	clearSession(sessionId: string, options?: { includeDurable?: boolean }): void;
	clearAll(): void;
	/** Start a new engine cycle's exclusion epoch before initializing sessions. */
	beginRestoreEpoch(): void;
	/**
	 * Ids of every row currently persisted. The engine snapshots this BEFORE
	 * it initializes sessions, because initializing one can enqueue (and so
	 * persist) an `app.startup` or initial `time.heartbeat` event behind a busy
	 * slot - and restoring that row would run the same event a second time.
	 * With previousInstanceOnly, exclude this epoch's writes until a snapshot
	 * succeeds. Null denotes a failed read and keeps that exclusion active.
	 */
	persistedIds(previousInstanceOnly?: boolean): Set<string> | null;
	/** Restore selected rows; null preserves retry candidates after a failed read. */
	restoreAll(onlyIds?: ReadonlySet<string>): Map<string, RestoredQueueEntry[]> | null;
}

export interface CueQueuePersistenceDeps {
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	/** Per-session timeout - used to discard stale rows at restore time. */
	getSessionTimeoutMs: (sessionId: string) => number;
	/** Live membership for ordinary rows; unknown durable owners are deferred. */
	knownSessionIds: () => Set<string>;
	/**
	 * Every subscription name in a registered agent's current config. A row
	 * whose subscription is in none of them was removed (a re-import, a yaml
	 * edit while the engine was down) and is dropped instead of running a
	 * prompt the config no longer has. Checked across ALL agents, not the
	 * row's own: a fan-out row runs on a target agent whose config does not
	 * carry the owner's subscription. Omit (tests, older call sites) to skip
	 * the check.
	 */
	knownSubscriptionNames?: () => Set<string>;
	/** Distinguish unavailable live state from confirmed source/owner removal. */
	durableSourceState?: (sessionId: string, subscriptionName: string) => DurableRestoreState;
	/** Override for testing - defaults to Date.now. */
	now?: () => number;
}

export function createCueQueuePersistence(deps: CueQueuePersistenceDeps): CueQueuePersistence {
	const now = deps.now ?? (() => Date.now());
	// Track current-start writes only until the pre-start snapshot succeeds.
	// IDs remain excluded even if their later removal failed.
	let currentStartWrites: Set<string> | null = null;
	function beginRestoreEpoch(): void {
		currentStartWrites = new Set();
	}

	function persist(
		sessionId: string,
		persistId: string,
		entry: PersistableQueueEntry
	): void | boolean {
		currentStartWrites?.add(persistId);
		const record: CueQueuedEventRecord = {
			id: persistId,
			sessionId,
			subscriptionName: entry.subscriptionName,
			eventJson: JSON.stringify(
				entry.drainedAt !== undefined
					? { ...entry.event, [DRAINED_AT_KEY]: entry.drainedAt }
					: entry.event
			),
			prompt: entry.prompt,
			outputPrompt: entry.outputPrompt ?? null,
			cliOutputJson: entry.cliOutput ? JSON.stringify(entry.cliOutput) : null,
			action: entry.action ?? null,
			commandJson: entry.command ? JSON.stringify(entry.command) : null,
			chainDepth: entry.chainDepth ?? 0,
			queuedAt: entry.queuedAt,
			chainRootId: entry.chainRootId ?? null,
			parentEventId: entry.parentEventId ?? null,
			autoRunJson: entry.autoRun ? JSON.stringify(entry.autoRun) : null,
			notifyJson: entry.notify ? JSON.stringify(entry.notify) : null,
			turnSettingsJson: entry.turnSettings ? JSON.stringify(entry.turnSettings) : null,
		};
		if (isDurableCueEvent(entry.event)) {
			try {
				persistQueuedEvent(record);
				return getQueuedEvents(sessionId).some(
					(row) => row.id === record.id && row.eventJson === record.eventJson
				);
			} catch {
				return false;
			}
		}
		safePersistQueuedEvent(record);
	}

	function remove(persistId: string): void {
		safeRemoveQueuedEvent(persistId);
	}

	// Lifecycle clearing must not erase already acknowledged plugin deliveries.
	// Terminal completion and explicit source/authority removal still use remove().
	function clearRows(sessionId?: string, includeDurable = false): void {
		for (const row of getQueuedEvents(sessionId)) {
			let durable = false,
				pluginEvent = false;
			try {
				const event = JSON.parse(row.eventJson);
				pluginEvent = isDurableCueEvent(event);
				durable =
					pluginEvent || (typeof event?.type === 'string' && !CUE_EVENT_TYPES.includes(event.type));
			} catch {
				/* corrupt ordinary row is discardable */
			}
			if (!durable || (includeDurable && pluginEvent)) removeQueuedEvent(row.id);
		}
	}

	function clearSession(sessionId: string, options?: { includeDurable?: boolean }): void {
		try {
			clearRows(sessionId, options?.includeDurable);
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
			clearRows();
		} catch (err) {
			void captureException(err, { operation: 'cueQueuePersistence.clearAll' });
			deps.onLog(
				'warn',
				`[CUE] Failed to clear all persisted queue: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	function persistedIds(previousInstanceOnly = false): Set<string> | null {
		try {
			const ids = new Set(
				getQueuedEvents()
					.filter((row) => !previousInstanceOnly || !currentStartWrites?.has(row.id))
					.map((row) => row.id)
			);
			if (previousInstanceOnly) currentStartWrites = null;
			return ids;
		} catch {
			// A failed snapshot is not an empty queue. Keep excluding this
			// start's writes until a later heartbeat can capture the old IDs.
			return null;
		}
	}

	function restoreAll(onlyIds?: ReadonlySet<string>): Map<string, RestoredQueueEntry[]> | null {
		let rows: CueQueuedEventRecord[];
		try {
			rows = getQueuedEvents();
			if (onlyIds) rows = rows.filter((row) => onlyIds.has(row.id));
		} catch (err) {
			void captureException(err, { operation: 'cueQueuePersistence.restoreAll' });
			deps.onLog(
				'warn',
				`[CUE] Failed to read persisted queue - retry deferred: ${err instanceof Error ? err.message : String(err)}`
			);
			return null;
		}

		const currentTime = now();
		const knownSessions = deps.knownSessionIds();
		const knownSubscriptions = deps.knownSubscriptionNames?.();
		const restored = new Map<string, RestoredQueueEntry[]>();
		let droppedStale = 0;
		let droppedMalformed = 0;
		let droppedMissingSession = 0;
		let droppedMissingSubscription = 0;

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
			reason: 'stale' | 'malformed' | 'session-missing' | 'subscription-missing',
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
			// Unsupported historical source rows stay parked on disk for explicit migration.
			// Do not let ordinary stale/session cleanup destroy a retired producer's data.
			try {
				const historical = JSON.parse(row.eventJson);
				if (
					historical &&
					typeof historical.type === 'string' &&
					!CUE_EVENT_TYPES.includes(historical.type)
				) {
					deps.onLog(
						'warn',
						'[CUE] Unsupported queued source preserved; explicit migration required'
					);
					continue;
				}
			} catch {
				/* the existing malformed-row handling below owns this case */
			}

			// Deserialize. Any JSON failure is a data integrity problem - drop the
			// row so it doesn't stall restore every time the engine starts.
			let event: CueEvent;
			let cliOutput: { target: string } | undefined;
			let command: CueCommand | undefined;
			let drainedAt: number | undefined;
			let autoRun: CueAutoRunConfig | undefined;
			let notify: CueNotifyConfig | undefined;
			let turnSettings: CueTurnSettings | undefined;
			try {
				const parsed = JSON.parse(row.eventJson) as CueEvent & { [DRAINED_AT_KEY]?: unknown };
				if (typeof parsed[DRAINED_AT_KEY] === 'number') drainedAt = parsed[DRAINED_AT_KEY];
				delete parsed[DRAINED_AT_KEY];
				event = parsed;
				cliOutput = row.cliOutputJson ? JSON.parse(row.cliOutputJson) : undefined;
				command = row.commandJson ? JSON.parse(row.commandJson) : undefined;
				autoRun = row.autoRunJson ? JSON.parse(row.autoRunJson) : undefined;
				notify = row.notifyJson ? JSON.parse(row.notifyJson) : undefined;
				turnSettings = row.turnSettingsJson ? JSON.parse(row.turnSettingsJson) : undefined;
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

			const durableState = isDurableCueEvent(event)
				? (deps.durableSourceState?.(row.sessionId, row.subscriptionName) ??
					(!knownSessions.has(row.sessionId) ||
					(knownSubscriptions && !knownSubscriptions.has(row.subscriptionName))
						? 'deferred'
						: 'ready'))
				: undefined;
			if (durableState === 'removed' || (!durableState && !knownSessions.has(row.sessionId))) {
				const sessionMissing = !knownSessions.has(row.sessionId);
				recordRestoredDrop(row, sessionMissing ? 'session-missing' : 'subscription-missing');
				safeRemoveQueuedEvent(row.id);
				if (sessionMissing) droppedMissingSession++;
				else droppedMissingSubscription++;
				continue;
			}
			if (!durableState && knownSubscriptions && !knownSubscriptions.has(row.subscriptionName)) {
				recordRestoredDrop(row, 'subscription-missing');
				safeRemoveQueuedEvent(row.id);
				droppedMissingSubscription++;
				continue;
			}

			// Staleness check (mirrors cue-run-manager's runtime drainQueue check).
			// A drained row's age is the time it waited while an engine was up:
			// downtime does not count against work a drain deferred.
			const ageMs =
				drainedAt !== undefined
					? Math.max(0, drainedAt - row.queuedAt)
					: currentTime - row.queuedAt;
			const timeoutMs = deps.getSessionTimeoutMs(row.sessionId);
			if (!isDurableCueEvent(event) && timeoutMs > 0 && ageMs > timeoutMs) {
				recordRestoredDrop(row, 'stale', { queuedForMs: ageMs });
				safeRemoveQueuedEvent(row.id);
				droppedStale++;
				continue;
			}

			const entry: RestoredQueueEntry = {
				persistId: row.id,
				...(durableState === 'deferred' ? { deferred: true } : {}),
				event,
				subscriptionName: row.subscriptionName,
				prompt: row.prompt,
				outputPrompt: row.outputPrompt ?? undefined,
				cliOutput,
				action: (row.action as CueSubscription['action']) ?? undefined,
				command,
				chainDepth: row.chainDepth,
				// Rebased for a drained row, so the run manager's runtime stale
				// check sees the same age restore just judged, not the downtime.
				queuedAt: drainedAt !== undefined ? currentTime - ageMs : row.queuedAt,
				chainRootId: row.chainRootId ?? undefined,
				parentEventId: row.parentEventId ?? undefined,
				autoRun,
				notify,
				turnSettings,
				...(drainedAt !== undefined ? { drainedAt } : {}),
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
		if (droppedMissingSubscription > 0) {
			deps.onLog(
				'warn',
				`[CUE] Dropped ${droppedMissingSubscription} persisted queue row(s) whose subscription is no longer in any agent's config`,
				{
					type: 'queueDropped',
					count: droppedMissingSubscription,
					reason: 'subscription-missing',
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

	return { persist, remove, clearSession, clearAll, beginRestoreEpoch, persistedIds, restoreAll };
}
