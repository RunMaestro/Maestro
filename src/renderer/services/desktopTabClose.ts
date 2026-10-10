import { mergeDeferredItems } from '../../shared/deferredSessionContent';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { useComposerInputStore } from '../stores/composerInputStore';
import { notifyToast } from '../stores/notificationStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import type { AITab, Session } from '../types';
import { clearLiveDraft, getLiveDraft } from '../utils/liveDraftStore';
import { logger } from '../utils/logger';
import { isWebDesktop } from '../utils/runtimeContext';
import { snapshotClosedTabTranscript } from '../utils/starredSessions';
import {
	addAiTabToUnifiedHistory,
	aiTabFocusFields,
	hasActiveWizard,
	reopenClosedAiTabById,
	reopenUnifiedClosedTab,
} from '../utils/tabHelpers';

// Keep close/reopen operations ordered across hook instances and rapid key presses.
const tabOperations = createKeyedWriteQueue();
const pendingReopens = new Set<string>();

/** Close one browser conversation, with cleanup gated on the owner's acknowledgement. */
export function requestDesktopTabClose(
	sessionId: string,
	tabId: string,
	endWizard?: (tabId: string) => Promise<unknown>
): Promise<boolean> {
	return requestDesktopTabCloses(sessionId, [tabId], endWizard);
}

/** Close a batch in order and report at most one failure notification for the action. */
export function requestDesktopTabCloses(
	sessionId: string,
	tabIds: string[],
	endWizard?: (tabId: string) => Promise<unknown>
): Promise<boolean> {
	return tabOperations.enqueue(sessionId, async () => {
		let failed = false;
		for (const tabId of new Set(tabIds)) {
			const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
			const tab = session?.aiTabs.find((t) => t.id === tabId);
			if (!session || !tab) continue;
			const unifiedIndex = session.unifiedTabOrder.findIndex(
				(ref) => ref.type === 'ai' && ref.id === tabId
			);
			try {
				const closed = await window.maestro.web.requestCloseTab(sessionId, tabId);
				if (closed !== true) throw new Error('The desktop did not confirm closure.');
			} catch (error) {
				failed = true;
				logger.error('[requestDesktopTabClose] Close was not confirmed:', undefined, error);
				continue;
			}

			// History is runtime-only and belongs to each client. Capture from before
			// the request: the inventory broadcast can remove the tab before the ack.
			if (!hasActiveWizard(tab)) {
				updateSessionWith(sessionId, (current) =>
					addAiTabToUnifiedHistory(current, tab, unifiedIndex)
				);
			}
			clearLiveDraft(tabId);
			snapshotClosedTabTranscript(session, tab);
			if (hasActiveWizard(tab) && endWizard) {
				await endWizard(tabId).catch((error) =>
					logger.warn('Failed to end closed wizard', undefined, error)
				);
			}
		}
		if (failed) {
			notifyToast({
				color: 'red',
				title: 'Could not close session',
				message: 'The desktop did not confirm every close. Please check the tabs and try again.',
			});
		}
		return !failed;
	});
}

/** Order browser reopen intents; route AI history through the desktop and restore other types locally. */
export function reopenDesktopTabIfNeeded(session: Session): boolean {
	if (!isWebDesktop()) return false;
	// Coalesce repeated key presses while this intent waits for earlier closes or
	// its own acknowledgement. Select the history head only when the queue runs.
	if (pendingReopens.has(session.id)) return true;
	pendingReopens.add(session.id);
	void tabOperations.enqueue(session.id, async () => {
		let unsubscribeInventory: (() => void) | undefined;
		let unsubscribeComposer: (() => void) | undefined;
		try {
			const current = useSessionStore.getState().sessions.find((s) => s.id === session.id);
			if (!current) return;
			const entry = current.unifiedClosedTabHistory?.[0];
			if (entry?.type !== 'ai') {
				updateSessionWith(session.id, (s) => reopenUnifiedClosedTab(s)?.session ?? s);
				return;
			}

			// Remember each tab as it first becomes visible during this request.
			// Inventory can introduce the canonical ID before the response tells us
			// which tab it is. Only untouched fields may adopt the close snapshot.
			const firstSeenTabs = new Map<string, AITab>(current.aiTabs.map((tab) => [tab.id, tab]));
			const editedComposerTabs = new Set<string>();
			unsubscribeComposer = useComposerInputStore.subscribe((state, previous) => {
				// Loading an inventory tab into the composer is not an edit. A text
				// change for the same owner is, even if the user later deletes it all.
				if (
					state.aiValueTabId &&
					state.aiValueTabId === previous.aiValueTabId &&
					state.aiValue !== previous.aiValue
				) {
					editedComposerTabs.add(state.aiValueTabId);
				}
			});
			unsubscribeInventory = useSessionStore.subscribe((state) => {
				const tabs = state.sessions.find((s) => s.id === session.id)?.aiTabs ?? [];
				for (const tab of tabs) {
					if (!firstSeenTabs.has(tab.id)) firstSeenTabs.set(tab.id, tab);
				}
			});
			const reopened = await window.maestro.web.requestReopenTab(session.id, entry.tab.id);
			if (!reopened?.tabId) throw new Error('The desktop could not restore the conversation.');
			updateSessionWith(session.id, (s) => {
				// A close acknowledgement can beat the inventory snapshot. Drop the
				// confirmed-closed copy before duplicate detection during restore.
				const source = {
					...s,
					aiTabs: s.aiTabs
						.filter((t) => t.id !== entry.tab.id || t.id === reopened.tabId)
						.map((tab) => {
							if (tab.id !== reopened.tabId) return tab;
							const firstSeen = firstSeenTabs.get(tab.id);
							const liveDraft = getLiveDraft(tab.id);
							return {
								...entry.tab,
								...tab,
								logs: mergeDeferredItems(entry.tab.logs, tab.logs, (log) => log.id),
								inputValue:
									(editedComposerTabs.has(tab.id) || liveDraft !== firstSeen?.inputValue
										? liveDraft
										: undefined) ??
									(tab.inputValue !== firstSeen?.inputValue
										? tab.inputValue
										: entry.tab.inputValue),
								stagedImages:
									tab.stagedImages !== firstSeen?.stagedImages
										? tab.stagedImages
										: entry.tab.stagedImages,
								saveToHistory: entry.tab.saveToHistory,
								showThinking: entry.tab.showThinking,
							};
						}),
					unifiedTabOrder: s.unifiedTabOrder.filter(
						(ref) => ref.id !== entry.tab.id || ref.id === reopened.tabId
					),
				};
				const restored = reopenClosedAiTabById(source, entry.tab.id, reopened.tabId);
				if (!restored) return s;
				const deferredContent = s.deferredContent;
				return {
					...restored.session,
					...aiTabFocusFields(reopened.tabId),
					...(deferredContent?.tabIds.includes(entry.tab.id)
						? {
								deferredContent: {
									...deferredContent,
									tabIds: [...new Set([...deferredContent.tabIds, reopened.tabId])],
								},
							}
						: {}),
				};
			});
		} catch (error) {
			logger.error('[reopenDesktopTabIfNeeded] Restore failed:', undefined, error);
			notifyToast({
				color: 'red',
				title: 'Could not reopen session',
				message: 'The desktop could not restore the conversation. Please try again.',
			});
		} finally {
			unsubscribeInventory?.();
			unsubscribeComposer?.();
			pendingReopens.delete(session.id);
		}
	});
	return true;
}
