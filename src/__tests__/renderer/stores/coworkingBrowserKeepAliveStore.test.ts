import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	useCoworkingBrowserKeepAliveStore,
	activePinnedTabIds,
	BROWSER_KEEPALIVE_TTL_MS,
} from '../../../renderer/stores/coworkingBrowserKeepAliveStore';

const store = () => useCoworkingBrowserKeepAliveStore.getState();

describe('coworkingBrowserKeepAliveStore', () => {
	beforeEach(() => {
		// Fake timers control BOTH the prune setTimeout and Date.now() (the store
		// reads Date.now() for expiry math), so a single fake clock drives it all.
		vi.useFakeTimers();
		// Pin to epoch 0 so `Date.now() + TTL` and the prune offset are exact.
		vi.setSystemTime(0);
		// Module-level singleton: reset pins + cancel any prune timer between tests.
		store().clear();
	});

	afterEach(() => {
		store().clear();
		vi.useRealTimers();
	});

	it('reports a freshly pinned tab, then drops it once the TTL lapses (and the timer sweeps the key)', () => {
		store().pin('tab-a');
		expect(activePinnedTabIds(store().pins)).toContain('tab-a');

		// Just past the TTL but before the prune timer (scheduled at TTL + 50ms)
		// fires: the pin is logically expired, so activePinnedTabIds excludes it,
		// yet the stale key still physically sits in `pins` until the sweep.
		vi.advanceTimersByTime(BROWSER_KEEPALIVE_TTL_MS + 10);
		expect(activePinnedTabIds(store().pins)).not.toContain('tab-a');
		expect(Object.keys(store().pins)).toContain('tab-a');

		// Let the prune timer fire; the expired key is physically removed from pins.
		vi.advanceTimersByTime(100);
		expect(Object.keys(store().pins)).not.toContain('tab-a');
	});

	it('a fresh pin refreshes the keep-alive window past the original expiry', () => {
		store().pin('tab-a'); // expires at t = TTL
		vi.advanceTimersByTime(BROWSER_KEEPALIVE_TTL_MS / 2); // t = TTL/2, still active
		expect(activePinnedTabIds(store().pins)).toContain('tab-a');

		store().pin('tab-a'); // refresh: now expires at t = TTL/2 + TTL

		// Advance so total elapsed since the FIRST pin exceeds the TTL, but stays
		// inside the TTL measured from the refresh. Without the refresh the pin
		// would already be gone here; because we refreshed, it survives.
		vi.advanceTimersByTime(BROWSER_KEEPALIVE_TTL_MS - 10_000);
		// Sanity: total elapsed is past one TTL from the first pin.
		expect(Date.now()).toBeGreaterThan(BROWSER_KEEPALIVE_TTL_MS);
		expect(activePinnedTabIds(store().pins)).toContain('tab-a');
	});

	it('clear() drops every pin', () => {
		store().pin('tab-a');
		store().pin('tab-b');
		expect(activePinnedTabIds(store().pins).sort()).toEqual(['tab-a', 'tab-b']);
		store().clear();
		expect(store().pins).toEqual({});
	});

	it('activePinnedTabIds excludes an already-expired entry regardless of the timer', () => {
		// Directly seed an entry whose expiry is in the past (defends the strict
		// `expiry > now` predicate, not the timer path).
		useCoworkingBrowserKeepAliveStore.setState({
			pins: { 'stale-tab': Date.now() - 1, 'live-tab': Date.now() + BROWSER_KEEPALIVE_TTL_MS },
		});
		const active = activePinnedTabIds(store().pins);
		expect(active).toContain('live-tab');
		expect(active).not.toContain('stale-tab');
	});
});
