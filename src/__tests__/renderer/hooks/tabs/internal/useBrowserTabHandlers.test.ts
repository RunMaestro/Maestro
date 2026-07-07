import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useBrowserTabHandlers';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import {
	createMockAITab,
	createMockBrowserTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from './testUtils';

describe('useBrowserTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
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
});
