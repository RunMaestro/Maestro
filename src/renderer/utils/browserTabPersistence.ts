import type { BrowserTab } from '../types';

const BROWSER_TAB_PARTITION_PREFIX = 'persist:maestro-browser-session-';
const BROWSER_TAB_PARTITION_PATTERN = /^persist:maestro-browser-session-[a-zA-Z0-9_-]+$/;
// Ephemeral (incognito) browser tabs use a partition WITHOUT the `persist:`
// prefix, so Electron keeps their session data purely in memory and discards
// it when the app quits.
export const EPHEMERAL_BROWSER_TAB_PARTITION_PREFIX = 'maestro-ephemeral-';
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

// 8 lowercase alphanumerics. Uniqueness (not unguessability) is the goal: each
// ephemeral tab gets its own partition so no state is shared between incognito
// tabs, mirroring one-off private windows.
function randomEphemeralSuffix(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let suffix = '';
	for (let i = 0; i < 8; i++) {
		suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return suffix;
}

export function getEphemeralBrowserTabPartition(sessionId: string): string {
	return `${EPHEMERAL_BROWSER_TAB_PARTITION_PREFIX}${sanitizeBrowserPartitionKey(sessionId)}-${randomEphemeralSuffix()}`;
}

/**
 * True when a tab is an ephemeral (incognito) browser tab. Checks the flag and
 * the partition prefix so a tab that carries only one of the two markers is
 * still recognized and excluded from persistence.
 */
export function isEphemeralBrowserTab(tab: BrowserTab): boolean {
	return (
		tab.ephemeral === true ||
		(typeof tab.partition === 'string' &&
			tab.partition.startsWith(EPHEMERAL_BROWSER_TAB_PARTITION_PREFIX))
	);
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
		if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:') {
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

/**
 * True only when the URL is safe to expose as an outbound `<a href>` link - i.e.
 * an http(s) scheme. Guards against `javascript:` / `data:` hrefs that would run
 * script in the app origin when clicked (XSS), which could otherwise reach a tab
 * via persisted or imported browser-tab state. `about:blank` and `file:` return
 * false because they are not meaningful outbound links from a browser context.
 */
export function isHttpBrowserTabUrl(url: string | null | undefined): boolean {
	if (!url) return false;
	try {
		const { protocol } = new URL(url);
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

export function getBrowserTabTitle(url: string, title?: string | null): string {
	const normalizedTitle = typeof title === 'string' ? title.trim() : '';
	if (normalizedTitle) return normalizedTitle;
	if (url === DEFAULT_BROWSER_TAB_URL) return DEFAULT_BROWSER_TAB_TITLE;

	try {
		const parsed = new URL(url);
		if (parsed.protocol === 'file:') {
			const basename = decodeURIComponent(parsed.pathname.split('/').pop() || '');
			return basename || parsed.href;
		}
		return parsed.host || parsed.href;
	} catch {
		return url || DEFAULT_BROWSER_TAB_TITLE;
	}
}

/**
 * The user-visible label for a browser tab. A user-assigned `customTitle` takes
 * precedence and locks the label across navigation; otherwise we fall back to the
 * page-set title, then the URL host, then "New Tab". Shared by the tab bar, tab
 * switcher, and anywhere a browser tab needs a display name.
 */
export function getBrowserTabLabel(tab: BrowserTab): string {
	const custom = tab.customTitle?.trim();
	if (custom) return custom;
	const title = tab.title?.trim();
	if (title) return title;
	const url = tab.url?.trim();
	if (!url || url === DEFAULT_BROWSER_TAB_URL) return DEFAULT_BROWSER_TAB_TITLE;

	try {
		const parsed = new URL(url);
		return parsed.host || parsed.href;
	} catch {
		return url;
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
