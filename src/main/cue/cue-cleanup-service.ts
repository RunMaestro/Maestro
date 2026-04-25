/**
 * Cue Cleanup Service — periodic sweep of stale fan-in trackers and
 * time.scheduled dedup keys.
 *
 * Designed to be called on every heartbeat tick via an `onTick` callback
 * passed to `createCueHeartbeat`. Actually sweeps every CLEANUP_INTERVAL_TICKS
 * ticks (≈5 minutes at 30s heartbeat). Evicts:
 *   1. Fan-in trackers whose owner session is no longer registered
 *   2. Fan-in trackers open longer than 2× their session's timeout_minutes
 *   3. time.scheduled dedup keys whose time component differs from the current minute
 */

import type { MainLogLevel } from '../../shared/logger-types';
import type { CueFanInTracker } from './cue-fan-in-tracker';
import type { CueSessionRegistry } from './cue-session-registry';

/** Number of heartbeat ticks between sweeps (10 × 30 s = 5 minutes). */
export const CLEANUP_INTERVAL_TICKS = 10;

export interface CueCleanupServiceDeps {
	fanInTracker: CueFanInTracker;
	registry: CueSessionRegistry;
	/** Returns active session IDs used to detect orphaned fan-in trackers. */
	getSessions: () => { id: string }[];
	/** Returns the configured timeout in milliseconds for a session. */
	getSessionTimeoutMs: (sessionId: string) => number;
	/** Returns the current wall-clock minute as "HH:MM". */
	getCurrentMinute: () => string;
	onLog: (level: MainLogLevel, message: string) => void;
}

export interface CueCleanupService {
	/** Increment tick counter; triggers a sweep every CLEANUP_INTERVAL_TICKS ticks. */
	onTick(): void;
	/** Run a sweep immediately (useful for testing or on-demand maintenance). */
	sweep(): { fanInEvicted: number; scheduledKeysEvicted: number };
}

export function createCueCleanupService(deps: CueCleanupServiceDeps): CueCleanupService {
	let tickCount = 0;

	function sweep(): { fanInEvicted: number; scheduledKeysEvicted: number } {
		let fanInEvicted = 0;
		const activeSessions = new Set(deps.getSessions().map((s) => s.id));

		for (const key of deps.fanInTracker.getActiveTrackerKeys()) {
			// key format: "${ownerSessionId}:${subName}"
			const colonIdx = key.indexOf(':');
			const ownerSessionId = colonIdx === -1 ? key : key.substring(0, colonIdx);

			// Evict if the owning session is no longer registered
			if (!activeSessions.has(ownerSessionId)) {
				deps.fanInTracker.expireTracker(key);
				fanInEvicted++;
				deps.onLog('warn', `[CUE] Evicted stale fan-in tracker for removed session: ${key}`);
				continue;
			}

			// Evict if the tracker has been open longer than 2× the session's timeout
			const createdAt = deps.fanInTracker.getTrackerCreatedAt(key);
			if (createdAt !== undefined) {
				const timeoutMs = deps.getSessionTimeoutMs(ownerSessionId);
				const ageMs = Date.now() - createdAt;
				if (ageMs > 2 * timeoutMs) {
					deps.fanInTracker.expireTracker(key);
					fanInEvicted++;
					deps.onLog(
						'warn',
						`[CUE] Evicted stale fan-in tracker (age ${Math.round(ageMs / 60000)}m > 2× timeout): ${key}`
					);
				}
			}
		}

		// Sweep time.scheduled dedup keys that no longer match the current minute
		const scheduledKeysEvicted = deps.registry.sweepStaleScheduledKeys(deps.getCurrentMinute());
		if (scheduledKeysEvicted > 0) {
			deps.onLog('info', `[CUE] Swept ${scheduledKeysEvicted} stale scheduled key(s)`);
		}

		return { fanInEvicted, scheduledKeysEvicted };
	}

	return {
		onTick(): void {
			tickCount++;
			if (tickCount % CLEANUP_INTERVAL_TICKS === 0) {
				sweep();
			}
		},
		sweep,
	};
}
