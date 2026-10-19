/**
 * useTabWindowFileTabs - the file preview tabs of a tab window (Tab Windows,
 * D5).
 *
 * A file tab moves by value: the tab window renders the file itself, from its
 * own copy of the tab, and does every disk read and write for it through the
 * same SSH-aware `fs` IPC and the same functions the owner uses
 * (`services/fileTabActions`, and the save in `useFilePreviewHandlers`).
 * While the tab is popped out, this window owns the fields those touch
 * (`TabWindowFileTabState`: the unsaved edits, the preview or edit mode, the
 * scroll position and find query, the per-tab preview settings, and the disk
 * state). The owner's snapshot seeds them and its deltas never carry them, so
 * nothing the owner echoes can undo a newer local change.
 *
 * The owner keeps its own copy, which is what it shows once the tab docks.
 * This hook keeps that copy current with the `setFileTabState` intent, which
 * carries only the fields that changed since the last write: after a pause
 * (the app window's own `DRAFT_FLUSH_DELAY_MS`), at once after a save (with a
 * Files panel refresh when the save moved the file), when the tab leaves this
 * strip, when the window loses focus, hides, or unloads, and when the caller
 * asks (`flushFileTabs`: before a Dock).
 *
 * Font scale is not tab state: it is the app-wide `filePreview.fontScale`
 * preference in localStorage, which every window of the app shares.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { FilePreviewTab, Session } from '../../types';
import {
	TAB_WINDOW_FILE_TAB_FIELDS,
	type TabWindowFileTabState,
	type TabWindowTabRef,
} from '../../../shared/tabWindowTypes';
import type { SingleTabType } from '../../../shared/unifiedTabRef';
import { useSessionStore } from '../../stores/sessionStore';
import { useDraftPersistence } from '../../hooks/input/useDraftPersistence';
import { DRAFT_FLUSH_DELAY_MS } from '../../hooks/input/useInputSync';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { sendTabWindowIntent } from '../../services/tabWindowIntentSender';
import {
	navigateFileTabToIndex,
	refreshFileTabIfChanged,
	reloadFileTab,
	setFileTabEditContent,
	setFileTabEditMode,
	setFileTabScrollTop,
	setFileTabSearchQuery,
} from '../../services/fileTabActions';
import type { PaneFileActions } from '../MainPanel/TiledLayout';

type FileTabFields = Partial<TabWindowFileTabState>;

export interface TabWindowFileTabsControls {
	/** The file pane's actions: each runs on this window's copy of the tab. */
	fileActions: PaneFileActions;
	/** Write back every change still waiting for its pause now (before a Dock). */
	flushFileTabs: () => void;
}

function findFileTab(
	sessions: Session[],
	agentId: string,
	tabId: string
): FilePreviewTab | undefined {
	return sessions.find((s) => s.id === agentId)?.filePreviewTabs.find((t) => t.id === tabId);
}

/** The fields of a file tab this window owns, as the owner last heard them. */
function ownedFields(tab: FilePreviewTab): FileTabFields {
	const fields: Record<string, unknown> = {};
	for (const field of TAB_WINDOW_FILE_TAB_FIELDS) fields[field] = tab[field];
	return fields as FileTabFields;
}

/** The owned fields of `tab` that differ from `sent`, or null when none does. */
function changedFields(sent: FileTabFields, tab: FilePreviewTab): FileTabFields | null {
	let changes: Record<string, unknown> | null = null;
	for (const field of TAB_WINDOW_FILE_TAB_FIELDS) {
		if (sent[field] === tab[field]) continue;
		changes ??= {};
		changes[field] = tab[field];
	}
	return changes as FileTabFields | null;
}

/**
 * Run the file tabs of this window's strip (`tabRefs`) and keep the owner's
 * copy of each current. `shownTabId` is the file tab on screen (null while a
 * tab of another kind shows); `closeTab` is the strip's confirmed close.
 */
export function useTabWindowFileTabs(
	agentId: string,
	tabRefs: TabWindowTabRef[],
	shownTabId: string | null,
	closeTab: (type: SingleTabType, id: string) => void
): TabWindowFileTabsControls {
	const fileTabIds = useMemo(
		() => tabRefs.flatMap((ref) => (ref.type === 'file' ? [ref.id] : [])),
		[tabRefs]
	);
	const fileTabIdsRef = useRef(fileTabIds);
	fileTabIdsRef.current = fileTabIds;
	// Per tab, what the owner holds: the seed it sent, plus every write since.
	const sentRef = useRef(new Map<string, FileTabFields>());

	/** Seed a tab the first time this window holds it: the owner has these values. */
	const seed = useCallback(
		(tabId: string): boolean => {
			if (sentRef.current.has(tabId)) return false;
			const tab = findFileTab(useSessionStore.getState().sessions, agentId, tabId);
			if (tab) sentRef.current.set(tabId, ownedFields(tab));
			return true;
		},
		[agentId]
	);

	const writeBack = useCallback(
		(tabId: string, refreshFileTree = false) => {
			const tab = findFileTab(useSessionStore.getState().sessions, agentId, tabId);
			const sent = sentRef.current.get(tabId);
			if (!tab || !sent) return;
			const fields = changedFields(sent, tab);
			if (!fields && !refreshFileTree) return;
			sentRef.current.set(tabId, ownedFields(tab));
			sendTabWindowIntent({
				kind: 'setFileTabState',
				agentId,
				tabRef: { type: 'file', id: tabId },
				fields: fields ?? {},
				...(refreshFileTree ? { refreshFileTree } : {}),
			});
		},
		[agentId]
	);
	const { queueFlush, flushPending } = useDraftPersistence<true>(
		(tabId) => writeBack(tabId),
		DRAFT_FLUSH_DELAY_MS
	);

	// A tab that joins the strip is seeded; one that leaves it (docked) sends
	// what is still waiting, then the owner holds it again.
	useEffect(() => {
		for (const tabId of fileTabIds) seed(tabId);
		for (const tabId of [...sentRef.current.keys()]) {
			if (fileTabIds.includes(tabId)) continue;
			flushPending();
			writeBack(tabId);
			sentRef.current.delete(tabId);
		}
	}, [fileTabIds, seed, writeBack, flushPending]);

	// Every local change to a strip tab queues a write. Owner patches never
	// touch the owned fields, so a write only ever carries this window's work.
	useEffect(
		() =>
			useSessionStore.subscribe((next, prev) => {
				if (next.sessions === prev.sessions) return;
				for (const tabId of fileTabIdsRef.current) {
					const tab = findFileTab(next.sessions, agentId, tabId);
					if (!tab || tab === findFileTab(prev.sessions, agentId, tabId)) continue;
					if (!seed(tabId)) queueFlush(tabId, true);
				}
			}),
		[agentId, seed, queueFlush]
	);

	// Showing a file tab reads the disk the way the owner's tab select does: a
	// tab popped out while its remote read was in flight is read here (the
	// owner's read lands on its own copy), any other one refreshes when the file
	// changed on disk and auto refresh is on.
	useEffect(() => {
		if (!shownTabId) return;
		const tab = findFileTab(useSessionStore.getState().sessions, agentId, shownTabId);
		if (!tab) return;
		void (tab.isLoading ? reloadFileTab : refreshFileTabIfChanged)(agentId, shownTabId);
	}, [agentId, shownTabId]);

	// Leaving the window is a loss boundary: the next thing the user does may be
	// to dock the tab from the main window, or to close this one.
	useEventListener('blur', flushPending);
	useEventListener(
		'visibilitychange',
		() => {
			if (document.visibilityState === 'hidden') flushPending();
		},
		{ target: document }
	);
	useEventListener('pagehide', flushPending);

	const fileActions = useMemo<PaneFileActions>(
		() => ({
			onFileTabClose: (tabId) => closeTab('file', tabId),
			onFileTabEditModeChange: (tabId, editMode) => setFileTabEditMode(agentId, tabId, editMode),
			onFileTabEditContentChange: (tabId, editContent, savedContent, savedMtime) =>
				setFileTabEditContent(agentId, tabId, editContent, savedContent, savedMtime),
			onFileTabScrollPositionChange: (tabId, scrollTop) =>
				setFileTabScrollTop(agentId, tabId, scrollTop),
			onFileTabSearchQueryChange: (tabId, searchQuery) =>
				setFileTabSearchQuery(agentId, tabId, searchQuery),
			onReloadFileTab: (tabId) => void reloadFileTab(agentId, tabId),
			onFileTabNavigateToIndex: (index, tabId) => {
				if (tabId) void navigateFileTabToIndex(agentId, tabId, index);
			},
			// A save is written back at once; one that moved the file refreshes
			// the owner's Files panel, as the save asks in an app window.
			onFileTabSaved: (tabId, saved) => writeBack(tabId, saved.moved),
			// The file opens as a tab of the owner (Q3), as from a transcript.
			onFileClick: (path) => {
				if (!shownTabId) return;
				sendTabWindowIntent({
					kind: 'openFileLink',
					agentId,
					tabRef: { type: 'file', id: shownTabId },
					path,
				});
			},
		}),
		[agentId, shownTabId, closeTab, writeBack]
	);

	return { fileActions, flushFileTabs: flushPending };
}
