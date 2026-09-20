import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BROWSER_TAB_URL,
	DEFAULT_BROWSER_TAB_TITLE,
	getBrowserTabLabel,
	getBrowserTabPartition,
	getBrowserTabTitle,
	getSafeBrowserTabPartition,
	normalizeBrowserTabUrl,
	sanitizeBrowserTabForPersistence,
	resolveBrowserTabNavigationTarget,
	toWebviewSrc,
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

		// `looksLikeLocalAddress` matches the SHAPE of a loopback host, so it also
		// accepts values the URL parser rejects. These used to escape as a thrown
		// TypeError instead of the documented `{ kind: 'error' }` result.
		it.each([
			['localhost:99999', 'an out-of-range port'],
			['127.999.999.999', 'an out-of-range IPv4 octet'],
			['0.0.0.0:70000', 'an out-of-range port on a bare IPv4 host'],
		])('reports %s (%s) as an error instead of throwing', (input) => {
			expect(resolveBrowserTabNavigationTarget(input)).toEqual({
				kind: 'error',
				message: 'Enter a valid URL or search term',
			});
		});
	});

	describe('toWebviewSrc', () => {
		it('passes through a parseable URL unchanged', () => {
			expect(toWebviewSrc('https://example.com/docs')).toBe('https://example.com/docs');
		});

		it('keeps about:blank', () => {
			expect(toWebviewSrc(DEFAULT_BROWSER_TAB_URL)).toBe(DEFAULT_BROWSER_TAB_URL);
		});

		// Electron parses the `src` attribute with `new URL()` while attaching the
		// element, so any of these would throw mid-render (MAESTRO-QX/QY/QZ).
		it.each(['http://', 'https://[bad', 'https://x y', 'http://localhost:99999'])(
			'falls back to about:blank for the unparseable URL %s',
			(input) => {
				expect(toWebviewSrc(input)).toBe(DEFAULT_BROWSER_TAB_URL);
			}
		);

		it('falls back to about:blank for a missing URL', () => {
			expect(toWebviewSrc('')).toBe(DEFAULT_BROWSER_TAB_URL);
			expect(toWebviewSrc('   ')).toBe(DEFAULT_BROWSER_TAB_URL);
			expect(toWebviewSrc(null)).toBe(DEFAULT_BROWSER_TAB_URL);
			expect(toWebviewSrc(undefined)).toBe(DEFAULT_BROWSER_TAB_URL);
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
	});
});
