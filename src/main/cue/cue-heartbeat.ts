/**
 * Heartbeat writer for the Cue Engine.
 *
 * Writes a heartbeat timestamp to the Cue database every 30 seconds. The
 * sleep-gap detection and missed-event reconciliation that used to live here
 * moved to {@link createCueRecoveryService} so that bootstrap, recovery, and
 * heartbeat-writing each have a single owner.
 */

import { updateHeartbeat } from './cue-db';
import { captureException } from '../utils/sentry';
import type { CueLogPayload } from '../../shared/cue-log-types';

export const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Report to Sentry after this many consecutive heartbeat write failures. Tuned
 * so transient DB locks (WAL-busy, macOS sleep-wake races) don't spam — but a
 * persistent failure surfaces within ~90 seconds.
 */
export const HEARTBEAT_FAILURE_REPORT_THRESHOLD = 3;

/** @deprecated Re-exported for backwards compat with cue-recovery-service. */
export { SLEEP_THRESHOLD_MS, EVENT_PRUNE_AGE_MS } from './cue-recovery-service';

export interface CueHeartbeat {
	start(): void;
	stop(): void;
}

/**
 * Optional hooks for heartbeat events. `onFailure` fires at the threshold
 * (same trigger point as the existing Sentry call) so the engine's metric
 * interceptor can bump `heartbeatFailures` without the heartbeat module
 * taking a direct dependency on the metrics collector.
 */
export interface CueHeartbeatHooks {
	onTick?: () => void;
	onFailure?: (payload: CueLogPayload & { type: 'heartbeatFailure' }) => void;
}

/**
 * Recognize the transient SQLite busy/lock signatures that the
 * HEARTBEAT_FAILURE_REPORT_THRESHOLD exists to absorb (WAL-busy, macOS
 * sleep-wake races). Anything unrecognized is treated as unexpected and
 * surfaces to Sentry immediately rather than hiding behind the threshold.
 */
function isRecoverableHeartbeatError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const code = (err as { code?: unknown }).code;
	if (
		code === 'SQLITE_BUSY' ||
		code === 'SQLITE_BUSY_RECOVERY' ||
		code === 'SQLITE_BUSY_SNAPSHOT' ||
		code === 'SQLITE_BUSY_TIMEOUT' ||
		code === 'SQLITE_LOCKED' ||
		code === 'SQLITE_LOCKED_SHAREDCACHE'
	) {
		return true;
	}
	const message = (err as { message?: unknown }).message;
	if (typeof message !== 'string') return false;
	return /\bdatabase is locked\b|\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b/i.test(message);
}

export function createCueHeartbeat(hooksOrOnTick?: CueHeartbeatHooks | (() => void)): CueHeartbeat {
	// Back-compat: early wiring passed a bare onTick callback. Accept either.
	const hooks: CueHeartbeatHooks =
		typeof hooksOrOnTick === 'function' ? { onTick: hooksOrOnTick } : (hooksOrOnTick ?? {});
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	let consecutiveFailures = 0;
	// Per-streak dedup for unknown errors: track every signature reported so far
	// in the streak (Set), so alternating novel errors each get one Sentry event
	// rather than re-firing on each switch. onFailureEmitted ensures hooks.onFailure
	// fires at most once per streak regardless of how many distinct signatures appear.
	let reportedUnknownSignatures = new Set<string>();
	let onFailureEmitted = false;

	function attempt(): void {
		try {
			updateHeartbeat();
			consecutiveFailures = 0;
			// Reset dedup state so the next distinct error streak gets reported fresh.
			reportedUnknownSignatures = new Set<string>();
			onFailureEmitted = false;
		} catch (err) {
			consecutiveFailures++;
			if (isRecoverableHeartbeatError(err)) {
				// Transient DB lock / sleep-wake race: report exactly once per
				// run of failures (strict equality). Runs that recover before
				// the threshold never reach Sentry; ongoing failures are
				// represented by a single event, not a storm.
				if (consecutiveFailures === HEARTBEAT_FAILURE_REPORT_THRESHOLD) {
					void captureException(err, {
						operation: 'cue:heartbeat',
						consecutiveFailures,
					});
					hooks.onFailure?.({ type: 'heartbeatFailure', consecutiveFailures });
				}
			} else {
				// Unexpected shape — surface immediately, but deduplicate by error
				// signature within a single failure streak to avoid a Sentry storm.
				// Each distinct signature gets one Sentry event (Set tracks reported ones).
				// hooks.onFailure fires at most once per streak (onFailureEmitted gate).
				const signature =
					(err instanceof Error ? err.message || err.name || err.stack : String(err)) ?? '';
				if (!reportedUnknownSignatures.has(signature)) {
					reportedUnknownSignatures.add(signature);
					void captureException(err, {
						operation: 'cue:heartbeat',
						consecutiveFailures,
					});
				}
				if (!onFailureEmitted) {
					onFailureEmitted = true;
					hooks.onFailure?.({ type: 'heartbeatFailure', consecutiveFailures });
				}
			}
		}
	}

	function startHeartbeat(): void {
		stopHeartbeat();
		attempt();
		heartbeatInterval = setInterval(() => {
			attempt();
			hooks.onTick?.();
		}, HEARTBEAT_INTERVAL_MS);
	}

	function stopHeartbeat(): void {
		if (heartbeatInterval) {
			clearInterval(heartbeatInterval);
			heartbeatInterval = null;
		}
		// Counter resets on stop so a subsequent start() gets a fresh window —
		// matches the engine re-enable semantics elsewhere in the codebase.
		consecutiveFailures = 0;
		reportedUnknownSignatures = new Set<string>();
		onFailureEmitted = false;
	}

	return {
		start: startHeartbeat,
		stop: stopHeartbeat,
	};
}
