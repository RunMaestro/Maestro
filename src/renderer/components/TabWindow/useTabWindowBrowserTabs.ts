/**
 * useTabWindowBrowserTabs - the browser tabs of a tab window (Tab Windows, D5).
 *
 * A `<webview>` cannot move between windows. While a browser tab is popped
 * out, the owner mounts no webview for it (`useBrowserTabMounting`), and this
 * window opens a new one at the tab's current URL with the same
 * `BrowserTabView`. Back and forward history stays with the old webview.
 *
 * While the tab is popped out, this window owns what its webview reports
 * (`TabWindowBrowserTabState`: the page, the history flags, loading, the guest
 * id). The owner's snapshot seeds those and its deltas never carry them. On
 * the seed the copy drops the old guest's state (`withoutGuestState`, the
 * form a restored tab starts in), since the new webview has no history and no
 * guest yet.
 *
 * The owner keeps its own copy, which is what it reopens once the tab docks.
 * {@link UseTabWindowBrowserTabsResult.onUpdateTab} applies a webview event
 * here and writes the page fields that changed back at once with the
 * `setBrowserTabState` intent: its URL, title, and icon, and the agent
 * visibility toggle. Navigations are rare next to keystrokes, so there is no
 * pause to flush before a Dock.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Session } from '../../types';
import type { BrowserTab } from '../../../shared/browserPage';
import {
	TAB_WINDOW_BROWSER_TAB_WRITE_BACK_FIELDS,
	type TabWindowBrowserTabWriteBack,
	type TabWindowTabRef,
} from '../../../shared/tabWindowTypes';
import { updateBrowserTab, useSessionStore } from '../../stores/sessionStore';
import { normalizeBrowserTabUpdates } from '../../hooks/tabs/internal/browserTabHelpers';
import { withoutGuestState } from '../../utils/browserTabPersistence';
import { sendTabWindowIntent } from '../../services/tabWindowIntentSender';

type BrowserTabWriteBack = Partial<TabWindowBrowserTabWriteBack>;

export interface UseTabWindowBrowserTabsResult {
	/** This strip's browser tab ids, in strip order. */
	browserTabIds: string[];
	/** A webview event or a toolbar change on one of this strip's tabs. */
	onUpdateTab: (tabId: string, updates: Partial<BrowserTab>) => void;
}

function findBrowserTab(sessions: Session[], agentId: string, tabId: string) {
	return sessions.find((s) => s.id === agentId)?.browserTabs?.find((t) => t.id === tabId);
}

/** The fields of a browser tab this window writes back, as the owner last heard them. */
function writeBackFields(tab: BrowserTab): BrowserTabWriteBack {
	const fields: Record<string, unknown> = {};
	for (const field of TAB_WINDOW_BROWSER_TAB_WRITE_BACK_FIELDS) fields[field] = tab[field];
	return fields as BrowserTabWriteBack;
}

/** The write-back fields of `tab` that differ from `sent`, or null when none does. */
function changedFields(sent: BrowserTabWriteBack, tab: BrowserTab): BrowserTabWriteBack | null {
	let changes: Record<string, unknown> | null = null;
	for (const field of TAB_WINDOW_BROWSER_TAB_WRITE_BACK_FIELDS) {
		if (sent[field] === tab[field]) continue;
		changes ??= {};
		changes[field] = tab[field];
	}
	return changes as BrowserTabWriteBack | null;
}

/** Run the browser tabs of this window's strip (`tabRefs`) for agent `agentId`. */
export function useTabWindowBrowserTabs(
	agentId: string,
	tabRefs: TabWindowTabRef[]
): UseTabWindowBrowserTabsResult {
	const browserTabIds = useMemo(
		() => tabRefs.flatMap((ref) => (ref.type === 'browser' ? [ref.id] : [])),
		[tabRefs]
	);
	// Per tab, what the owner holds: the seed it sent, plus every write since.
	const sentRef = useRef(new Map<string, BrowserTabWriteBack>());

	/**
	 * Seed a tab the first time this window holds it: the owner has these page
	 * fields, and the new webview starts with no history and no guest.
	 */
	const seed = useCallback(
		(tabId: string) => {
			if (sentRef.current.has(tabId)) return;
			const tab = findBrowserTab(useSessionStore.getState().sessions, agentId, tabId);
			if (!tab) return;
			sentRef.current.set(tabId, writeBackFields(tab));
			updateBrowserTab(agentId, tabId, withoutGuestState);
		},
		[agentId]
	);

	// A tab that joins the strip is seeded; one that leaves it (docked) is the
	// owner's again, and a later pop-out seeds it anew.
	useEffect(() => {
		for (const tabId of browserTabIds) seed(tabId);
		for (const tabId of [...sentRef.current.keys()]) {
			if (!browserTabIds.includes(tabId)) sentRef.current.delete(tabId);
		}
	}, [browserTabIds, seed]);

	const onUpdateTab = useCallback(
		(tabId: string, updates: Partial<BrowserTab>) => {
			// An event can beat the seed effect (a webview that loads fast).
			seed(tabId);
			updateBrowserTab(agentId, tabId, (tab) => normalizeBrowserTabUpdates(tab, updates));
			const tab = findBrowserTab(useSessionStore.getState().sessions, agentId, tabId);
			const sent = sentRef.current.get(tabId);
			if (!tab || !sent) return;
			const fields = changedFields(sent, tab);
			if (!fields) return;
			sentRef.current.set(tabId, writeBackFields(tab));
			sendTabWindowIntent({
				kind: 'setBrowserTabState',
				agentId,
				tabRef: { type: 'browser', id: tabId },
				fields,
			});
		},
		[agentId, seed]
	);

	return { browserTabIds, onUpdateTab };
}
