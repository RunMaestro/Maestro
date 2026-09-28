/**
 * paneFocus - where the caret goes when a pane takes focus.
 *
 * A tab group's `focusedPaneId` drives the focus RING and input routing, but it
 * does not move DOM focus. Something has to decide what "focus this pane" means
 * for each tab kind, and the answer differs per kind:
 *
 *   terminal -> that tab's xterm, so the next keystroke is a command
 *   ai       -> the shared chat textarea, so the next keystroke is a message
 *   browser  -> the address bar, selected, so the next keystroke is a URL
 *   file     -> the editor, so the next keystroke is the note you opened it for
 *
 * That mapping used to live inline in MainPanelContent's focus-request effect,
 * and it only covered the first two - a tiled browser or file pane took the ring
 * but left the caret in the pane you came from, so you started typing into the
 * wrong tab. Keeping it here means the routing is one testable function rather
 * than a growing `else if` chain inside an effect, and it is why a plain new
 * file / browser tab gets the same treatment as a tiled one for free.
 *
 * Terminal and AI go through handles the caller owns. Browser and file are
 * resolved from the DOM by tab id, because neither element is reachable by ref
 * from the caller: the browser address bar lives in a keep-alive overlay
 * mounted at panel level (outside the tiled tree), and the file editor is a
 * CodeMirror instance several components down inside its pane. The browser path
 * matches what `focusBrowserAddressBar` on the MainPanel handle already does.
 */

import type { UnifiedTabRef } from '../types';

/**
 * DOM id of a browser tab's address input. Owned by BrowserTabView; also used
 * by the MainPanel handle's `focusBrowserAddressBar`.
 */
export function browserAddressBarId(tabId: string): string {
	return `browser-tab-address-${tabId}`;
}

/**
 * Marks the subtree rendering a file tab's preview/editor so the focus router
 * can find THAT tab's editor when several file panes are on screen at once.
 * Spread onto the element wrapping a `<FilePreview>`.
 */
export function filePaneAttrs(tabId: string): { 'data-file-pane-tab': string } {
	return { 'data-file-pane-tab': tabId };
}

/** Handles the caller owns for the two kinds that expose a focus API. */
export interface PaneFocusTargets {
	/** Focus a terminal tab's xterm BY ID, reporting whether it existed. A tiled
	 *  terminal never sets `activeTerminalTabId`, so the "active terminal"
	 *  variant lands on the wrong terminal or none. */
	focusTerminal?: (tabId: string) => boolean;
	/** Focus the shared AI chat input. Already scoped to the focused pane's tab,
	 *  since focusPaneInSession syncs `activeTabId` for AI panes. */
	focusAiInput?: () => boolean;
}

/**
 * Put DOM focus inside `tab`'s real input. Returns true when something was
 * focused, false when the target could not be found (the pane is still
 * mounting, or the file pane is in preview mode with no editor).
 *
 * Safe to call for any tab kind; unknown kinds are a no-op.
 */
export function focusPaneInput(tab: UnifiedTabRef, targets: PaneFocusTargets = {}): boolean {
	switch (tab.type) {
		case 'terminal':
			return targets.focusTerminal?.(tab.id) ?? false;
		case 'ai':
			return targets.focusAiInput?.() ?? false;
		case 'browser': {
			const input = document.getElementById(browserAddressBarId(tab.id)) as HTMLInputElement | null;
			if (!input) return false;
			input.focus();
			// Select so the placeholder home URL is replaced by what you type
			// rather than appended to. Mirrors the Cmd+L behavior.
			input.select();
			return true;
		}
		case 'file': {
			const pane = document.querySelector(`[data-file-pane-tab="${CSS.escape(tab.id)}"]`);
			if (!pane) return false;
			// Edit mode: the CodeMirror content element takes a real caret, so a
			// freshly tiled blank file is immediately typeable.
			const editor = pane.querySelector('.cm-content') as HTMLElement | null;
			if (editor) {
				editor.focus();
				return true;
			}
			// Preview mode has no text input. Fall back to the preview container
			// (it carries tabIndex={0}) so arrow keys scroll THIS pane instead of
			// staying with the pane the user came from.
			const container = pane.querySelector('[tabindex]') as HTMLElement | null;
			if (!container) return false;
			container.focus();
			return true;
		}
		default:
			return false;
	}
}

/**
 * How long to keep trying before giving up, and how often to re-check. A pane
 * created and tiled in one commit has not rendered when the request is
 * published, and the two heaviest kinds take visibly longer than one frame:
 * the file editor is a lazily-imported CodeMirror bundle, and a browser pane's
 * address bar lives in a keep-alive overlay that mounts a render later. A
 * single fixed delay either fires too early for those or feels sluggish for the
 * rest, so poll instead and stop the moment something takes focus.
 */
const RETRY_INTERVAL_MS = 50;
const RETRY_TIMEOUT_MS = 2000;

/**
 * {@link focusPaneInput}, retried until the target exists or the deadline
 * passes. Returns a cancel function - call it from an effect cleanup so a
 * superseded request cannot steal focus after the user has moved on.
 */
export function focusPaneInputWhenReady(
	tab: UnifiedTabRef,
	targets: PaneFocusTargets = {},
	options: { intervalMs?: number; timeoutMs?: number } = {}
): () => void {
	const { intervalMs = RETRY_INTERVAL_MS, timeoutMs = RETRY_TIMEOUT_MS } = options;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let elapsed = 0;
	let cancelled = false;

	const attempt = () => {
		if (cancelled) return;
		if (focusPaneInput(tab, targets)) return;
		elapsed += intervalMs;
		if (elapsed >= timeoutMs) return;
		timer = setTimeout(attempt, intervalMs);
	};

	timer = setTimeout(attempt, intervalMs);
	return () => {
		cancelled = true;
		if (timer) clearTimeout(timer);
	};
}
