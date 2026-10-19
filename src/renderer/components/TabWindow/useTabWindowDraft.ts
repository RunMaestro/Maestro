/**
 * useTabWindowDraft - the composer draft of the AI tab a tab window shows (Tab
 * Windows, D2).
 *
 * While a tab is popped out, its draft lives in this window: the text and the
 * command mode in this window's composer store, the staged images on this
 * window's copy of the tab. Showing a tab loads its draft into the composer.
 * For a tab that just popped out, that is the draft the owner had for it: the
 * owner's snapshot carries it (the seed), and `applyTabWindowPatch` keeps this
 * window's own draft only for a tab it already held. Showing another tab keeps
 * the outgoing draft on this window's copy of its tab, a per-window field that
 * no patch overwrites.
 *
 * The owner keeps its own copy on the tab (`inputValue`, `commandMode`,
 * `stagedImages`), and that copy is what it shows once the tab docks. This
 * hook keeps it current with the `setDraft` intent: after a typing pause (the
 * app window's own `DRAFT_FLUSH_DELAY_MS`), and at once when another tab
 * shows, when this window loses focus or hides, when the page unloads, and
 * when the caller asks (`flushDraft`: before a Dock, after a send).
 *
 * A window close docks its tabs in main before this page hears of it, so that
 * last write lands after the dock. The owner hands it to its composer as well
 * (`writeTabWindowDraft` in `services/tabWindowIntents.ts`).
 */

import { useCallback, useEffect } from 'react';
import type { AITab, Session } from '../../types';
import type { TabWindowIntentPayloads } from '../../../shared/tabWindowTypes';
import { updateAiTab, useSessionStore } from '../../stores/sessionStore';
import { useComposerInputStore } from '../../stores/composerInputStore';
import { useDraftPersistence } from '../../hooks/input/useDraftPersistence';
import { DRAFT_FLUSH_DELAY_MS } from '../../hooks/input/useInputSync';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { sendTabWindowIntent } from '../../services/tabWindowIntentSender';
import { normalizeComposerCommandMode } from '../../utils/shellCommandInput';
import { setLiveDraft } from '../../utils/liveDraftStore';

/** A tab's draft, as the `setDraft` intent carries it. */
type TabWindowDraft = TabWindowIntentPayloads['setDraft'];

export interface TabWindowDraftControls {
	/** Send the draft still waiting for its typing pause to the owner now. */
	flushDraft: () => void;
}

function findAiTab(sessions: Session[], agentId: string, tabId: string): AITab | undefined {
	return sessions.find((s) => s.id === agentId)?.aiTabs.find((t) => t.id === tabId);
}

/** The tab's draft as the user sees it: the composer's text and mode while it holds the tab. */
function readDraft(agentId: string, tabId: string): TabWindowDraft {
	const tab = findAiTab(useSessionStore.getState().sessions, agentId, tabId);
	const composer = useComposerInputStore.getState();
	const held = composer.aiValueTabId === tabId;
	return {
		inputValue: held ? composer.aiValue : (tab?.inputValue ?? ''),
		commandMode: held ? composer.aiCommandMode : normalizeComposerCommandMode(tab?.commandMode),
		stagedImages: tab?.stagedImages ?? [],
	};
}

/** Keep the composer's text and mode on this window's copy of the tab it holds. */
function keepComposerDraftOnTab(agentId: string, tabId: string): void {
	const composer = useComposerInputStore.getState();
	if (composer.aiValueTabId !== tabId) return;
	const tab = findAiTab(useSessionStore.getState().sessions, agentId, tabId);
	if (
		!tab ||
		(tab.inputValue === composer.aiValue &&
			normalizeComposerCommandMode(tab.commandMode) === composer.aiCommandMode)
	) {
		return;
	}
	updateAiTab(agentId, tabId, (t) => ({
		...t,
		inputValue: composer.aiValue,
		commandMode: composer.aiCommandMode,
	}));
}

/**
 * Hold the draft of the AI tab this window shows (`tabId`; null while a tab of
 * another kind shows) and keep the owner's copy of it current.
 */
export function useTabWindowDraft(agentId: string, tabId: string | null): TabWindowDraftControls {
	const sendDraft = useCallback(
		(draftTabId: string, draft: TabWindowDraft) => {
			sendTabWindowIntent({
				kind: 'setDraft',
				agentId,
				tabRef: { type: 'ai', id: draftTabId },
				...draft,
			});
		},
		[agentId]
	);
	// The app window's write-back primitive: one write per typing pause, and a
	// write still waiting is sent, never dropped, when the tab changes or the
	// hook unmounts.
	const { queueFlush, flushPending } = useDraftPersistence(sendDraft, DRAFT_FLUSH_DELAY_MS);

	// Show: load the tab's draft. Leave: keep it on this window's copy of the
	// tab, and send what is still waiting (the tab may be docking).
	useEffect(() => {
		if (!tabId) return;
		const tab = findAiTab(useSessionStore.getState().sessions, agentId, tabId);
		useComposerInputStore
			.getState()
			.loadAiDraft(tabId, tab?.inputValue ?? '', normalizeComposerCommandMode(tab?.commandMode));
		return () => {
			keepComposerDraftOnTab(agentId, tabId);
			flushPending();
		};
	}, [agentId, tabId, flushPending]);

	// Every edit queues a write-back: the text and mode in the composer, the
	// staged images on this window's copy of the tab.
	useEffect(() => {
		if (!tabId) return;
		const queue = () => queueFlush(tabId, readDraft(agentId, tabId));
		const offText = useComposerInputStore.subscribe((next, prev) => {
			// A load hands the composer to a tab; only what changes after it is an edit.
			if (next.aiValueTabId !== tabId || prev.aiValueTabId !== tabId) return;
			if (next.aiValue !== prev.aiValue || next.aiCommandMode !== prev.aiCommandMode) queue();
		});
		const offImages = useSessionStore.subscribe((next, prev) => {
			if (next.sessions === prev.sessions) return;
			const images = findAiTab(next.sessions, agentId, tabId)?.stagedImages;
			if (images !== findAiTab(prev.sessions, agentId, tabId)?.stagedImages) queue();
		});
		return () => {
			offText();
			offImages();
		};
	}, [agentId, tabId, queueFlush]);

	// The live draft marker that the strip and the close confirm read (`hasDraft`).
	useEffect(
		() =>
			useComposerInputStore.subscribe((next, prev) => {
				if (next.aiValue === prev.aiValue && next.aiValueTabId === prev.aiValueTabId) return;
				if (next.aiValueTabId) setLiveDraft(next.aiValueTabId, next.aiValue);
			}),
		[]
	);

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

	return { flushDraft: flushPending };
}
