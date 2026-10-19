/**
 * TabWindowBrowsers - the browser tabs of a tab window (Tab Windows, D5).
 *
 * A `<webview>` cannot move between windows, so this window opens a new one at
 * each popped browser tab's current URL with the main panel's own
 * `BrowserTabView` (same partition, so the agent's cookies and logins carry
 * over). Back and forward history does not. Which strip tabs stay mounted
 * follows the user's `browserTabKeepAlive` policy, through the same
 * `useBrowserTabMounting` the main panel runs, applied to this strip; the
 * shown tab is always mounted. Like the main panel, a kept tab is hidden, not
 * unmounted, so its page survives a switch to another tab of this window.
 *
 * Page changes return to the owner through `useTabWindowBrowserTabs`, so a
 * dock reopens the latest page there. Keys pressed inside a page reach this
 * window from main (`browser-tab:shortcutKey`); find and history keys act on
 * the shown page, every other one is replayed on this window, where the tab
 * shortcuts listen (`useTabWindowKeyboard`).
 *
 * The owner's agent automation does not reach a popped tab: the relay and the
 * coworking tools refuse it until it docks.
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { BrowserTabView, type BrowserTabViewHandle } from '../MainPanel/BrowserTabView';
import { useBrowserTabMounting } from '../../hooks/browser/useBrowserTabMounting';
import { useLayerStack } from '../../contexts/LayerStackContext';
import type { Session, Theme } from '../../types';
import type { BrowserTab } from '../../../shared/browserPage';
import type { TabWindowTabRef } from '../../../shared/tabWindowTypes';
import { useTabWindowBrowserTabs } from './useTabWindowBrowserTabs';

export interface TabWindowBrowsersProps {
	theme: Theme;
	session: Session;
	/** This window's tabs, in its own strip order. */
	tabRefs: TabWindowTabRef[];
	/** The browser tab shown now, or null when the shown tab is not a browser tab. */
	shownTabId: string | null;
}

export function TabWindowBrowsers({ theme, session, tabRefs, shownTabId }: TabWindowBrowsersProps) {
	const { browserTabIds, onUpdateTab } = useTabWindowBrowserTabs(session.id, tabRefs);
	const { layerCount } = useLayerStack();

	// The agent narrowed to this strip's browser tabs, with the shown one active,
	// so the keep-alive policy picks among these tabs only.
	const stripSession = useMemo<Session>(() => {
		const byId = new Map((session.browserTabs ?? []).map((tab) => [tab.id, tab]));
		return {
			...session,
			browserTabs: browserTabIds.flatMap((id) => byId.get(id) ?? []),
			activeBrowserTabId: shownTabId,
			activeGroupId: null,
		};
	}, [session, browserTabIds, shownTabId]);
	const mountedTabIds = useBrowserTabMounting(stripSession);

	const handlesRef = useRef(new Map<string, BrowserTabViewHandle>());
	const setHandle = useCallback((tabId: string, handle: BrowserTabViewHandle | null) => {
		if (handle) handlesRef.current.set(tabId, handle);
		else handlesRef.current.delete(tabId);
	}, []);
	const shownTabIdRef = useRef(shownTabId);
	shownTabIdRef.current = shownTabId;
	useBrowserShortcutForwarding(handlesRef, shownTabIdRef);

	if (mountedTabIds.length === 0) return null;

	return (
		<>
			{mountedTabIds.map((tabId) => {
				const tab = stripSession.browserTabs?.find((t) => t.id === tabId);
				if (!tab) return null;
				const shown = tabId === shownTabId;
				return (
					<div
						key={tabId}
						className="absolute inset-0 flex flex-col"
						data-testid={`tab-window-browser-${tabId}`}
						style={{
							visibility: shown ? 'visible' : 'hidden',
							pointerEvents: shown ? 'auto' : 'none',
							zIndex: shown ? 2 : -1,
						}}
					>
						<TabWindowBrowserView
							tab={tab}
							theme={theme}
							// Yield keyboard focus to an open dialog, as the main panel does.
							isActive={shown && layerCount === 0}
							onUpdateTab={onUpdateTab}
							setHandle={setHandle}
						/>
					</div>
				);
			})}
		</>
	);
}

interface TabWindowBrowserViewProps {
	tab: BrowserTab;
	theme: Theme;
	isActive: boolean;
	onUpdateTab: (tabId: string, updates: Partial<BrowserTab>) => void;
	setHandle: (tabId: string, handle: BrowserTabViewHandle | null) => void;
}

/**
 * One page. Always a native webview: a streamed page (`remotePage`) is the
 * owner's offscreen guest in main, and this window opens its own instead.
 */
const TabWindowBrowserView = memo(function TabWindowBrowserView({
	tab,
	theme,
	isActive,
	onUpdateTab,
	setHandle,
}: TabWindowBrowserViewProps) {
	const nativeTab = useMemo(
		() => (tab.remotePage ? { ...tab, remotePage: undefined } : tab),
		[tab]
	);
	const tabId = tab.id;
	const ref = useCallback(
		(handle: BrowserTabViewHandle | null) => setHandle(tabId, handle),
		[setHandle, tabId]
	);
	return (
		<BrowserTabView
			ref={ref}
			tab={nativeTab}
			theme={theme}
			isActive={isActive}
			onUpdateTab={onUpdateTab}
		/>
	);
});

/**
 * Keys pressed inside a page never reach this window's listeners: main catches
 * the shortcuts on the guest and sends them to the window hosting it. Find and
 * page history act on the shown page, as in the main window; every other key is
 * replayed here so the tab shortcuts (`useTabWindowKeyboard`) see it.
 */
function useBrowserShortcutForwarding(
	handlesRef: React.MutableRefObject<Map<string, BrowserTabViewHandle>>,
	shownTabIdRef: React.MutableRefObject<string | null>
): void {
	useEffect(() => {
		const subscribe = window.maestro?.app?.onBrowserTabShortcutKey;
		if (!subscribe) return;
		return subscribe((input) => {
			if (document.activeElement?.tagName === 'WEBVIEW') {
				(document.activeElement as HTMLElement).blur();
			}
			const shownId = shownTabIdRef.current;
			const handle = shownId ? handlesRef.current.get(shownId) : undefined;
			const command = (input.meta || input.control) && !input.alt && !input.shift;
			if (handle && command) {
				if (input.key === 'f' || input.key === 'F') return handle.openFind();
				if (input.key === 'ArrowLeft') return handle.goBack();
				if (input.key === 'ArrowRight') return handle.goForward();
			}
			window.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: input.key,
					code: input.code,
					metaKey: input.meta,
					ctrlKey: input.control,
					altKey: input.alt,
					shiftKey: input.shift,
					bubbles: true,
					cancelable: true,
				})
			);
		});
	}, [handlesRef, shownTabIdRef]);
}
