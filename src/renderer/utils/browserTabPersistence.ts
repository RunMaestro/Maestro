import type { BrowserTab } from '../types';

const BROWSER_TAB_PARTITION_PREFIX = 'persist:maestro-browser-session-';
const BROWSER_TAB_PARTITION_PATTERN = /^persist:maestro-browser-session-[a-zA-Z0-9_-]+$/;
export const DEFAULT_BROWSER_TAB_URL = 'about:blank';
export const DEFAULT_BROWSER_TAB_TITLE = 'New Tab';

export type BrowserTabNavigationTarget =
	| { kind: 'url'; url: string }
	| { kind: 'error'; message: string };

function sanitizeBrowserPartitionKey(sessionId: string): string {
	const normalized = sessionId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
	return normalized || 'default';
}

export function getBrowserTabPartition(sessionId: string): string {
	return `${BROWSER_TAB_PARTITION_PREFIX}${sanitizeBrowserPartitionKey(sessionId)}`;
}

export function getSafeBrowserTabPartition(
	partition: string | null | undefined,
	sessionId: string
): string {
	if (typeof partition === 'string' && BROWSER_TAB_PARTITION_PATTERN.test(partition.trim())) {
		return partition.trim();
	}

	return getBrowserTabPartition(sessionId);
}

function looksLikeLocalAddress(value: string): boolean {
	return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#].*)?$/i.test(value);
}

function looksLikeSearchQuery(value: string): boolean {
	return /\s/.test(value);
}

function looksLikeSchemeLessUrl(value: string): boolean {
	return (
		looksLikeLocalAddress(value) ||
		/^[^\s/]+\.[^\s/]+(?:[/:?#].*)?$/i.test(value) ||
		/^[^\s/]+\/.+$/.test(value)
	);
}

function buildSearchUrl(value: string): string {
	return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function resolveBrowserTabNavigationTarget(value: string): BrowserTabNavigationTarget {
	const trimmed = value.trim();
	if (!trimmed) return { kind: 'url', url: DEFAULT_BROWSER_TAB_URL };
	if (trimmed === DEFAULT_BROWSER_TAB_URL) return { kind: 'url', url: DEFAULT_BROWSER_TAB_URL };
	if (looksLikeLocalAddress(trimmed)) {
		return { kind: 'url', url: new URL(`http://${trimmed}`).toString() };
	}

	const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
	const candidate = (() => {
		if (hasScheme) return trimmed;
		if (looksLikeSchemeLessUrl(trimmed)) return `https://${trimmed}`;
		if (looksLikeSearchQuery(trimmed)) return buildSearchUrl(trimmed);
		return buildSearchUrl(trimmed);
	})();

	try {
		const url = new URL(candidate);
		if (url.protocol === 'about:' && url.href === DEFAULT_BROWSER_TAB_URL) {
			return { kind: 'url', url: DEFAULT_BROWSER_TAB_URL };
		}
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return { kind: 'url', url: url.toString() };
		}

		return {
			kind: 'error',
			message: `Protocol not allowed in browser tabs: ${url.protocol}`,
		};
	} catch {
		return {
			kind: 'error',
			message: 'Enter a valid URL or search term',
		};
	}
}

export function normalizeBrowserTabUrl(value: string): string {
	const result = resolveBrowserTabNavigationTarget(value);
	return result.kind === 'url' ? result.url : DEFAULT_BROWSER_TAB_URL;
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

export function sanitizeBrowserTabForPersistence(tab: BrowserTab, sessionId: string): BrowserTab {
	const url =
		typeof tab.url === 'string' && tab.url.trim()
			? normalizeBrowserTabUrl(tab.url)
			: DEFAULT_BROWSER_TAB_URL;
	const title = getBrowserTabTitle(url, tab.title);

	return {
		...tab,
		url,
		title,
		partition: getSafeBrowserTabPartition(tab.partition, sessionId),
		favicon: tab.favicon ?? null,
		// Guest contents are recreated after restart, so persist clean runtime state.
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
		webContentsId: undefined,
	};
}

export function rehydrateBrowserTab(tab: BrowserTab, sessionId: string): BrowserTab {
	return sanitizeBrowserTabForPersistence(tab, sessionId);
}
