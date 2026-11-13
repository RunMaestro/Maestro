/**
 * quoteIntoComposer - "Quote in Message" from a surface that is not the chat.
 *
 * The transcript quotes straight into the composer under it (TerminalOutput's
 * own handler). A file tab has no composer under it: the AI tab's composer
 * only renders when that tab is the visible one. So quoting from File Preview
 * appends to the agent's active AI tab draft, switches the main window to that
 * tab, and asks the panel to put the caret in the composer.
 */

import { appendQuoteToDraft } from '../utils/quoteSelection';
import { useComposerInputStore } from '../stores/composerInputStore';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { aiTabFocusFields } from '../utils/tabFocusFields';
import { notifyToast } from '../stores/notificationStore';
import { collectLeafTabRefs } from '../utils/panelLayout';
import type { Session } from '../types';

/**
 * The AI tab a quote lands in, and whether reaching it means leaving a tiled
 * group. Inside a group that has an AI pane, the quote goes to that pane (the
 * active AI tab when it is one of them) and the layout stays as it is; leaving
 * the group to show a standalone tab would undo the split the user built to
 * read the file beside the chat.
 */
function resolveQuoteTarget(session: Session): { tabId: string; inGroup: boolean } | null {
	const group = session.activeGroupId
		? session.tabGroups?.find((g) => g.id === session.activeGroupId)
		: undefined;
	if (group) {
		const aiPanes = collectLeafTabRefs(group.layout)
			.filter((ref) => ref.type === 'ai')
			.map((ref) => ref.id);
		const tabId = aiPanes.includes(session.activeTabId) ? session.activeTabId : aiPanes[0];
		if (tabId) return { tabId, inGroup: true };
	}
	return session.activeTabId ? { tabId: session.activeTabId, inGroup: false } : null;
}

/**
 * Append `text` as a Markdown quote to the draft of `sessionId`'s active AI
 * tab, then land the user in that composer.
 *
 * Returns false (and says so in a toast) when the agent is gone or has no AI
 * tab, rather than leave the user wondering where the quote went.
 */
export function quoteIntoAgentComposer(sessionId: string, text: string): boolean {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const target = session ? resolveQuoteTarget(session) : null;
	const tab = target ? session?.aiTabs.find((t) => t.id === target.tabId) : undefined;
	if (!session || !target || !tab) {
		notifyToast({
			color: 'yellow',
			title: 'Nothing to Quote Into',
			message: 'This agent has no AI tab. Open one, then quote the selection again.',
		});
		return false;
	}
	const { tabId, inGroup } = target;

	const composer = useComposerInputStore.getState();
	if (composer.aiValueTabId === tabId || composer.aiValueTabId === null) {
		// The live slot holds this tab's draft (or unowned text it will adopt):
		// append to what is on screen, which may be newer than tab.inputValue.
		// A quote is prose for the agent, never a shell command line.
		if (composer.aiCommandMode !== 'off') composer.setAiCommandMode('off');
		composer.setAiValue((prev) => appendQuoteToDraft(prev, text));
		composer.adoptAiDraft(tabId);
	} else {
		// The live slot belongs to another tab; its text is flushed to that tab
		// on its own timer. Build from this tab's saved draft and load the
		// result into the composer stamped with this tab as owner.
		const next = appendQuoteToDraft(tab.inputValue ?? '', text);
		updateSessionWith(sessionId, (s) => ({
			...s,
			aiTabs: s.aiTabs.map((t) =>
				t.id === tabId ? { ...t, inputValue: next, commandMode: 'off' } : t
			),
		}));
		composer.loadAiDraft(tabId, next, 'off');
	}

	updateSessionWith(sessionId, (s) =>
		inGroup ? { ...s, activeTabId: tabId } : { ...s, ...aiTabFocusFields(tabId) }
	);
	useUIStore.getState().requestTabFocus({ type: 'ai', id: tabId });
	return true;
}
