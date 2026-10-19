import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useTabWindowStore,
	isTabPoppedOut,
	getPoppedOutTabKeys,
	useIsTabPoppedOut,
	usePoppedOutTabKeys,
	startTabWindowStoreSync,
	isTabViewedInTabWindow,
	getTabWindowTabRefs,
} from '../../../renderer/stores/tabWindowStore';
import type { TabWindowInfo } from '../../../shared/tabWindowTypes';
import type { WindowSessionMovedPayload } from '../../../shared/window-types';

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

function tabWindow(overrides: Partial<TabWindowInfo> = {}): TabWindowInfo {
	return {
		windowId: 'tw-1',
		agentId: 'agent-a',
		tabRefs: [{ type: 'ai', id: 'tab-1' }],
		activeTabRef: { type: 'ai', id: 'tab-1' },
		...overrides,
	};
}

/** Lets the pending `list()` promise chain settle. */
async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe('tabWindowStore', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {}, viewedTabs: new Set() });
	});

	describe('isTabViewedInTabWindow (the owner unread rule)', () => {
		it('is true while the tab window reports the popped tab watched', () => {
			useTabWindowStore.getState().setWindows([tabWindow()]);
			useTabWindowStore.getState().setTabViewed('agent-a', 'tab-1', true);
			expect(isTabViewedInTabWindow('agent-a', 'tab-1')).toBe(true);
			expect(isTabViewedInTabWindow('agent-b', 'tab-1')).toBe(false);

			useTabWindowStore.getState().setTabViewed('agent-a', 'tab-1', false);
			expect(isTabViewedInTabWindow('agent-a', 'tab-1')).toBe(false);
		});

		it('is false for a tab that is not popped out, whatever was last reported', () => {
			useTabWindowStore.getState().setTabViewed('agent-a', 'tab-1', true);
			expect(isTabViewedInTabWindow('agent-a', 'tab-1')).toBe(false);
		});

		it('keeps its state object when nothing changes', () => {
			useTabWindowStore.getState().setTabViewed('agent-a', 'tab-1', true);
			const before = useTabWindowStore.getState().viewedTabs;
			useTabWindowStore.getState().setTabViewed('agent-a', 'tab-1', true);
			useTabWindowStore.getState().setTabViewed('agent-a', 'tab-2', false);
			expect(useTabWindowStore.getState().viewedTabs).toBe(before);
		});
	});

	describe('getTabWindowTabRefs', () => {
		it("lists an agent's popped tabs in its tab window's strip order", () => {
			useTabWindowStore.getState().setWindows([
				tabWindow({
					tabRefs: [
						{ type: 'file', id: 'f1' },
						{ type: 'ai', id: 'tab-1' },
					],
				}),
				tabWindow({ windowId: 'tw-2', agentId: 'agent-b', tabRefs: [{ type: 'ai', id: 'x' }] }),
			]);
			expect(getTabWindowTabRefs('agent-a')).toEqual([
				{ type: 'file', id: 'f1' },
				{ type: 'ai', id: 'tab-1' },
			]);
		});

		it('is empty for an agent with no tab window', () => {
			expect(getTabWindowTabRefs('agent-z')).toEqual([]);
		});
	});

	describe('isTabPoppedOut', () => {
		it('is false for every tab while nothing is popped out', () => {
			expect(isTabPoppedOut('agent-a', { type: 'ai', id: 'tab-1' })).toBe(false);
			expect(getPoppedOutTabKeys('agent-a').size).toBe(0);
		});

		it('names the popped tabs of the right agent only', () => {
			useTabWindowStore.getState().setWindows([
				tabWindow({
					tabRefs: [
						{ type: 'ai', id: 'tab-1' },
						{ type: 'terminal', id: 'term-1' },
					],
				}),
				tabWindow({ windowId: 'tw-2', agentId: 'agent-b', tabRefs: [{ type: 'file', id: 'f-1' }] }),
			]);
			expect(isTabPoppedOut('agent-a', { type: 'ai', id: 'tab-1' })).toBe(true);
			expect(isTabPoppedOut('agent-a', { type: 'terminal', id: 'term-1' })).toBe(true);
			expect(isTabPoppedOut('agent-a', { type: 'file', id: 'f-1' })).toBe(false);
			expect(isTabPoppedOut('agent-b', { type: 'file', id: 'f-1' })).toBe(true);
			expect(isTabPoppedOut('agent-b', { type: 'ai', id: 'tab-1' })).toBe(false);
		});

		it('matches on type and id, not id alone', () => {
			useTabWindowStore.getState().setWindows([tabWindow()]);
			expect(isTabPoppedOut('agent-a', { type: 'browser', id: 'tab-1' })).toBe(false);
		});

		it('is never true for a group ref', () => {
			useTabWindowStore.getState().setWindows([tabWindow()]);
			expect(isTabPoppedOut('agent-a', { type: 'group', id: 'tab-1' })).toBe(false);
		});

		it('gives an agent with an empty tab window no entry', () => {
			useTabWindowStore.getState().setWindows([tabWindow({ tabRefs: [], activeTabRef: null })]);
			expect(useTabWindowStore.getState().poppedByAgent).toEqual({});
		});
	});

	describe('setWindows', () => {
		it('keeps the Set of an agent whose tabs did not change', () => {
			const { setWindows } = useTabWindowStore.getState();
			setWindows([tabWindow(), tabWindow({ windowId: 'tw-2', agentId: 'agent-b' })]);
			const before = useTabWindowStore.getState().poppedByAgent;
			setWindows([
				tabWindow(),
				tabWindow({
					windowId: 'tw-2',
					agentId: 'agent-b',
					tabRefs: [
						{ type: 'ai', id: 'tab-1' },
						{ type: 'ai', id: 'tab-2' },
					],
				}),
			]);
			const after = useTabWindowStore.getState().poppedByAgent;
			expect(after['agent-a']).toBe(before['agent-a']);
			expect(after['agent-b']).not.toBe(before['agent-b']);
		});

		it('drops a docked tab', () => {
			const { setWindows } = useTabWindowStore.getState();
			setWindows([tabWindow()]);
			setWindows([]);
			expect(isTabPoppedOut('agent-a', { type: 'ai', id: 'tab-1' })).toBe(false);
		});
	});

	describe('hooks', () => {
		it('useIsTabPoppedOut follows the store', () => {
			const { result } = renderHook(() =>
				useIsTabPoppedOut('agent-a', { type: 'ai', id: 'tab-1' })
			);
			expect(result.current).toBe(false);
			act(() => useTabWindowStore.getState().setWindows([tabWindow()]));
			expect(result.current).toBe(true);
		});

		it('useIsTabPoppedOut is false without an agent id', () => {
			useTabWindowStore.getState().setWindows([tabWindow()]);
			const { result } = renderHook(() => useIsTabPoppedOut(null, { type: 'ai', id: 'tab-1' }));
			expect(result.current).toBe(false);
		});

		it('usePoppedOutTabKeys returns a stable empty Set, then the agent Set', () => {
			const { result, rerender } = renderHook(() => usePoppedOutTabKeys('agent-a'));
			const empty = result.current;
			rerender();
			expect(result.current).toBe(empty);
			expect(empty.size).toBe(0);
			act(() => useTabWindowStore.getState().setWindows([tabWindow()]));
			expect(result.current.has('ai:tab-1')).toBe(true);
		});
	});

	describe('startTabWindowStoreSync', () => {
		let broadcast: ((payload: WindowSessionMovedPayload) => void) | undefined;
		const list = vi.fn<() => Promise<TabWindowInfo[]>>();
		const unsubscribe = vi.fn();
		const originalTabWindows = window.maestro.tabWindows;

		beforeEach(() => {
			broadcast = undefined;
			list.mockReset();
			unsubscribe.mockReset();
			vi.mocked(window.maestro.windows.onSessionMoved).mockImplementation((callback) => {
				broadcast = callback as typeof broadcast;
				return unsubscribe;
			});
			(window.maestro as { tabWindows: unknown }).tabWindows = { list };
		});

		afterEach(() => {
			(window.maestro as { tabWindows: unknown }).tabWindows = originalTabWindows;
			vi.mocked(window.maestro.windows.onSessionMoved).mockImplementation(() => () => {});
		});

		it('hydrates from tabWindows:list() at start', async () => {
			list.mockResolvedValue([tabWindow()]);
			const stop = startTabWindowStoreSync();
			await flush();
			expect(list).toHaveBeenCalledTimes(1);
			expect(isTabPoppedOut('agent-a', { type: 'ai', id: 'tab-1' })).toBe(true);
			stop();
			expect(unsubscribe).toHaveBeenCalled();
		});

		it('re-reads on tab-window-changed and ignores other broadcasts', async () => {
			list.mockResolvedValueOnce([]).mockResolvedValueOnce([tabWindow()]);
			const stop = startTabWindowStoreSync();
			await flush();
			broadcast?.({ type: 'session-moved', sessionId: 'agent-a' });
			expect(list).toHaveBeenCalledTimes(1);
			broadcast?.({ type: 'tab-window-changed', windowId: 'tw-1', agentId: 'agent-a' });
			await flush();
			expect(list).toHaveBeenCalledTimes(2);
			expect(isTabPoppedOut('agent-a', { type: 'ai', id: 'tab-1' })).toBe(true);
			stop();
		});

		it('applies only the newest read when two land out of order', async () => {
			let resolveFirst: (value: TabWindowInfo[]) => void = () => {};
			list
				.mockImplementationOnce(
					() =>
						new Promise<TabWindowInfo[]>((resolve) => {
							resolveFirst = resolve;
						})
				)
				.mockResolvedValueOnce([]);
			const stop = startTabWindowStoreSync();
			broadcast?.({ type: 'tab-window-changed', windowId: 'tw-1', agentId: 'agent-a' });
			await flush();
			resolveFirst([tabWindow()]);
			await flush();
			expect(isTabPoppedOut('agent-a', { type: 'ai', id: 'tab-1' })).toBe(false);
			stop();
		});

		it('does nothing after stop', async () => {
			list.mockResolvedValue([tabWindow()]);
			const stop = startTabWindowStoreSync();
			stop();
			await flush();
			expect(isTabPoppedOut('agent-a', { type: 'ai', id: 'tab-1' })).toBe(false);
		});

		it('is a no-op without a tab windows API (web-desktop)', () => {
			(window.maestro as { tabWindows: unknown }).tabWindows = undefined;
			const subscribe = vi.mocked(window.maestro.windows.onSessionMoved);
			subscribe.mockClear();
			const stop = startTabWindowStoreSync();
			expect(subscribe).not.toHaveBeenCalled();
			stop();
		});
	});
});
