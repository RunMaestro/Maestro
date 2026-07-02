import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBrowserTabMounting } from '../../../renderer/hooks/browser/useBrowserTabMounting';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { BrowserTab, Session } from '../../../renderer/types';

function makeBrowserTab(id: string): BrowserTab {
	return {
		id,
		url: `file:///${id}.html`,
		title: id,
		createdAt: 0,
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	};
}

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		cwd: '/test',
		fullPath: '/test',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		browserTabs: [],
		activeBrowserTabId: null,
		isGitRepo: false,
		bookmarked: false,
		...overrides,
	} as Session;
}

function setPolicy(keepAlive: 'off' | 'recent' | 'all', limit = 10) {
	useSettingsStore.setState({ browserTabKeepAlive: keepAlive, browserTabKeepAliveLimit: limit });
}

/** Build an active group whose layout tiles the given browser tab ids as leaves. */
function withBrowserGroup(overrides: Partial<Session>, browserLeafIds: string[]): Session {
	const children = browserLeafIds.map((id, i) => ({
		kind: 'leaf' as const,
		id: `leaf-${i}`,
		tab: { type: 'browser' as const, id },
	}));
	const group = {
		id: 'g1',
		name: 'Group',
		createdAt: 0,
		focusedPaneId: 'leaf-0',
		layout: {
			kind: 'split' as const,
			id: 'split-1',
			direction: 'row' as const,
			sizes: children.map(() => 1 / children.length),
			children,
		},
	};
	return makeSession({ ...overrides, tabGroups: [group], activeGroupId: 'g1' } as Partial<Session>);
}

describe('useBrowserTabMounting', () => {
	beforeEach(() => {
		setPolicy('off', 10);
	});

	it('returns empty for a null session', () => {
		const { result } = renderHook(() => useBrowserTabMounting(null));
		expect(result.current).toEqual([]);
	});

	it("'off' mounts only the active browser tab", () => {
		const session = makeSession({
			browserTabs: [makeBrowserTab('a'), makeBrowserTab('b'), makeBrowserTab('c')],
			activeBrowserTabId: 'b',
		});
		const { result } = renderHook(() => useBrowserTabMounting(session));
		expect(result.current).toEqual(['b']);
	});

	it("'off' mounts nothing when no browser tab is active", () => {
		const session = makeSession({
			browserTabs: [makeBrowserTab('a'), makeBrowserTab('b')],
			activeBrowserTabId: null,
		});
		const { result } = renderHook(() => useBrowserTabMounting(session));
		expect(result.current).toEqual([]);
	});

	it("'all' mounts every browser tab in live order", () => {
		setPolicy('all');
		const session = makeSession({
			browserTabs: [makeBrowserTab('a'), makeBrowserTab('b'), makeBrowserTab('c')],
			activeBrowserTabId: 'b',
		});
		const { result } = renderHook(() => useBrowserTabMounting(session));
		expect(result.current).toEqual(['a', 'b', 'c']);
	});

	it("'recent' keeps the N most-recently-active tabs, evicting the least recent", () => {
		setPolicy('recent', 2);
		const tabs = [makeBrowserTab('a'), makeBrowserTab('b'), makeBrowserTab('c')];
		const { result, rerender } = renderHook(({ s }) => useBrowserTabMounting(s), {
			initialProps: { s: makeSession({ browserTabs: tabs, activeBrowserTabId: 'a' }) },
		});
		// Activate a → b → c. Recency: [c, b, a]; with limit 2, 'a' is evicted.
		rerender({ s: makeSession({ browserTabs: tabs, activeBrowserTabId: 'b' }) });
		rerender({ s: makeSession({ browserTabs: tabs, activeBrowserTabId: 'c' }) });
		// Emitted in live order, filtered to the kept set {b, c}.
		expect(result.current).toEqual(['b', 'c']);
	});

	it("'recent' always includes the active tab even before recency catches up", () => {
		setPolicy('recent', 1);
		const tabs = [makeBrowserTab('a'), makeBrowserTab('b')];
		const { result, rerender } = renderHook(({ s }) => useBrowserTabMounting(s), {
			initialProps: { s: makeSession({ browserTabs: tabs, activeBrowserTabId: 'a' }) },
		});
		rerender({ s: makeSession({ browserTabs: tabs, activeBrowserTabId: 'b' }) });
		expect(result.current).toEqual(['b']);
	});

	it('drops tabs that were closed from the mounted set', () => {
		setPolicy('all');
		const { result, rerender } = renderHook(({ s }) => useBrowserTabMounting(s), {
			initialProps: {
				s: makeSession({
					browserTabs: [makeBrowserTab('a'), makeBrowserTab('b')],
					activeBrowserTabId: 'a',
				}),
			},
		});
		expect(result.current).toEqual(['a', 'b']);
		rerender({ s: makeSession({ browserTabs: [makeBrowserTab('a')], activeBrowserTabId: 'a' }) });
		expect(result.current).toEqual(['a']);
	});

	it("'off' still mounts a browser tab tiled into the active group (no active standalone tab)", () => {
		// Regression: while a group is active, activeBrowserTabId is null, so 'off'
		// used to mount nothing - a tiled browser pane rendered blank.
		const session = withBrowserGroup(
			{
				browserTabs: [makeBrowserTab('a'), makeBrowserTab('b'), makeBrowserTab('c')],
				activeBrowserTabId: null,
			},
			['b']
		);
		const { result } = renderHook(() => useBrowserTabMounting(session));
		expect(result.current).toEqual(['b']);
	});

	it("'off' mounts both the active standalone tab and a tiled group browser pane", () => {
		const session = withBrowserGroup(
			{
				browserTabs: [makeBrowserTab('a'), makeBrowserTab('b'), makeBrowserTab('c')],
				activeBrowserTabId: 'a',
			},
			['c']
		);
		const { result } = renderHook(() => useBrowserTabMounting(session));
		// Emitted in live order: a (active) and c (tiled).
		expect(result.current).toEqual(['a', 'c']);
	});

	it("'recent' mounts tiled group browser panes beyond the LRU cap", () => {
		setPolicy('recent', 1);
		// Two browser panes tiled; even with cap 1 both must mount.
		const session = withBrowserGroup(
			{
				browserTabs: [makeBrowserTab('a'), makeBrowserTab('b'), makeBrowserTab('c')],
				activeBrowserTabId: null,
			},
			['a', 'c']
		);
		const { result } = renderHook(() => useBrowserTabMounting(session));
		expect(result.current).toEqual(['a', 'c']);
	});

	it('does not mount a group browser leaf whose tab no longer exists', () => {
		const session = withBrowserGroup(
			{ browserTabs: [makeBrowserTab('a')], activeBrowserTabId: null },
			['gone']
		);
		const { result } = renderHook(() => useBrowserTabMounting(session));
		expect(result.current).toEqual([]);
	});

	it("does not keep a previous agent's tabs alive after switching agents", () => {
		setPolicy('recent', 10);
		const agent1 = makeSession({
			id: 'agent-1',
			browserTabs: [makeBrowserTab('a1'), makeBrowserTab('b1')],
			activeBrowserTabId: 'a1',
		});
		const { result, rerender } = renderHook(({ s }) => useBrowserTabMounting(s), {
			initialProps: { s: agent1 },
		});
		rerender({ s: makeSession({ ...agent1, activeBrowserTabId: 'b1' }) as Session });
		// Switch to a different agent with its own tabs.
		const agent2 = makeSession({
			id: 'agent-2',
			browserTabs: [makeBrowserTab('a2')],
			activeBrowserTabId: 'a2',
		});
		rerender({ s: agent2 });
		expect(result.current).toEqual(['a2']);
	});
});
