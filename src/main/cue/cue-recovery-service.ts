/**
 * Cue Recovery Service — owns engine bootstrap and sleep/wake recovery.
 *
 * Wraps three previously-scattered concerns into one place:
 * 1. Database init + event prune at engine start
 * 2. Sleep gap detection (heartbeat-based)
 * 3. Missed-event reconciliation after wake
 *
 * Database lifecycle (init / shutdown) used to live inline in `engine.start()`
 * and `engine.stop()`. Sleep detection lived inside `cue-heartbeat.ts`. Splitting
 * them out lets the engine become a thin façade that just calls
 * `recoveryService.init()` / `detectSleepAndReconcile()` / `shutdown()`.
 */

import type { MainLogLevel } from '../../shared/logger-types';
import { closeCueDb, getLastHeartbeat, initCueDb, pruneCueEvents } from './cue-db';
import { reconcileMissedTimeEvents, type ReconcileSessionInfo } from './cue-reconciler';
import { captureException } from '../utils/sentry';
import type { CueConfig, CueEvent, CueSubscription } from './cue-types';

/** Sleep gap threshold for triggering reconciliation. Same as the old heartbeat module. */
export const SLEEP_THRESHOLD_MS = 120_000; // 2 minutes
/** Cue events older than this are pruned at engine start. */
export const EVENT_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type CueRecoveryInitResult = { ok: true } | { ok: false; error: Error };

export interface CueRecoveryServiceDeps {
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	/** Snapshot of current sessions, used by the reconciler to fire missed events. */
	getSessions: () => Map<string, { config: CueConfig; sessionName: string }>;
	/** Dispatch a missed event back through the engine's normal execution path. */
	onDispatch: (sessionId: string, sub: CueSubscription, event: CueEvent) => void;
}

export interface CueRecoveryService {
	/**
	 * Initialize the Cue database and prune old events. Returns `{ ok: true }`
	 * on success, `{ ok: false, error }` on failure (engine should not start).
	 * Failures are also reported to Sentry.
	 */
	init(): CueRecoveryInitResult;
	/**
	 * Detect a sleep gap since the last recorded heartbeat and dispatch
	 * catch-up events for missed time.heartbeat subscriptions. Safe to call
	 * even if the heartbeat row is empty (returns silently).
	 */
	detectSleepAndReconcile(): void;
	/** Close the Cue database. Non-fatal if already closed. */
	shutdown(): void;
}

export function createCueRecoveryService(deps: CueRecoveryServiceDeps): CueRecoveryService {
	function init(): CueRecoveryInitResult {
		try {
			initCueDb((level, msg) => deps.onLog(level as MainLogLevel, msg));
			pruneCueEvents(EVENT_PRUNE_AGE_MS);
			return { ok: true };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			deps.onLog(
				'error',
				`[CUE] Failed to initialize Cue database — engine will not start: ${err.message}`
			);
			captureException(err, { extra: { operation: 'cue.dbInit' } });
			return { ok: false, error: err };
		}
	}

	function detectSleepAndReconcile(): void {
		try {
			const lastHeartbeat = getLastHeartbeat();
			if (lastHeartbeat === null) return; // First ever start — nothing to reconcile

			const now = Date.now();
			const gapMs = now - lastHeartbeat;

			// A negative gap means the system clock jumped backward since the
			// last heartbeat. Running reconciliation in that state would fire
			// "missed" events that haven't actually been missed.
			if (gapMs < 0) {
				deps.onLog(
					'cue',
					`[CUE] Clock moved backward (gap: ${gapMs}ms) — skipping sleep reconciliation`
				);
				return;
			}

			if (gapMs < SLEEP_THRESHOLD_MS) return;

			const gapMinutes = Math.round(gapMs / 60_000);
			deps.onLog('cue', `[CUE] Sleep detected (gap: ${gapMinutes}m). Reconciling missed events.`);

			const reconcileSessions = new Map<string, ReconcileSessionInfo>();
			const sessions = deps.getSessions();
			for (const [sessionId, state] of sessions) {
				reconcileSessions.set(sessionId, {
					config: state.config,
					sessionName: state.sessionName,
				});
			}

			reconcileMissedTimeEvents({
				sleepStartMs: lastHeartbeat,
				wakeTimeMs: now,
				sessions: reconcileSessions,
				onDispatch: (sessionId, sub, event) => {
					deps.onDispatch(sessionId, sub, event);
				},
				onLog: (level, message) => {
					deps.onLog(level as MainLogLevel, message);
				},
			});
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			deps.onLog('warn', `[CUE] Sleep detection failed: ${err.message}`);
			captureException(err, { extra: { operation: 'cue.sleepDetection' } });
		}
	}

	function shutdown(): void {
		try {
			closeCueDb();
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			deps.onLog('error', `[CUE] Shutdown/closeCueDb failed: ${err.message}`);
			captureException(err, { extra: { operation: 'cue.shutdown.closeCueDb' } });
		}
	}

	return { init, detectSleepAndReconcile, shutdown };
}
