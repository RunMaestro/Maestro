import { mergeDeferredItems } from '../../shared/deferredSessionContent';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { notifyToast } from '../stores/notificationStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types';
import { clearLiveDraft } from '../utils/liveDraftStore';
import { logger } from '../utils/logger';
import { isWebDesktop } from '../utils/runtimeContext';
import { snapshotClosedTabTranscript } from '../utils/starredSessions';
import {
	addAiTabToUnifiedHistory,
	aiTabFocusFields,
	hasActiveWizard,
	reopenClosedAiTabById,
} from '../utils/tabHelpers';

// Keep close/reopen operations ordered across hook instances and rapid key presses.
const tabOperations = createKeyedWriteQueue();

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

/** Route AI history through the desktop; leave other tab types on their local restore path. */
export function reopenDesktopTabIfNeeded(session: Session): boolean {
	if (!isWebDesktop()) return false;
	const entry = session.unifiedClosedTabHistory?.[0];
	if (entry?.type !== 'ai') return false;
	void tabOperations.enqueue(session.id, async () => {
		// A repeated key press may have queued this same entry before the first
		// acknowledgement consumed it. Never mint two tabs for one history item.
		const current = useSessionStore.getState().sessions.find((s) => s.id === session.id);
		if (
			!current?.unifiedClosedTabHistory?.some((e) => e.type === 'ai' && e.tab.id === entry.tab.id)
		)
			return;
		try {
			const reopened = await window.maestro.web.requestReopenTab(session.id, entry.tab.id);
			if (!reopened?.tabId) throw new Error('The desktop could not restore the conversation.');
			updateSessionWith(session.id, (s) => {
				// A close acknowledgement can beat the inventory snapshot. Drop the
				// confirmed-closed copy before duplicate detection during restore.
				const source = {
					...s,
					aiTabs: s.aiTabs
						.filter((t) => t.id !== entry.tab.id || t.id === reopened.tabId)
						.map((tab) =>
							tab.id === reopened.tabId
								? {
										...entry.tab,
										...tab,
										logs: mergeDeferredItems(entry.tab.logs, tab.logs, (log) => log.id),
										inputValue: entry.tab.inputValue,
										stagedImages: entry.tab.stagedImages,
										saveToHistory: entry.tab.saveToHistory,
										showThinking: entry.tab.showThinking,
									}
								: tab
						),
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
		}
	});
	return true;
}
