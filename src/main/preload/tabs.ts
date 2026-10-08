/**
 * Preload API for tab lifecycle notifications (window.maestro.tabs).
 *
 * Renderer -> main only, and deliberately fire-and-forget: main keeps no tab
 * state of its own, it just retires tab-scoped promises (armed dispatch
 * callbacks) when a tab goes away.
 */

import { ipcRenderer } from 'electron';

export interface TabsApi {
	/**
	 * An AI tab was really removed from an agent's tab strip.
	 *
	 * Not sent for a snoozed tab (it comes back) nor for a tab closed while its
	 * agent turn is still running (it survives in `orphanedThinkingTabs` and stays
	 * a valid dispatch target until that work finishes).
	 */
	notifyAiTabClosed: (agentId: string, tabId: string) => void;
}

export function createTabsApi(): TabsApi {
	return {
		notifyAiTabClosed: (agentId: string, tabId: string) =>
			ipcRenderer.send('tabs:aiTabClosed', agentId, tabId),
	};
}
