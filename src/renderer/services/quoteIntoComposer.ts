/**
 * quoteIntoComposer - "Quote in Message" from a surface that is not the chat.
 *
 * The transcript quotes straight into the composer under it (TerminalOutput's
 * own handler). A file tab has no composer under it: the AI tab's composer
 * only renders when that tab is the visible one. So quoting from File Preview
 * appends to the agent's active AI tab draft, switches the main window to that
 * tab, and asks the panel to put the caret in the composer.
 */

import { appendBlockToDraft, appendQuoteToDraft } from '../utils/quoteSelection';
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
export function resolveComposerTarget(
	session: Session
): { tabId: string; inGroup: boolean } | null {
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
	return appendToAgentComposer(sessionId, text, appendQuoteToDraft, {
		title: 'Nothing to Quote Into',
		message: 'This agent has no AI tab. Open one, then quote the selection again.',
	});
}

/**
 * Append an already-formatted Markdown block (a diff review) to the draft of
 * `sessionId`'s active AI tab as-is, then land the user in that composer so
 * they can edit it before sending. Same target and draft rules as
 * `quoteIntoAgentComposer`.
 *
 * `background` (a CLI caller passing `--background`) writes the draft and
 * moves nothing: no tab switch, no focus request. The block is waiting in the
 * tab's composer the next time the user opens it.
 */
export function insertIntoAgentComposer(
	sessionId: string,
	block: string,
	options: { background?: boolean } = {}
): boolean {
	return appendToAgentComposer(
		sessionId,
		block,
		appendBlockToDraft,
		{
			title: 'No Composer to Fill',
			message: 'This agent has no AI tab. Open one, then try again.',
		},
		options.background === true
	);
}

function appendToAgentComposer(
	sessionId: string,
	text: string,
	append: (draft: string, text: string) => string,
	missing: { title: string; message: string },
	background = false
): boolean {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const target = session ? resolveComposerTarget(session) : null;
	const tab = target ? session?.aiTabs.find((t) => t.id === target.tabId) : undefined;
	if (!session || !target || !tab) {
		notifyToast({ color: 'yellow', ...missing });
		return false;
	}
	const { tabId, inGroup } = target;

	const composer = useComposerInputStore.getState();
	// Unowned live text is adopted by whichever tab is shown next; in the
	// background that is not this tab, so only a slot it already owns counts.
	const ownsLiveSlot =
		composer.aiValueTabId === tabId || (!background && composer.aiValueTabId === null);
	if (ownsLiveSlot) {
		// The live slot holds this tab's draft (or unowned text it will adopt):
		// append to what is on screen, which may be newer than tab.inputValue.
		// A quote or a review is prose for the agent, never a shell command line.
		if (composer.aiCommandMode !== 'off') composer.setAiCommandMode('off');
		composer.setAiValue((prev) => append(prev, text));
		composer.adoptAiDraft(tabId);
	} else {
		// The live slot belongs to another tab; its text is flushed to that tab
		// on its own timer. Build from this tab's saved draft and load the
		// result into the composer stamped with this tab as owner.
		const next = append(tab.inputValue ?? '', text);
		updateSessionWith(sessionId, (s) => ({
			...s,
			aiTabs: s.aiTabs.map((t) =>
				t.id === tabId ? { ...t, inputValue: next, commandMode: 'off' } : t
			),
		}));
		// In the background the saved draft is enough: the tab loads it when shown.
		if (!background) composer.loadAiDraft(tabId, next, 'off');
	}

	if (background) return true;
	updateSessionWith(sessionId, (s) =>
		inGroup ? { ...s, activeTabId: tabId } : { ...s, ...aiTabFocusFields(tabId) }
	);
	useUIStore.getState().requestTabFocus({ type: 'ai', id: tabId });
	return true;
}
