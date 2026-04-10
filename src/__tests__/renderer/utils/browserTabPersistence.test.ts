import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BROWSER_TAB_URL,
	getBrowserTabTitle,
	normalizeBrowserTabUrl,
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
	});
});
