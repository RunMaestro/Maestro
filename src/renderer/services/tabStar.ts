/**
 * Starring or unstarring an AI tab, the one write every control goes through: the tab strip's
 * star, the toggle shortcut, and `maestro-cli tab star` / `unstar` (`useRemoteIntegration`).
 *
 * It saves the star with the provider session (`persistTabStarred()`, which also refreshes the
 * Left Bar's starred list), hands it to a hosted agent's host (`starHostedTab()`), and writes the
 * tab here. A hosted tab is drawn from its host's record, so a star held only in this window is
 * gone on the next sync. For a local or SSH agent the host step is a no-op.
 */

import { selectSessionById, updateAiTab, useSessionStore } from '../stores/sessionStore';
import { persistTabStarred } from '../utils/starredSessions';
import { starHostedTab } from './hostedTurns';

/**
 * Star or unstar one tab, here and on its host. A tab that is not there is left alone; the
 * provider write is skipped for a tab with no provider session yet. Callers that only star a
 * tab with a conversation check that themselves. Returns whether the tab was found.
 */
export function setTabStarred(sessionId: string, tabId: string, starred: boolean): boolean {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const tab = session?.aiTabs.find((candidate) => candidate.id === tabId);
	if (!session || !tab) return false;
	persistTabStarred(session, tab, starred);
	starHostedTab(session, tabId, starred);
	updateAiTab(sessionId, tabId, (current) => ({ ...current, starred }));
	return true;
}
