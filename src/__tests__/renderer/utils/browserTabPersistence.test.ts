import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BROWSER_TAB_URL,
	DEFAULT_BROWSER_TAB_TITLE,
	getBrowserTabLabel,
	getBrowserTabPartition,
	getBrowserTabTitle,
	getEphemeralBrowserTabPartition,
	getSafeBrowserTabPartition,
	isEphemeralBrowserTab,
	isHttpBrowserTabUrl,
	normalizeBrowserTabUrl,
	sanitizeBrowserTabForPersistence,
	resolveBrowserTabNavigationTarget,
} from '../../../renderer/utils/browserTabPersistence';
import type { BrowserTab } from '../../../renderer/types';

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

		describe('isHttpBrowserTabUrl', () => {
			it('accepts http and https URLs', () => {
				expect(isHttpBrowserTabUrl('http://example.com')).toBe(true);
				expect(isHttpBrowserTabUrl('https://example.com/docs?q=1')).toBe(true);
			});

			it('rejects dangerous and non-http schemes', () => {
				// eslint-disable-next-line no-script-url
				expect(isHttpBrowserTabUrl('javascript:alert(1)')).toBe(false);
				expect(isHttpBrowserTabUrl('data:text/html,<script>1</script>')).toBe(false);
				expect(isHttpBrowserTabUrl('file:///etc/passwd')).toBe(false);
				expect(isHttpBrowserTabUrl(DEFAULT_BROWSER_TAB_URL)).toBe(false);
			});

			it('rejects empty and unparseable values', () => {
				expect(isHttpBrowserTabUrl('')).toBe(false);
				expect(isHttpBrowserTabUrl(null)).toBe(false);
				expect(isHttpBrowserTabUrl(undefined)).toBe(false);
				expect(isHttpBrowserTabUrl('not a url')).toBe(false);
			});
		});

		describe('getBrowserTabLabel', () => {
			// Build a BrowserTab with sensible defaults so each case only sets the
			// fields under test (customTitle / title / url).
			const makeTab = (overrides: Partial<BrowserTab>): BrowserTab => ({
				id: 'browser-1',
				url: 'https://example.com/docs',
				title: '',
				createdAt: 1,
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
				...overrides,
			});

			it('prefers a user-assigned customTitle over the page title and URL', () => {
				expect(getBrowserTabLabel(makeTab({ customTitle: 'My Tab', title: 'Page Title' }))).toBe(
					'My Tab'
				);
			});

			it('ignores a blank/whitespace customTitle and falls back to the page title', () => {
				expect(getBrowserTabLabel(makeTab({ customTitle: '   ', title: 'Page Title' }))).toBe(
					'Page Title'
				);
			});

			it('uses the page title when no customTitle is set', () => {
				expect(getBrowserTabLabel(makeTab({ title: 'Page Title' }))).toBe('Page Title');
			});

			it('falls back to the URL host when neither customTitle nor title is set', () => {
				expect(getBrowserTabLabel(makeTab({ title: '', url: 'https://fallback.com/path' }))).toBe(
					'fallback.com'
				);
			});

			it('uses the default new-tab title for the blank URL with no titles', () => {
				expect(getBrowserTabLabel(makeTab({ title: '', url: DEFAULT_BROWSER_TAB_URL }))).toBe(
					DEFAULT_BROWSER_TAB_TITLE
				);
			});

			it('returns the raw string when the URL cannot be parsed', () => {
				expect(getBrowserTabLabel(makeTab({ title: '', url: 'not a url' }))).toBe('not a url');
			});
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

		describe('ephemeral (incognito) partitions', () => {
			const baseTab: BrowserTab = {
				id: 'browser-eph',
				url: 'https://example.com',
				title: 'Example',
				createdAt: 1,
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			};

			it('mints partitions that satisfy the main-process clear/attach gates', () => {
				// Must match EPHEMERAL_BROWSER_TAB_PARTITION_PATTERN in
				// src/main/ipc/handlers/browser-session.ts (and the will-attach-webview
				// allowlist): a minted incognito partition that fails those gates would
				// make ephemeral tabs unattachable/unclearable.
				const partition = getEphemeralBrowserTabPartition(' My Session/1! ');
				expect(partition).toMatch(/^maestro-ephemeral-[A-Za-z0-9_-]+-[a-z0-9]{8}$/);
				// No persist: scheme — Electron must keep the data in memory only.
				expect(partition.startsWith('persist:')).toBe(false);
			});

			it('mints a distinct partition per call so incognito tabs never share state', () => {
				expect(getEphemeralBrowserTabPartition('s')).not.toBe(getEphemeralBrowserTabPartition('s'));
			});

			it('isEphemeralBrowserTab recognizes the flag OR the partition prefix', () => {
				expect(isEphemeralBrowserTab({ ...baseTab, ephemeral: true })).toBe(true);
				expect(
					isEphemeralBrowserTab({ ...baseTab, partition: 'maestro-ephemeral-s-a1b2c3d4' })
				).toBe(true);
				expect(
					isEphemeralBrowserTab({ ...baseTab, partition: 'persist:maestro-browser-session-s' })
				).toBe(false);
				expect(isEphemeralBrowserTab(baseTab)).toBe(false);
			});
		});
	});
});
