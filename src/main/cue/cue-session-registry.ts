/**
 * Cue Session Registry — single owner of per-session Cue runtime state.
 *
 * Holds `Map<sessionId, SessionState>` plus the dedup key sets that previously
 * lived on CueEngine and were mutated by three different files. All mutations
 * to dedup state must go through registry methods so the policy lives in one
 * place.
 *
 * Public surface:
 * - register / unregister / get / has / values / size — session lifecycle
 * - markScheduledFired / evictStaleScheduledKeys / clearScheduledForSession
 *   — `time.scheduled` dedup (one fire per `(session, sub, HH:MM)`)
 * - markStartupFired / clearStartupForSession / clearAllStartupKeys
 *   — `app.startup` dedup (one fire per `(session, sub)` per engine cycle).
 *   `markStartupFired` returns true on first fire within the current cycle,
 *   false if already fired. `engine.stop()` calls `clearAllStartupKeys()` to
 *   reset the dedup set so that the next `start('system-boot')` re-fires
 *   startup subscriptions for all sessions.
 * - clear — drops all sessions and `time.scheduled` dedup state; `app.startup`
 *   keys are NOT cleared by `clear()` (they remain valid within the current
 *   engine cycle). To reset startup keys, call `clearAllStartupKeys()` or
 *   use `engine.stop()`, which does so automatically.
 */

import type { SessionState } from './cue-session-state';

export interface CueSessionRegistry {
	// ── session lifecycle ────────────────────────────────────────────────
	register(sessionId: string, state: SessionState): void;
	unregister(sessionId: string): void;
	get(sessionId: string): SessionState | undefined;
	has(sessionId: string): boolean;
	/** Returns a defensive copy of the session map. Safe to iterate while mutating the registry. */
	snapshot(): Map<string, SessionState>;
	size(): number;

	// ── time.scheduled dedup ─────────────────────────────────────────────
	/**
	 * Atomically check-and-set the fired flag for a `(session, sub, HH:MM)` tuple.
	 * Returns `true` if this is the first time this tuple has fired this minute,
	 * `false` if it was already fired (caller must skip the dispatch).
	 */
	markScheduledFired(sessionId: string, subName: string, time: string): boolean;
	/**
	 * Drop fired-keys for a `(session, sub)` whose time component does not match
	 * `currentTime`. Keeps the dedup map from growing unboundedly.
	 */
	evictStaleScheduledKeys(sessionId: string, subName: string, currentTime: string): void;
	/** Drop all `time.scheduled` fired-keys for a session (on teardown / refresh). */
	clearScheduledForSession(sessionId: string): void;

	// ── app.startup dedup ────────────────────────────────────────────────
	/**
	 * Atomically check-and-set the fired flag for an `(session, sub)` startup tuple.
	 * Returns `true` if this is the first time the subscription has fired this
	 * engine cycle, `false` if it was already fired.
	 */
	markStartupFired(sessionId: string, subName: string): boolean;
	/** Drop all `app.startup` fired-keys for a session (on `removeSession`). */
	clearStartupForSession(sessionId: string): void;
	/** Drop ALL `app.startup` fired-keys. Called by the engine on `stop()` so that
	 * re-enabling Cue re-fires startup subscriptions for the new engine cycle. */
	clearAllStartupKeys(): void;

	/**
	 * Drop all sessions and clear `time.scheduled` dedup state.
	 * `app.startup` keys are cleared separately via `clearAllStartupKeys()` when
	 * the engine stops, so re-enabling always re-fires startup subscriptions.
	 */
	clear(): void;

	/**
	 * Sweep all `time.scheduled` fired-keys whose time component does not match
	 * `currentTime` ("HH:MM"). Returns the number of evicted keys.
	 * Intended for periodic cleanup to prevent unbounded growth of the dedup set.
	 */
	sweepStaleScheduledKeys(currentTime: string): number;

	// ── shared-trigger ownership (unowned subs, multi-session roots) ─────────
	/**
	 * Atomically claim ownership of an unowned subscription for a given
	 * projectRoot. Returns `true` when this session is now the owner (either
	 * newly claimed or it was already the owner). Returns `false` when a
	 * DIFFERENT session already owns the trigger — caller should skip creating
	 * a trigger source for this sub (first-registered-wins).
	 */
	claimSharedTriggerOwner(projectRoot: string, subName: string, sessionId: string): boolean;

	/** Returns the sessionId that currently owns this trigger, or `null` if unclaimed. */
	getSharedTriggerOwner(projectRoot: string, subName: string): string | null;

	/**
	 * Release all shared trigger claims held by `sessionId` (called on session
	 * teardown). Sibling sessions at the same root can re-claim on their next
	 * `initSession` / refresh cycle.
	 */
	releaseSharedTriggersForSession(sessionId: string): void;
}

export function createCueSessionRegistry(): CueSessionRegistry {
	const sessions = new Map<string, SessionState>();
	const scheduledFiredKeys = new Set<string>();
	const startupFiredKeys = new Set<string>();
	// key: `${projectRoot}::${subName}`, value: owning sessionId
	const sharedTriggerOwners = new Map<string, string>();

	function scheduledKey(sessionId: string, subName: string, time: string): string {
		return `${sessionId}:${subName}:${time}`;
	}

	function startupKey(sessionId: string, subName: string): string {
		return `${sessionId}:${subName}`;
	}

	function sharedTriggerKey(projectRoot: string, subName: string): string {
		return `${projectRoot}::${subName}`;
	}

	return {
		register(sessionId, state) {
			sessions.set(sessionId, state);
		},

		unregister(sessionId) {
			sessions.delete(sessionId);
		},

		get(sessionId) {
			return sessions.get(sessionId);
		},

		has(sessionId) {
			return sessions.has(sessionId);
		},

		snapshot() {
			return new Map(sessions);
		},

		size() {
			return sessions.size;
		},

		markScheduledFired(sessionId, subName, time) {
			const key = scheduledKey(sessionId, subName, time);
			if (scheduledFiredKeys.has(key)) return false;
			scheduledFiredKeys.add(key);
			return true;
		},

		evictStaleScheduledKeys(sessionId, subName, currentTime) {
			const prefix = `${sessionId}:${subName}:`;
			const currentKey = scheduledKey(sessionId, subName, currentTime);
			for (const key of scheduledFiredKeys) {
				if (key.startsWith(prefix) && key !== currentKey) {
					scheduledFiredKeys.delete(key);
				}
			}
		},

		clearScheduledForSession(sessionId) {
			const prefix = `${sessionId}:`;
			for (const key of scheduledFiredKeys) {
				if (key.startsWith(prefix)) {
					scheduledFiredKeys.delete(key);
				}
			}
		},

		markStartupFired(sessionId, subName) {
			const key = startupKey(sessionId, subName);
			if (startupFiredKeys.has(key)) return false;
			startupFiredKeys.add(key);
			return true;
		},

		clearStartupForSession(sessionId) {
			const prefix = `${sessionId}:`;
			for (const key of startupFiredKeys) {
				if (key.startsWith(prefix)) {
					startupFiredKeys.delete(key);
				}
			}
		},

		clearAllStartupKeys() {
			startupFiredKeys.clear();
		},

		claimSharedTriggerOwner(projectRoot, subName, sessionId) {
			const key = sharedTriggerKey(projectRoot, subName);
			const existing = sharedTriggerOwners.get(key);
			if (existing === undefined) {
				sharedTriggerOwners.set(key, sessionId);
				return true;
			}
			return existing === sessionId;
		},

		getSharedTriggerOwner(projectRoot, subName) {
			return sharedTriggerOwners.get(sharedTriggerKey(projectRoot, subName)) ?? null;
		},

		releaseSharedTriggersForSession(sessionId) {
			for (const [key, owner] of sharedTriggerOwners) {
				if (owner === sessionId) {
					sharedTriggerOwners.delete(key);
				}
			}
		},

		clear() {
			sessions.clear();
			scheduledFiredKeys.clear();
			sharedTriggerOwners.clear();
		},

		sweepStaleScheduledKeys(currentTime: string): number {
			// Keys have format: ${sessionId}:${subName}:HH:MM
			// The time is always the trailing ":HH:MM" suffix (e.g. ":09:30").
			const suffix = `:${currentTime}`;
			let evicted = 0;
			for (const key of scheduledFiredKeys) {
				if (!key.endsWith(suffix)) {
					scheduledFiredKeys.delete(key);
					evicted++;
				}
			}
			return evicted;
		},
	};
}
