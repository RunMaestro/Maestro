/**
 * quoteIntoComposer - "Quote in Message" from a surface that is not the chat.
 *
 * The transcript quotes straight into the composer under it (TerminalOutput's
 * own handler). A file tab has no composer under it: the AI tab's composer
 * only renders when that tab is the visible one. So quoting from File Preview
 * appends to the agent's active AI tab draft, switches the main window to that
 * tab, and asks the panel to put the caret in the composer. A Design Mode pick
 * goes to the same tab the same way, as a chip staged on it rather than text.
 */

import { appendBlockToDraft, appendQuoteToDraft } from '../utils/quoteSelection';
import { useComposerInputStore } from '../stores/composerInputStore';
import { useSessionStore, updateAiTab, updateSessionWith } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { aiTabFocusFields } from '../utils/tabFocusFields';
import { notifyToast } from '../stores/notificationStore';
import { collectLeafTabRefs, findLeafByTabRef, focusPaneInSession } from '../utils/panelLayout';
import { jumpToAgent } from './agentNavigation';
import type { AITab, Session, StagedDesignPick } from '../types';

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

/** The AI tab a delivery lands in, and whether it is a pane of the tiled group on screen. */
interface ComposerTargetTab {
	tab: AITab;
	inGroup: boolean;
}

/**
 * Find the AI tab a delivery to `sessionId` lands in ({@link
 * resolveComposerTarget}). Null, after a toast that says so, when the agent is
 * gone or has no AI tab, rather than leave the user wondering where it went.
 */
function findComposerTargetTab(
	sessionId: string,
	missingTabMessage: string
): ComposerTargetTab | null {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const target = session ? resolveComposerTarget(session) : null;
	const tab = target ? session?.aiTabs.find((t) => t.id === target.tabId) : undefined;
	if (!target || !tab) {
		notifyToast({ color: 'yellow', title: 'Nothing to Quote Into', message: missingTabMessage });
		return null;
	}
	return { tab, inGroup: target.inGroup };
}

function isActiveAgent(sessionId: string): boolean {
	return useSessionStore.getState().activeSessionId === sessionId;
}

/**
 * Whether the live composer slot holds `tabId`'s draft (or unowned text it
 * will adopt). It does only while this agent is the active one; anywhere else
 * the tab's saved draft is the source of truth.
 */
function liveSlotHoldsTab(sessionId: string, tabId: string): boolean {
	const { aiValueTabId } = useComposerInputStore.getState();
	return aiValueTabId === tabId || (isActiveAgent(sessionId) && aiValueTabId === null);
}

/**
 * Land the user in `tabId`'s composer: bring its agent on screen, show the tab
 * (or focus its pane in the tiled group on screen), and ask the panel to put
 * the caret there.
 */
function revealComposerTab(sessionId: string, tabId: string, inGroup: boolean): void {
	if (!isActiveAgent(sessionId)) {
		// A caller outside the agent on screen (`maestro-cli browser-pick
		// --focus` into a background browser, a diff review for another
		// agent) must also bring that agent up, or the focus request below
		// lands in the visible agent's composer. The switch loads the tab's
		// saved draft, which the caller has already written. `stayInTiledGroup`
		// keeps the layout the user built in that agent when the target is one
		// of its panes.
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
	const target = findComposerTargetTab(
		sessionId,
		options.missingTabMessage ??
			'This agent has no AI tab. Open one, then quote the selection again.'
	);
	if (!target) return null;
	const { tab, inGroup } = target;
	const tabId = tab.id;
	const append = options.format === 'quote' ? appendQuoteToDraft : appendBlockToDraft;
	const reveal = options.reveal !== false;

	const composer = useComposerInputStore.getState();
	if (liveSlotHoldsTab(sessionId, tabId)) {
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
		if (isActiveAgent(sessionId) && reveal) composer.loadAiDraft(tabId, next, 'off');
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

	if (reveal) revealComposerTab(sessionId, tabId, inGroup);
	return tabId;
}

/** Where {@link stageDesignPickOnAgent} leaves the user. */
export interface DesignPickStageOptions {
	/** False leaves the visible tab alone ("Add and Pick Another", CLI `--background`). Default true. */
	reveal?: boolean;
	/** Toast copy when the agent has no AI tab to take the chip. */
	missingTabMessage?: string;
}

/**
 * Stage a Design Mode pick as a chip on `sessionId`'s composer target (the AI
 * tab {@link resolveComposerTarget} picks), after any chips already there, and
 * by default land the user in that composer. The draft text is left as it is:
 * the chip is expanded into the message when it is sent.
 *
 * Returns the AI tab id, or null (and says so in a toast) when the agent is
 * gone or has no AI tab.
 */
export function stageDesignPickOnAgent(
	sessionId: string,
	pick: StagedDesignPick,
	options: DesignPickStageOptions = {}
): string | null {
	const target = findComposerTargetTab(
		sessionId,
		options.missingTabMessage ?? 'This agent has no AI tab. Open one, then pick again.'
	);
	if (!target) return null;
	const { tab, inGroup } = target;
	// A chip is part of a message for the agent, and neither command rung sends
	// attachments, so the tab leaves command mode, as it does for a quote. The
	// live slot's mode is this tab's only while the slot holds its draft.
	if (liveSlotHoldsTab(sessionId, tab.id)) {
		const composer = useComposerInputStore.getState();
		if (composer.aiCommandMode !== 'off') composer.setAiCommandMode('off');
	}
	updateAiTab(sessionId, tab.id, (t) => ({
		...t,
		commandMode: 'off',
		stagedDesignPicks: [...(t.stagedDesignPicks ?? []), pick],
	}));
	if (options.reveal !== false) revealComposerTab(sessionId, tab.id, inGroup);
	return tab.id;
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
