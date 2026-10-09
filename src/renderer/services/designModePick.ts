/**
 * Deliver a Design Mode pick to the agent that owns the browser tab.
 *
 * The browser tab hides the composer, so a pick lands on the agent's current
 * AI tab: the cropped screenshot is staged on that tab (the same
 * `AITab.stagedImages` list a pasted or dropped image goes into), the prompt
 * text is appended to its draft, and the view switches to that tab so the user
 * can add what they want changed and send it.
 */

import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useComposerInputStore } from '../stores/composerInputStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { aiTabFocusFields } from '../utils/tabFocusFields';
import { buildDesignModePrompt, type DesignModePick } from '../utils/designModePicker';

/** Append `text` to a draft, separated from what the user already typed by a blank line. */
export function appendToDraft(draft: string | undefined, text: string): string {
	const existing = (draft ?? '').replace(/\s+$/, '');
	return existing ? `${existing}\n\n${text}` : text;
}

/**
 * Stage the pick on the agent's active AI tab and switch the view to it.
 * Returns false (and tells the user why) when the agent has no AI tab to take it.
 */
export function sendDesignPickToComposer(
	sessionId: string,
	pick: DesignModePick,
	screenshot: string | null
): boolean {
	const { sessions, activeSessionId } = useSessionStore.getState();
	const session = sessions.find((s) => s.id === sessionId);
	const tabId = session?.activeTabId;
	const tab = tabId ? session?.aiTabs.find((t) => t.id === tabId) : undefined;
	if (!session || !tabId || !tab) {
		notifyCenterFlash({ message: 'No AI tab to send the element to', color: 'red' });
		return false;
	}

	const text = buildDesignModePrompt(pick, { hasScreenshot: !!screenshot });

	// The composer store holds the live draft for the active agent's active AI
	// tab; anywhere else the tab's persisted draft is the source of truth. Text,
	// command mode, and owner move together: a pick is a message for the agent,
	// so the composer leaves command mode rather than running the HTML as a shell
	// command.
	const composer = useComposerInputStore.getState();
	const liveDraft =
		sessionId === activeSessionId && composer.aiValueTabId === tabId
			? composer.aiValue
			: tab.inputValue;
	const nextDraft = appendToDraft(liveDraft, text);

	updateSessionWith(sessionId, (s) => ({
		...s,
		...aiTabFocusFields(tabId),
		aiTabs: s.aiTabs.map((t) => {
			if (t.id !== tabId) return t;
			const staged = t.stagedImages ?? [];
			return {
				...t,
				inputValue: nextDraft,
				commandMode: 'off',
				stagedImages: screenshot && !staged.includes(screenshot) ? [...staged, screenshot] : staged,
			};
		}),
	}));
	if (sessionId === activeSessionId) composer.loadAiDraft(tabId, nextDraft, 'off');

	notifyCenterFlash({
		message: 'Element sent to the composer',
		detail: screenshot ? undefined : 'The element was off screen, so no screenshot was attached',
		color: 'green',
	});
	return true;
}
