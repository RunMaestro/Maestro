import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BROWSER_TAB_URL,
	DEFAULT_BROWSER_TAB_TITLE,
	getBrowserTabPartition,
	getBrowserTabTitle,
	getSafeBrowserTabPartition,
	normalizeBrowserTabUrl,
	sanitizeBrowserTabForPersistence,
	resolveBrowserTabNavigationTarget,
} from '../../../renderer/utils/browserTabPersistence';

describe('browserTabPersistence', () => {
	describe('resolveBrowserTabNavigationTarget', () => {
		it('normalizes localhost addresses to http URLs', () => {
			expect(resolveBrowserTabNavigationTarget('localhost:5173/docs')).toEqual({
				kind: 'url',
				url: 'http://localhost:5173/docs',
			});
		});

		it('normalizes bare hosts to https URLs', () => {
			expect(resolveBrowserTabNavigationTarget('example.com/docs')).toEqual({
				kind: 'url',
				url: 'https://example.com/docs',
			});
		});

		it('converts free text into a search URL', () => {
			expect(resolveBrowserTabNavigationTarget('maestro browser tabs')).toEqual({
				kind: 'url',
				url: 'https://www.google.com/search?q=maestro%20browser%20tabs',
			});
		});

		it('rejects blocked protocols', () => {
			expect(resolveBrowserTabNavigationTarget('javascript:alert(1)')).toEqual({
				kind: 'error',
				message: 'Protocol not allowed in browser tabs: javascript:',
			});
		});

		it('treats blank input as a safe default URL', () => {
			expect(resolveBrowserTabNavigationTarget('   ')).toEqual({
				kind: 'url',
				url: DEFAULT_BROWSER_TAB_URL,
			});
		});
	});

	describe('helpers', () => {
		it('falls back to about:blank when normalization hits a blocked protocol', () => {
			expect(normalizeBrowserTabUrl('javascript:alert(1)')).toBe(DEFAULT_BROWSER_TAB_URL);
		});

		it('derives a human-friendly title from a URL when page title is empty', () => {
			expect(getBrowserTabTitle('https://example.com/docs', '')).toBe('example.com');
		});

		it('uses the default new-tab title for about:blank without a page title', () => {
			expect(getBrowserTabTitle(DEFAULT_BROWSER_TAB_URL, '')).toBe(DEFAULT_BROWSER_TAB_TITLE);
		});

		it('sanitizes session ids when deriving persisted browser partitions', () => {
			expect(getBrowserTabPartition(' session / branch:1 ')).toBe(
				'persist:maestro-browser-session-session-branch-1'
			);
		});

		it('keeps safe persisted partitions and repairs unsafe ones', () => {
			expect(
				getSafeBrowserTabPartition('persist:maestro-browser-session-session-1', 'session-1')
			).toBe('persist:maestro-browser-session-session-1');
			expect(getSafeBrowserTabPartition('persist:evil', 'session-1')).toBe(
				'persist:maestro-browser-session-session-1'
			);
		});

		it('sanitizes persisted browser tabs to stable restart-safe state', () => {
			expect(
				sanitizeBrowserTabForPersistence(
					{
						id: 'browser-1',
						url: 'localhost:3000/docs',
						title: '',
						createdAt: 1,
						partition: 'persist:evil',
						canGoBack: true,
						canGoForward: true,
						isLoading: true,
						favicon: undefined,
						webContentsId: 99,
					},
					'session-1'
				)
			).toMatchObject({
				id: 'browser-1',
				url: 'http://localhost:3000/docs',
				title: 'localhost:3000',
				partition: 'persist:maestro-browser-session-session-1',
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
				favicon: null,
			});
		});

		it('repairs missing browser tab fields to safe defaults during persistence', () => {
			expect(
				sanitizeBrowserTabForPersistence(
					{
						id: 'browser-2',
						url: '',
						title: '',
						createdAt: 1,
						canGoBack: false,
						canGoForward: false,
						isLoading: false,
					},
					'session / 2'
				)
			).toMatchObject({
				id: 'browser-2',
				url: DEFAULT_BROWSER_TAB_URL,
				title: DEFAULT_BROWSER_TAB_TITLE,
				partition: 'persist:maestro-browser-session-session-2',
				favicon: null,
			});
		});
	});
});
