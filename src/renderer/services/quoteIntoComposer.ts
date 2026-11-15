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
import { collectLeafTabRefs, findLeafByTabRef, focusPaneInSession } from '../utils/panelLayout';
import { jumpToAgent } from './agentNavigation';
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

/** How {@link insertIntoAgentComposer} adds its text and where it leaves the user. */
export interface ComposerInsertOptions {
	/** `quote` prefixes every line with `> `; `block` appends the text as-is. */
	format: 'quote' | 'block';
	/** Images (data URLs) to stage on the same tab, deduped against what is staged. */
	images?: string[];
	/** False leaves the visible tab alone (CLI `--background`). Default true. */
	reveal?: boolean;
	/** Toast copy when the agent has no AI tab to take the text. */
	missingTabMessage?: string;
}

/**
 * Add `text` to the draft of `sessionId`'s active AI tab (the tiled group's
 * AI pane when a group is showing), stage any images on that tab, and by
 * default land the user in that composer.
 *
 * Returns the AI tab id, or null (and says so in a toast) when the agent is
 * gone or has no AI tab, rather than leave the user wondering where it went.
 */
export function insertIntoAgentComposer(
	sessionId: string,
	text: string,
	options: ComposerInsertOptions
): string | null {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const target = session ? resolveComposerTarget(session) : null;
	const tab = target ? session?.aiTabs.find((t) => t.id === target.tabId) : undefined;
	if (!session || !target || !tab) {
		notifyToast({
			color: 'yellow',
			title: 'Nothing to Quote Into',
			message:
				options.missingTabMessage ??
				'This agent has no AI tab. Open one, then quote the selection again.',
		});
		return null;
	}
	const { tabId, inGroup } = target;
	const append = options.format === 'quote' ? appendQuoteToDraft : appendBlockToDraft;
	const reveal = options.reveal !== false;

	const composer = useComposerInputStore.getState();
	// The live slot holds this tab's draft only while this agent is the active
	// one; anywhere else the tab's saved draft is the source of truth.
	const isActiveAgent = useSessionStore.getState().activeSessionId === sessionId;
	if (composer.aiValueTabId === tabId || (isActiveAgent && composer.aiValueTabId === null)) {
		// The live slot holds this tab's draft (or unowned text it will adopt):
		// append to what is on screen, which may be newer than tab.inputValue.
		// A quote is prose for the agent, never a shell command line.
		if (composer.aiCommandMode !== 'off') composer.setAiCommandMode('off');
		composer.setAiValue((prev) => append(prev, text));
		composer.adoptAiDraft(tabId);
	} else {
		// The live slot belongs to another tab; its text is flushed to that tab
		// on its own timer. Build from this tab's saved draft and, when this
		// agent is on screen, load the result into the composer stamped with
		// this tab as owner.
		const next = append(tab.inputValue ?? '', text);
		updateSessionWith(sessionId, (s) => ({
			...s,
			aiTabs: s.aiTabs.map((t) =>
				t.id === tabId ? { ...t, inputValue: next, commandMode: 'off' } : t
			),
		}));
		if (isActiveAgent && reveal) composer.loadAiDraft(tabId, next, 'off');
	}

	const images = options.images?.filter(Boolean) ?? [];
	if (images.length > 0) {
		updateSessionWith(sessionId, (s) => ({
			...s,
			aiTabs: s.aiTabs.map((t) => {
				if (t.id !== tabId) return t;
				const staged = t.stagedImages ?? [];
				const fresh = images.filter((img) => !staged.includes(img));
				return fresh.length > 0 ? { ...t, stagedImages: [...staged, ...fresh] } : t;
			}),
		}));
	}

	if (reveal) {
		if (!isActiveAgent) {
			// A caller outside the agent on screen (`maestro-cli browser-pick
			// --focus` into a background browser, a diff review for another
			// agent) must also bring that agent up, or the focus request below
			// lands in the visible agent's composer. The switch loads the tab's
			// saved draft, written above. `stayInTiledGroup` keeps the layout
			// the user built in that agent when the target is one of its panes.
			jumpToAgent(sessionId, { tabId, stayInTiledGroup: inGroup });
		} else {
			updateSessionWith(sessionId, (s) => {
				if (!inGroup) return { ...s, ...aiTabFocusFields(tabId) };
				// Focus the AI pane, not just the tab: the composer is drawn for
				// the group's focused pane, so a file pane left focused hides it.
				const group = s.tabGroups?.find((g) => g.id === s.activeGroupId);
				const leaf = group ? findLeafByTabRef(group.layout, { type: 'ai', id: tabId }) : null;
				return group && leaf
					? focusPaneInSession(s, group.id, leaf.id)
					: { ...s, activeTabId: tabId };
			});
		}
		useUIStore.getState().requestTabFocus({ type: 'ai', id: tabId });
	}
	return tabId;
}

/**
 * Append `text` as a Markdown quote to the draft of `sessionId`'s active AI
 * tab, then land the user in that composer.
 *
 * Returns false (and says so in a toast) when the agent is gone or has no AI
 * tab, rather than leave the user wondering where the quote went.
 */
export function quoteIntoAgentComposer(sessionId: string, text: string): boolean {
	return insertIntoAgentComposer(sessionId, text, { format: 'quote' }) !== null;
}
