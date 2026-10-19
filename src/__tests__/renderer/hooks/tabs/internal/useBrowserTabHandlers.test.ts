import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useBrowserTabHandlers';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import {
	createMockAITab,
	createMockBrowserTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from './testUtils';
import { updateSessionWith } from '../../../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../../../renderer/stores/uiStore';
import type { BrowserTab } from '../../../../../shared/browserPage';
import { isWebDesktop } from '../../../../../renderer/utils/runtimeContext';
import { recordJourney } from '../../../../../renderer/services/userJourney';

vi.mock('../../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

vi.mock('../../../../../renderer/services/userJourney', () => ({
	recordJourney: vi.fn(),
}));

describe('useBrowserTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		vi.mocked(isWebDesktop).mockReturnValue(false);
		vi.mocked(recordJourney).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('creates and activates a browser tab using the configured home URL', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		useSettingsStore.setState({ browserHomeUrl: 'https://home.example/' } as any);
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleNewBrowserTab();
		});

		const browserTab = getSession().browserTabs[0];
		expect(browserTab).toMatchObject({
			url: 'https://home.example/',
			title: 'https://home.example/',
			isLoading: true,
		});
		expect(getSession().activeBrowserTabId).toBe(browserTab.id);
	});

	it('leaves an active tiled group when creating a new browser tab', () => {
		// A new standalone browser tab must take over the panel; if the group stays
		// active it keeps winning the render precedence and focus never shifts.
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleNewBrowserTab();
		});

		expect(getSession().activeGroupId).toBeNull();
		expect(getSession().activeBrowserTabId).toBe(getSession().browserTabs[0].id);
	});

	it('leaves an active tiled group when opening an explicit URL', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleOpenBrowserTabAt('https://example.com/');
		});

		expect(getSession().activeGroupId).toBeNull();
	});

	it('opens an explicit URL and ignores empty URLs', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleOpenBrowserTabAt('');
			result.current.handleOpenBrowserTabAt('file:///tmp/report.html', { title: 'Report' });
		});

		expect(getSession().browserTabs).toHaveLength(1);
		expect(getSession().browserTabs[0]).toMatchObject({
			url: 'file:///tmp/report.html',
			title: 'Report',
			isLoading: true,
		});
	});

	it('selects an existing browser tab and repairs missing unified order', () => {
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
			browserTabs: [browserTab],
			unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
		});
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleSelectBrowserTab('browser-1');
		});

		expect(getSession().activeBrowserTabId).toBe('browser-1');
		expect(getSession().activeFileTabId).toBeNull();
		expect(getSession().unifiedTabOrder).toContainEqual({ type: 'browser', id: 'browser-1' });
	});

	it('closes a browser tab and records it in unified history', () => {
		const aiTab = createMockAITab({ id: 'ai-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
			aiTabs: [aiTab],
			browserTabs: [browserTab],
			activeBrowserTabId: browserTab.id,
			unifiedTabOrder: [
				{ type: 'ai', id: aiTab.id },
				{ type: 'browser', id: browserTab.id },
			],
		});
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleCloseBrowserTab('browser-1');
		});

		expect(getSession().browserTabs).toHaveLength(0);
		expect(getSession().activeTabId).toBe('ai-1');
		expect(getSession().unifiedClosedTabHistory?.[0]).toMatchObject({
			type: 'browser',
		});
	});

	it('updates a browser tab in the owning session even when it is not active', () => {
		const browserTab = createMockBrowserTab({ id: 'browser-1', title: '' });
		setupSession({
			id: 'owner-session',
			browserTabs: [browserTab],
		});
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleUpdateBrowserTab('owner-session', 'browser-1', {
				url: 'example.com/docs',
				title: '',
			});
		});

		expect(getSession().browserTabs[0]).toMatchObject({
			url: 'https://example.com/docs',
			title: 'example.com',
		});
	});
	it('does not create a client tab before host acknowledgement or duplicate a preceding host snapshot', async () => {
		vi.mocked(isWebDesktop).mockReturnValue(true);
		const sessionId = setupSession({ activeGroupId: 'client-group' });
		const acknowledged = Promise.withResolvers<BrowserTab>();
		const originalApi = window.maestro.browserSession;
		window.maestro.browserSession = { ...originalApi, createTab: () => acknowledged.promise };
		const hostTab = createMockBrowserTab({
			id: 'host-incognito',
			partition: 'maestro-ephemeral-host-12345678',
			ephemeral: true,
		});
		try {
			const { result } = renderHook(() => useBrowserTabHandlers());
			act(() => result.current.handleNewBrowserTab({ ephemeral: true }));
			expect(getSession().browserTabs).toEqual([]);
			expect(getSession().activeGroupId).toBe('client-group');
			act(() =>
				updateSessionWith(sessionId, (session) => ({
					...session,
					browserTabs: [hostTab],
					unifiedTabOrder: [...session.unifiedTabOrder, { type: 'browser', id: hostTab.id }],
				}))
			);
			await act(async () => {
				acknowledged.resolve(hostTab);
				await acknowledged.promise;
			});
			expect(getSession().browserTabs).toEqual([hostTab]);
			expect(getSession().unifiedTabOrder.filter((ref) => ref.type === 'browser')).toEqual([
				{ type: 'browser', id: hostTab.id },
			]);
			expect(getSession().activeBrowserTabId).toBe(hostTab.id);
			expect(getSession().activeGroupId).toBeNull();
			expect(useUIStore.getState().focusRequest).toEqual({
				tab: { type: 'browser', id: hostTab.id },
			});
		} finally {
			window.maestro.browserSession = originalApi;
		}
	});

	describe('User Journey recording', () => {
		it('records browser.open for a new tab, without the query string or fragment', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			useSettingsStore.setState({
				browserHomeUrl: 'https://home.example/start?token=abc#top',
			} as any);
			const { result } = renderHook(() => useBrowserTabHandlers());

			act(() => {
				result.current.handleNewBrowserTab();
			});

			expect(recordJourney).toHaveBeenCalledTimes(1);
			expect(recordJourney).toHaveBeenCalledWith('test-session', {
				kind: 'browser.open',
				target: 'https://home.example/start',
				tabId: getSession().browserTabs[0].id,
			});
		});

		it('records the title of a tab opened at a URL when it is not just the URL', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useBrowserTabHandlers());

			act(() => {
				result.current.handleOpenBrowserTabAt('file:///tmp/report.html', { title: 'Report' });
			});

			expect(recordJourney).toHaveBeenCalledWith('test-session', {
				kind: 'browser.open',
				target: 'file:///tmp/report.html',
				tabId: getSession().browserTabs[0].id,
				title: 'Report',
			});
		});

		it('records nothing for a private (ephemeral) tab', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useBrowserTabHandlers());

			act(() => {
				result.current.handleNewBrowserTab({ ephemeral: true });
			});
			const tabId = getSession().browserTabs[0].id;
			act(() => {
				result.current.handleCloseBrowserTab(tabId);
			});

			expect(recordJourney).not.toHaveBeenCalled();
		});

		it('records browser.open for a web-desktop tab once the host acknowledges it', async () => {
			vi.mocked(isWebDesktop).mockReturnValue(true);
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const hostTab = createMockBrowserTab({ id: 'host-tab', url: 'https://a.example/?q=1' });
			const originalApi = window.maestro.browserSession;
			window.maestro.browserSession = {
				...originalApi,
				createTab: () => Promise.resolve(hostTab),
			};
			try {
				const { result } = renderHook(() => useBrowserTabHandlers());
				await act(async () => {
					result.current.handleNewBrowserTab();
				});
				expect(recordJourney).toHaveBeenCalledWith('test-session', {
					kind: 'browser.open',
					target: 'https://a.example/',
					tabId: 'host-tab',
				});
			} finally {
				window.maestro.browserSession = originalApi;
			}
		});

		it('records browser.close with dwell time and a sanitized URL', () => {
			vi.useFakeTimers();
			try {
				vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
				const browserTab = createMockBrowserTab({
					id: 'browser-1',
					url: 'https://example.com/docs?token=abc#section',
					createdAt: Date.now() - 90_000,
				});
				setupSession({
					aiTabs: [createMockAITab({ id: 'ai-1' })],
					browserTabs: [browserTab],
					activeBrowserTabId: browserTab.id,
				});
				const { result } = renderHook(() => useBrowserTabHandlers());

				act(() => {
					result.current.handleCloseBrowserTab('browser-1');
				});

				expect(recordJourney).toHaveBeenCalledWith('test-session', {
					kind: 'browser.close',
					target: 'https://example.com/docs',
					tabId: 'browser-1',
					dwellMs: 90_000,
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it('records no close for a tab the active agent does not hold', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useBrowserTabHandlers());

			act(() => {
				result.current.handleCloseBrowserTab('missing-tab');
			});

			expect(recordJourney).not.toHaveBeenCalled();
		});
	});
});
