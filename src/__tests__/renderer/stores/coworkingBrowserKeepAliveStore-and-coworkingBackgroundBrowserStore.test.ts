// Source: src/__tests__/renderer/stores/coworkingBrowserKeepAliveStore.test.ts
// Source: src/__tests__/renderer/stores/coworkingBackgroundBrowserStore.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import { useCoworkingBrowserKeepAliveStore } from '../../../renderer/stores/coworkingBrowserKeepAliveStore';
import { activePinnedTabIds } from '../../../renderer/stores/coworkingBrowserKeepAliveStore';
import { BROWSER_KEEPALIVE_TTL_MS } from '../../../renderer/stores/coworkingBrowserKeepAliveStore';
import { useCoworkingBackgroundBrowserStore } from '../../../renderer/stores/coworkingBackgroundBrowserStore';
import { backgroundBrowserKey } from '../../../renderer/stores/coworkingBackgroundBrowserStore';
import type { BrowserTabViewHandle } from '../../../renderer/components/MainPanel/BrowserTabView';
describeSourceSuite('coworkingBrowserKeepAliveStore', () => {
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
});
describeSourceSuite('coworkingBackgroundBrowserStore', () => {
	function fakeHandle(tabId: string): BrowserTabViewHandle {
		return { getTabId: () => tabId } as unknown as BrowserTabViewHandle;
	}

	const store = () => useCoworkingBackgroundBrowserStore.getState();
	const key = backgroundBrowserKey;

	describe('coworkingBackgroundBrowserStore', () => {
		let nowVal = 1000;

		beforeEach(() => {
			nowVal = 1000;
			// Monotonic clock so LRU ordering is deterministic across platforms.
			vi.spyOn(Date, 'now').mockImplementation(() => (nowVal += 10));
			useCoworkingBackgroundBrowserStore.setState({ mounts: [], handles: new Map() });
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('requestMount adds a mount and dedups by key', () => {
			store().requestMount('sess-A', 'u-1', 3);
			store().requestMount('sess-A', 'u-1', 3);
			const { mounts } = store();
			expect(mounts).toHaveLength(1);
			expect(mounts[0].key).toBe(key('sess-A', 'u-1'));
		});

		it('LRU-evicts the least-recently-used mount beyond the cap', () => {
			store().requestMount('sess-A', 'u-1', 2);
			store().requestMount('sess-A', 'u-2', 2);
			// Touch u-1 so u-2 becomes the least-recently-used of the two.
			store().touch(key('sess-A', 'u-1'));
			store().requestMount('sess-A', 'u-3', 2);
			const keys = store().mounts.map((m) => m.key);
			expect(keys).toHaveLength(2);
			expect(keys).toContain(key('sess-A', 'u-3'));
			expect(keys).toContain(key('sess-A', 'u-1'));
			expect(keys).not.toContain(key('sess-A', 'u-2'));
		});

		it('clamps the cap to at least 1', () => {
			store().requestMount('sess-A', 'u-1', 0);
			store().requestMount('sess-A', 'u-2', 0);
			expect(store().mounts).toHaveLength(1);
		});

		it('clamps the cap to at most 10', () => {
			for (let i = 0; i < 15; i++) store().requestMount('sess-A', `u-${i}`, 999);
			expect(store().mounts).toHaveLength(10);
		});

		it('setHandle registers and clears a handle', () => {
			const k = key('sess-A', 'u-1');
			store().setHandle(k, fakeHandle('u-1'));
			expect(store().handles.get(k)?.getTabId()).toBe('u-1');
			store().setHandle(k, null);
			expect(store().handles.has(k)).toBe(false);
		});

		it('clear drops all mounts and handles', () => {
			store().requestMount('sess-A', 'u-1', 3);
			store().setHandle(key('sess-A', 'u-1'), fakeHandle('u-1'));
			store().clear();
			expect(store().mounts).toHaveLength(0);
			expect(store().handles.size).toBe(0);
		});
	});

	describe('coworkingBackgroundBrowserStore pruneMounts (closed-tab cleanup)', () => {
		// Singleton: clear() also drops the module-level in-flight guard so a
		// markOpStart from one test can't leak into the next or a later file.
		beforeEach(() => {
			store().clear();
		});
		afterEach(() => {
			store().clear();
		});

		it('drops mounts + handles for closed tabs while keeping live ones', () => {
			store().requestMount('s1', 'A', 5);
			store().requestMount('s1', 'B', 5);
			store().setHandle(key('s1', 'A'), fakeHandle('A'));
			store().setHandle(key('s1', 'B'), fakeHandle('B'));
			expect([...store().mounts.map((m) => m.key)].sort()).toEqual(
				[key('s1', 'A'), key('s1', 'B')].sort()
			);

			// Only A is still a live tab; B was closed.
			store().pruneMounts((_sid, uuid) => uuid === 'A');

			expect(store().mounts.map((m) => m.key)).toEqual([key('s1', 'A')]);
			expect(store().handles.has(key('s1', 'A'))).toBe(true);
			expect(store().handles.has(key('s1', 'B'))).toBe(false);
		});

		it('never prunes a mount with an op in flight, then reclaims it once it ends', () => {
			store().requestMount('s1', 'B', 5);
			store().setHandle(key('s1', 'B'), fakeHandle('B'));
			store().markOpStart(key('s1', 'B'));

			// Nothing is live, but B has an op in flight: it MUST be kept, otherwise
			// unmounting its webview mid-op would make the op spuriously fail.
			store().pruneMounts(() => false);
			expect(store().mounts.map((m) => m.key)).toEqual([key('s1', 'B')]);
			expect(store().handles.has(key('s1', 'B'))).toBe(true);

			// Once the op ends, the same prune reclaims the now-dead mount + handle.
			store().markOpEnd(key('s1', 'B'));
			store().pruneMounts(() => false);
			expect(store().mounts).toHaveLength(0);
			expect(store().handles.has(key('s1', 'B'))).toBe(false);
		});
	});
});
