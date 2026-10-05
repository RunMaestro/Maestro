import type { BrowserTab } from '../../../../shared/browserPage';
import type { Session } from '../../../types';
import { insertAfterActiveInUnifiedTabOrder } from '../../../utils/unifiedTabOrderUtils';
import {
	DEFAULT_BROWSER_TAB_TITLE,
	DEFAULT_BROWSER_TAB_URL,
	getBrowserTabPartition,
	getBrowserTabTitle,
	getEphemeralBrowserTabPartition,
	normalizeBrowserTabUrl,
} from '../../../utils/browserTabPersistence';
import { generateId } from '../../../utils/ids';

export function activateBrowserTab(session: Session, tab: BrowserTab): Session {
	const existing = session.browserTabs ?? [];
	const order = session.unifiedTabOrder ?? [];
	return {
		...session,
		browserTabs: existing.some((candidate) => candidate.id === tab.id)
			? existing
			: [...existing, tab],
		activeFileTabId: null,
		activeBrowserTabId: tab.id,
		activeTerminalTabId: null,
		inputMode: 'ai',
		activeGroupId: null,
		unifiedTabOrder: order.some((ref) => ref.type === 'browser' && ref.id === tab.id)
			? order
			: insertAfterActiveInUnifiedTabOrder(session, { type: 'browser', id: tab.id }),
	};
}

export function createBrowserTab(
	sessionId: string,
	url: string,
	options?: { title?: string; isLoading?: boolean; ephemeral?: boolean }
): BrowserTab {
	return {
		id: generateId(),
		url,
		title:
			options?.title ??
			(url === DEFAULT_BROWSER_TAB_URL ? DEFAULT_BROWSER_TAB_TITLE : getBrowserTabTitle(url, url)),
		createdAt: Date.now(),
		partition: options?.ephemeral
			? getEphemeralBrowserTabPartition(sessionId)
			: getBrowserTabPartition(sessionId),
		canGoBack: false,
		canGoForward: false,
		isLoading: options?.isLoading ?? true,
		favicon: null,
		...(options?.ephemeral ? { ephemeral: true } : {}),
	};
}

export function normalizeBrowserTabUpdates(
	tab: BrowserTab,
	updates: Partial<BrowserTab>
): BrowserTab {
	const nextUrl = typeof updates.url === 'string' ? normalizeBrowserTabUrl(updates.url) : tab.url;
	return {
		...tab,
		...updates,
		url: nextUrl,
		title: getBrowserTabTitle(nextUrl, updates.title ?? tab.title),
	};
}
