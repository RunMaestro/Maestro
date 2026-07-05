import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	useCoworkingBackgroundBrowserStore,
	backgroundBrowserKey,
} from '../../../renderer/stores/coworkingBackgroundBrowserStore';
import type { BrowserTabViewHandle } from '../../../renderer/components/MainPanel/BrowserTabView';

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
