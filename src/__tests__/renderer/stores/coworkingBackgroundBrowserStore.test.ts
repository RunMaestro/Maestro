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
