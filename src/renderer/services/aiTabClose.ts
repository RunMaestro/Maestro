/**
 * Close one AI tab of ANY agent, the way a click on its chip closes it.
 *
 * The tab strip only ever closes a tab of the agent on screen, so this
 * sequence used to live inside the tab handlers hook, bound to the active
 * agent. Tab Cleanup Suggestions closes tabs across every agent, and a second
 * copy of the sequence would drift on exactly the steps that fail invisibly:
 *
 * - the transcript snapshot is taken BEFORE the close, because afterwards the
 *   tab is gone from the session and there is nothing to snapshot from;
 * - the closed tab goes into the unified closed-tab history, which is what
 *   makes the close undoable with Reopen Closed Tab;
 * - a wizard tab is closed WITHOUT history and its wizard is ended, since a
 *   half-finished wizard cannot be restored;
 * - in the browser build the desktop owns the tab inventory, so the close is a
 *   request to it rather than a local store write.
 *
 * It asks no confirmation. A caller that should confirm (an unsent draft, a
 * wizard in progress) does so first.
 */

import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { clearLiveDraft } from '../utils/liveDraftStore';
import { logger } from '../utils/logger';
import { isWebDesktop } from '../utils/runtimeContext';
import { snapshotClosedTabTranscript } from '../utils/starredSessions';
import { addAiTabToUnifiedHistory, closeTab, hasActiveWizard } from '../utils/tabHelpers';
import { requestDesktopTabClose } from './desktopTabClose';

/**
 * @param endWizard Ends an inline wizard running in the tab. Hook-bound, so a
 *   caller outside React that never closes wizard tabs may omit it.
 * @returns False when the agent or the tab no longer exists. In the browser
 *   build `true` means the close was requested; the desktop confirms it.
 */
export function closeAiTabInSession(
	sessionId: string,
	tabId: string,
	endWizard?: (tabId: string) => Promise<unknown>
): boolean {
	const sessionBeforeClose = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const tabBeforeClose = sessionBeforeClose?.aiTabs.find((t) => t.id === tabId);
	if (!sessionBeforeClose || !tabBeforeClose) return false;
	const wasWizardTab = hasActiveWizard(tabBeforeClose);

	if (isWebDesktop()) {
		void requestDesktopTabClose(sessionId, tabId, endWizard);
		return true;
	}
	snapshotClosedTabTranscript(sessionBeforeClose, tabBeforeClose);

	clearLiveDraft(tabId);
	updateSessionWith(sessionId, (s) => {
		const tab = s.aiTabs.find((t) => t.id === tabId);
		const isWizardTab = tab && hasActiveWizard(tab);
		const unifiedIndex = s.unifiedTabOrder.findIndex(
			(ref) => ref.type === 'ai' && ref.id === tabId
		);
		// `undefined` = read the live unread-filter state, so closing a tab while
		// the strip is narrowed lands on a tab the user can still see.
		const result = closeTab(s, tabId, undefined, { skipHistory: isWizardTab });
		if (!result) return s;
		if (!isWizardTab && tab) {
			return addAiTabToUnifiedHistory(result.session, tab, unifiedIndex);
		}
		return result.session;
	});

	if (wasWizardTab && endWizard) {
		endWizard(tabId).catch((error) =>
			logger.warn('[closeAiTabInSession] Failed to end wizard on tab close:', undefined, error)
		);
	}
	return true;
}
