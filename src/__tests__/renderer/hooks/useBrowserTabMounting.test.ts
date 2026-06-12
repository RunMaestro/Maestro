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
