import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createBrowserTab,
	normalizeBrowserTabUpdates,
} from '../../../../../renderer/hooks/tabs/internal/browserTabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../../../../renderer/utils/browserTabPersistence';
import { createMockBrowserTab } from './testUtils';

describe('browserTabHelpers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('creates a home browser tab with partition and default title', () => {
		vi.spyOn(Date, 'now').mockReturnValue(1234);

		const tab = createBrowserTab('session/one', DEFAULT_BROWSER_TAB_URL, { isLoading: false });

		expect(tab.title).toBe('New Tab');
		expect(tab.createdAt).toBe(1234);
		expect(tab.partition).toBe('persist:maestro-browser-session-session-one');
		expect(tab.isLoading).toBe(false);
	});

	it('creates a loading browser tab for an explicit URL', () => {
		const tab = createBrowserTab('session-1', 'https://example.com/docs', {
			title: 'Docs',
			isLoading: true,
		});

		expect(tab.url).toBe('https://example.com/docs');
		expect(tab.title).toBe('Docs');
		expect(tab.isLoading).toBe(true);
	});

	it('normalizes updated URLs and derives the title when blank', () => {
		const tab = createMockBrowserTab({
			url: 'https://old.example/',
			title: '',
		});

		expect(normalizeBrowserTabUpdates(tab, { url: 'example.com/path', title: '' })).toMatchObject({
			url: 'https://example.com/path',
			title: 'example.com',
		});
	});
});
