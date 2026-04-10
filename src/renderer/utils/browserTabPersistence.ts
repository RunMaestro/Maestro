import type { BrowserTab } from '../types';

const BROWSER_TAB_PARTITION_PREFIX = 'persist:maestro-browser-session-';
export const DEFAULT_BROWSER_TAB_URL = 'about:blank';
export const DEFAULT_BROWSER_TAB_TITLE = 'New Tab';

function sanitizeBrowserPartitionKey(sessionId: string): string {
	const normalized = sessionId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
	return normalized || 'default';
}

export function getBrowserTabPartition(sessionId: string): string {
	return `${BROWSER_TAB_PARTITION_PREFIX}${sanitizeBrowserPartitionKey(sessionId)}`;
}

function looksLikeLocalAddress(value: string): boolean {
	return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#].*)?$/i.test(value);
}

export function normalizeBrowserTabUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return DEFAULT_BROWSER_TAB_URL;
	if (trimmed === DEFAULT_BROWSER_TAB_URL) return DEFAULT_BROWSER_TAB_URL;

	const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
	const candidate = (() => {
		if (hasScheme) return trimmed;
		if (looksLikeLocalAddress(trimmed)) return `http://${trimmed}`;
		if (trimmed.includes(' ')) {
			return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
		}
		return `https://${trimmed}`;
	})();

	try {
		const url = new URL(candidate);
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return url.toString();
		}
	} catch {
		// Fall through to the safe blank page.
	}

	return DEFAULT_BROWSER_TAB_URL;
}

export function getBrowserTabTitle(url: string, title?: string | null): string {
	const normalizedTitle = typeof title === 'string' ? title.trim() : '';
	if (normalizedTitle) return normalizedTitle;
	if (url === DEFAULT_BROWSER_TAB_URL) return DEFAULT_BROWSER_TAB_TITLE;

	try {
		const parsed = new URL(url);
		return parsed.host || parsed.href;
	} catch {
		return url || DEFAULT_BROWSER_TAB_TITLE;
	}
}

export function rehydrateBrowserTab(tab: BrowserTab, sessionId: string): BrowserTab {
	const url =
		typeof tab.url === 'string' && tab.url.trim()
			? normalizeBrowserTabUrl(tab.url)
			: DEFAULT_BROWSER_TAB_URL;
	const title = getBrowserTabTitle(url, tab.title);

	return {
		...tab,
		url,
		title,
		partition: tab.partition || getBrowserTabPartition(sessionId),
		// Guest contents are recreated after restart, so restore with clean runtime state.
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
		webContentsId: undefined,
	};
}
