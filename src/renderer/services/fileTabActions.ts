/**
 * fileTabActions - what a user does to one file preview tab, addressed by an
 * explicit agent and tab: edit, switch mode, scroll, search, reload, auto
 * refresh, and walk its visit history.
 *
 * Each action used to live inline in `useFilePreviewTabHandlers`, bound to the
 * ACTIVE agent. That is right for an app window's own file preview and wrong
 * for a tab popped out into a tab window, which is never its owner's active
 * tab and renders the file in its own window (Tab Windows, D5). So the action
 * lives here once, with its target as an argument, and both callers reach it:
 *
 * - the app window's handlers resolve the active agent, then call it;
 * - a tab window calls it on its own copy of the agent and writes the result
 *   back to the owner (`useTabWindowFileTabs`).
 *
 * The disk reads go through the same SSH-aware `fs` IPC in either window.
 * Every write goes through the session store's id-addressed `updateFileTab`,
 * and a target the store no longer holds is a no-op.
 */

import type { FilePreviewTab } from '../types';
import { updateFileTab, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { logger } from '../utils/logger';

function findFileTab(sessionId: string, tabId: string): FilePreviewTab | undefined {
	return useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId)
		?.filePreviewTabs.find((tab) => tab.id === tabId);
}

/** The mtime a stat reports, in ms, or `fallback` when it reports none. */
function mtimeOf(
	stat: { modifiedAt?: string | number | Date } | null | undefined,
	fallback: number
) {
	return stat?.modifiedAt ? new Date(stat.modifiedAt).getTime() : fallback;
}

export function setFileTabEditMode(sessionId: string, tabId: string, editMode: boolean): void {
	updateFileTab(sessionId, tabId, (tab) => ({ ...tab, editMode }));
}

/**
 * Record unsaved edits (`undefined` when the tab matches the disk again). A
 * save passes what it wrote as `savedContent` and the mtime that write produced
 * as `savedMtime`: the tab's `lastModified` must track the bytes it holds, or
 * the next mount of FilePreview compares the disk against a stale value and
 * raises a false "File changed on disk".
 */
export function setFileTabEditContent(
	sessionId: string,
	tabId: string,
	editContent: string | undefined,
	savedContent?: string,
	savedMtime?: number
): void {
	updateFileTab(sessionId, tabId, (tab) =>
		savedContent !== undefined
			? {
					...tab,
					editContent,
					content: savedContent,
					lastModified: savedMtime ?? tab.lastModified,
				}
			: { ...tab, editContent }
	);
}

/** Remember the scroll position, on the tab and on its current history entry. */
export function setFileTabScrollTop(sessionId: string, tabId: string, scrollTop: number): void {
	updateFileTab(sessionId, tabId, (tab) => {
		let updatedHistory = tab.navigationHistory;
		if (updatedHistory && updatedHistory.length > 0) {
			const currentIndex = tab.navigationIndex ?? updatedHistory.length - 1;
			if (currentIndex >= 0 && currentIndex < updatedHistory.length) {
				updatedHistory = updatedHistory.map((entry, idx) =>
					idx === currentIndex ? { ...entry, scrollTop } : entry
				);
			}
		}
		return { ...tab, scrollTop, navigationHistory: updatedHistory };
	});
}

export function setFileTabSearchQuery(sessionId: string, tabId: string, searchQuery: string): void {
	updateFileTab(sessionId, tabId, (tab) => ({ ...tab, searchQuery }));
}

/**
 * Read the file from disk again, dropping unsaved edits. A tab whose content
 * was just read is not loading any more.
 */
export async function reloadFileTab(sessionId: string, tabId: string): Promise<void> {
	const fileTab = findFileTab(sessionId, tabId);
	if (!fileTab) return;

	try {
		const [content, stat] = await Promise.all([
			window.maestro.fs.readFile(fileTab.path, fileTab.sshRemoteId),
			window.maestro.fs.stat(fileTab.path, fileTab.sshRemoteId),
		]);
		if (content === null) return;
		const newMtime = mtimeOf(stat, Date.now());

		updateFileTab(sessionId, tabId, (tab) => ({
			...tab,
			content,
			lastModified: newMtime,
			editContent: undefined,
			isLoading: false,
			loadRequestId: undefined,
		}));
	} catch (error) {
		logger.debug('[reloadFileTab] Failed to reload:', undefined, error);
	}
}

/**
 * When the user has file tab auto refresh on and the tab holds no unsaved
 * edits, read the file again if it changed on disk since the tab read it.
 * Runs when a file tab shows.
 */
export async function refreshFileTabIfChanged(sessionId: string, tabId: string): Promise<void> {
	const fileTab = findFileTab(sessionId, tabId);
	if (!fileTab) return;
	const { fileTabAutoRefreshEnabled } = useSettingsStore.getState();
	if (!fileTabAutoRefreshEnabled || fileTab.editContent) return;

	try {
		const stat = await window.maestro.fs.stat(fileTab.path, fileTab.sshRemoteId);
		if (!stat || !stat.modifiedAt) return;

		const currentMtime = mtimeOf(stat, 0);
		if (currentMtime > fileTab.lastModified) {
			const content = await window.maestro.fs.readFile(fileTab.path, fileTab.sshRemoteId);
			if (content === null) return;
			updateFileTab(sessionId, tabId, (tab) => ({
				...tab,
				content,
				lastModified: currentMtime,
			}));
		}
	} catch (error) {
		logger.debug('[refreshFileTabIfChanged] Auto-refresh failed:', undefined, error);
	}
}

/** The tab's position in its own visit history, or -1 when it has none. */
export function fileTabNavigationIndex(sessionId: string, tabId: string): number {
	const tab = findFileTab(sessionId, tabId);
	if (!tab) return -1;
	const history = tab.navigationHistory ?? [];
	return tab.navigationIndex ?? history.length - 1;
}

/**
 * Move one file tab to a position in its own visit history, loading that
 * entry's file. Back, forward, and a breadcrumb click all land here.
 */
export async function navigateFileTabToIndex(
	sessionId: string,
	tabId: string,
	index: number
): Promise<void> {
	const currentTab = findFileTab(sessionId, tabId);
	if (!currentTab) return;

	const history = currentTab.navigationHistory ?? [];
	if (index < 0 || index >= history.length) return;
	const historyEntry = history[index];

	try {
		const content = await window.maestro.fs.readFile(historyEntry.path, currentTab.sshRemoteId);
		if (content === null) return;

		updateFileTab(sessionId, tabId, (tab) => ({
			...tab,
			path: historyEntry.path,
			name: historyEntry.name,
			content,
			scrollTop: historyEntry.scrollTop ?? 0,
			navigationIndex: index,
		}));
	} catch (error) {
		logger.error('Failed to navigate file tab history:', undefined, error);
	}
}
