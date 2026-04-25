/**
 * Tests for CueSessionRegistry.
 *
 * The registry is the single owner of per-session Cue runtime state plus the
 * `time.scheduled` and `app.startup` dedup key sets that previously lived on
 * CueEngine and were mutated by three different files. These tests pin down
 * the registry's behaviour so the dedup policy stops drifting.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	createCueSessionRegistry,
	type CueSessionRegistry,
} from '../../../main/cue/cue-session-registry';
import type { SessionState } from '../../../main/cue/cue-session-state';
import type { CueConfig } from '../../../main/cue/cue-types';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	const config: CueConfig = {
		subscriptions: [],
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
	};
	return {
		config,
		triggerSources: [],
		yamlWatcher: null,
		sleepPrevented: false,
		...overrides,
	};
}

describe('cue-session-registry', () => {
	let registry: CueSessionRegistry;

	beforeEach(() => {
		registry = createCueSessionRegistry();
	});

	describe('session lifecycle', () => {
		it('register / get / has / size', () => {
			expect(registry.size()).toBe(0);
			expect(registry.has('s1')).toBe(false);
			expect(registry.get('s1')).toBeUndefined();

			const state = makeState();
			registry.register('s1', state);

			expect(registry.size()).toBe(1);
			expect(registry.has('s1')).toBe(true);
			expect(registry.get('s1')).toBe(state);
		});

		it('unregister removes a session', () => {
			registry.register('s1', makeState());
			registry.register('s2', makeState());

			registry.unregister('s1');

			expect(registry.has('s1')).toBe(false);
			expect(registry.has('s2')).toBe(true);
			expect(registry.size()).toBe(1);
		});

		it('snapshot returns a defensive copy of the session map', () => {
			const stateA = makeState();
			const stateB = makeState();
			registry.register('s1', stateA);
			registry.register('s2', stateB);

			const snapshot = registry.snapshot();
			expect(snapshot.size).toBe(2);
			expect(snapshot.get('s1')).toBe(stateA);
			expect(snapshot.get('s2')).toBe(stateB);

			// Mutating the snapshot does NOT affect the registry.
			snapshot.delete('s1');
			expect(registry.has('s1')).toBe(true);
		});
	});

	describe('time.scheduled dedup', () => {
		it('markScheduledFired returns true on first fire, false on duplicate', () => {
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false);
		});

		it('different time slots are independent', () => {
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '10:00')).toBe(true);
		});

		it('different sessions are independent', () => {
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s2', 'sub-1', '09:00')).toBe(true);
		});

		it('different sub names are independent', () => {
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-2', '09:00')).toBe(true);
		});

		it('evictStaleScheduledKeys removes keys for the same (session, sub) with non-current time', () => {
			registry.markScheduledFired('s1', 'sub-1', '08:00');
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			registry.markScheduledFired('s1', 'sub-1', '10:00');

			registry.evictStaleScheduledKeys('s1', 'sub-1', '10:00');

			// 08:00 and 09:00 are evicted; 10:00 stays — re-firing 10:00 must still be deduped.
			expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '10:00')).toBe(false);
		});

		it('evictStaleScheduledKeys does not touch other sessions or subs', () => {
			registry.markScheduledFired('s1', 'sub-1', '08:00');
			registry.markScheduledFired('s2', 'sub-1', '08:00');
			registry.markScheduledFired('s1', 'sub-2', '08:00');

			registry.evictStaleScheduledKeys('s1', 'sub-1', '09:00');

			// Only s1:sub-1 is evicted.
			expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
			expect(registry.markScheduledFired('s2', 'sub-1', '08:00')).toBe(false);
			expect(registry.markScheduledFired('s1', 'sub-2', '08:00')).toBe(false);
		});

		it('clearScheduledForSession drops all scheduled keys for that session', () => {
			registry.markScheduledFired('s1', 'sub-1', '08:00');
			registry.markScheduledFired('s1', 'sub-2', '09:00');
			registry.markScheduledFired('s2', 'sub-1', '08:00');

			registry.clearScheduledForSession('s1');

			expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-2', '09:00')).toBe(true);
			// s2 untouched
			expect(registry.markScheduledFired('s2', 'sub-1', '08:00')).toBe(false);
		});
	});

	describe('app.startup dedup', () => {
		it('markStartupFired returns true on first fire, false on duplicate', () => {
			expect(registry.markStartupFired('s1', 'init')).toBe(true);
			expect(registry.markStartupFired('s1', 'init')).toBe(false);
		});

		it('different sessions are independent', () => {
			expect(registry.markStartupFired('s1', 'init')).toBe(true);
			expect(registry.markStartupFired('s2', 'init')).toBe(true);
		});

		it("clearStartupForSession drops only that session's startup keys", () => {
			registry.markStartupFired('s1', 'init-a');
			registry.markStartupFired('s1', 'init-b');
			registry.markStartupFired('s2', 'init-a');

			registry.clearStartupForSession('s1');

			expect(registry.markStartupFired('s1', 'init-a')).toBe(true);
			expect(registry.markStartupFired('s1', 'init-b')).toBe(true);
			// s2 untouched
			expect(registry.markStartupFired('s2', 'init-a')).toBe(false);
		});
	});

	describe('clearAllStartupKeys', () => {
		it('clears all startup fired-keys so subsequent fires are allowed', () => {
			registry.markStartupFired('s1', 'init-a');
			registry.markStartupFired('s1', 'init-b');
			registry.markStartupFired('s2', 'init-a');

			registry.clearAllStartupKeys();

			expect(registry.markStartupFired('s1', 'init-a')).toBe(true);
			expect(registry.markStartupFired('s1', 'init-b')).toBe(true);
			expect(registry.markStartupFired('s2', 'init-a')).toBe(true);
		});

		it('does not affect sessions, scheduled keys, or session state', () => {
			registry.register('s1', makeState());
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			registry.markStartupFired('s1', 'init');

			registry.clearAllStartupKeys();

			expect(registry.has('s1')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false); // still deduped
		});
	});

	describe('clear', () => {
		it('drops all sessions and time.scheduled keys but PRESERVES startup keys', () => {
			registry.register('s1', makeState());
			registry.register('s2', makeState());
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			registry.markStartupFired('s1', 'init');
			registry.markStartupFired('s2', 'init');

			registry.clear();

			// Sessions are gone.
			expect(registry.size()).toBe(0);
			expect(registry.has('s1')).toBe(false);

			// Scheduled keys are gone — re-firing the same slot succeeds.
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);

			// Startup keys are PRESERVED — re-firing must be deduped. This is the
			// regression target: toggling Cue off/on must NOT re-fire app.startup.
			expect(registry.markStartupFired('s1', 'init')).toBe(false);
			expect(registry.markStartupFired('s2', 'init')).toBe(false);
		});

		it('clear is idempotent', () => {
			registry.register('s1', makeState());
			registry.clear();
			registry.clear();
			expect(registry.size()).toBe(0);
		});
	});

	describe('sweepStaleScheduledKeys', () => {
		it('returns 0 and does nothing when no keys exist', () => {
			const evicted = registry.sweepStaleScheduledKeys('09:00');
			expect(evicted).toBe(0);
		});

		it('does not evict a key that matches the current time', () => {
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			const evicted = registry.sweepStaleScheduledKeys('09:00');
			expect(evicted).toBe(0);
			// Key still in set — re-firing is still deduped
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false);
		});

		it('evicts keys whose time component differs from the current time', () => {
			registry.markScheduledFired('s1', 'sub-1', '08:59');
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			// At 09:01 — the 08:59 key is stale, the 09:00 key is also stale
			const evicted = registry.sweepStaleScheduledKeys('09:01');
			expect(evicted).toBe(2);
			// After eviction, both slots can fire again
			expect(registry.markScheduledFired('s1', 'sub-1', '08:59')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
		});

		it('evicts stale keys across multiple sessions and subscriptions', () => {
			registry.markScheduledFired('s1', 'sub-a', '10:00');
			registry.markScheduledFired('s2', 'sub-b', '10:00');
			registry.markScheduledFired('s1', 'sub-a', '10:01');
			const evicted = registry.sweepStaleScheduledKeys('10:01');
			// The two 10:00 keys are stale; the 10:01 key is current
			expect(evicted).toBe(2);
		});

		it('does not affect startup fired keys', () => {
			registry.markStartupFired('s1', 'init');
			registry.sweepStaleScheduledKeys('09:00');
			// Startup key is unaffected — still deduped
			expect(registry.markStartupFired('s1', 'init')).toBe(false);
		});
	});
});
