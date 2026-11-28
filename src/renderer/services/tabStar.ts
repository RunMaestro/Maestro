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
import { tabStarRefusal } from '../../shared/maestro-lib/agents/rules';
import { starHostedTab } from './hostedTurns';

/** What a star write did: done, or refused with the reason a caller shows. */
export type TabStarResult = { success: true } | { success: false; error: string };

/**
 * Star or unstar one tab, here and on its host. A star marks a conversation, so a tab with no
 * provider session yet is refused (`tabStarRefusal()`) in every mode, and a tab that is not there
 * is refused as not found. Nothing is written on a refusal.
 */
export function setTabStarred(sessionId: string, tabId: string, starred: boolean): TabStarResult {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const tab = session?.aiTabs.find((candidate) => candidate.id === tabId);
	if (!session || !tab) return { success: false, error: `Tab not found: ${tabId}` };
	const refusal = tabStarRefusal(tab, starred);
	if (refusal) return { success: false, error: refusal };
	persistTabStarred(session, tab, starred);
	starHostedTab(session, tabId, starred);
	updateAiTab(sessionId, tabId, (current) => ({ ...current, starred }));
	return { success: true };
}
