/**
 * tabFocusFields - the four session patches that decide which tab the user sees.
 *
 * The main window renders exactly ONE tab type, by this precedence:
 *   terminal (inputMode === 'terminal') > file (activeFileTabId) > browser
 *   (activeBrowserTabId, while inputMode === 'ai') > ai (activeTabId).
 * See findActiveUnifiedTabIndex in unifiedTabOrderUtils.ts.
 *
 * That precedence is why "focus this tab" is never one assignment: landing on a
 * lower-ranked tab means clearing every higher-ranked selection too, and missing
 * one leaves the previous view on screen with the focus silently doing nothing.
 * Each helper below encodes that for one tab type - spread one into a session
 * update rather than hand-rolling the literal.
 *
 * These live in their own module, free of any other import, because BOTH
 * tabHelpers and terminalTabHelpers need them and those two already point at
 * each other. Re-exported from tabHelpers so existing import sites keep working.
 *
 * The inverse of spreading one of these is background placement: see
 * shared/focusPlacement.ts. A create that omits the spread is precisely a tab
 * that does not move the human's view.
 */

import type { Session } from '../types';

/**
 * The session-state patch that focuses an agent's AI tab area.
 *
 * The main window renders exactly one tab type using this precedence:
 *   terminal (inputMode==='terminal') > file (activeFileTabId) > browser
 *   (activeBrowserTabId, while inputMode==='ai') > ai (activeTabId).
 * See findActiveUnifiedTabIndex in unifiedTabOrderUtils.ts. Because browser, file,
 * and terminal all outrank the AI tab, ANY code that wants to land the user on an
 * AI tab must clear all three active-tab ids as well as set inputMode:'ai'. Leaving
 * even one dangling keeps the previous view on screen (e.g. clicking a toast while a
 * browser tab is active silently leaves the user on the browser tab).
 *
 * Spread this into a session update instead of hand-rolling the literal, so the
 * invariant lives in one place:
 *   updateSession(id, (s) => ({ ...s, ...aiTabFocusFields(tabId) }))
 *
 * @param tabId - The AI tab to activate. Omit to clear the non-AI views and force
 *                AI mode without changing which AI tab is active.
 */
export function aiTabFocusFields(tabId?: string): Partial<Session> {
	return {
		...(tabId ? { activeTabId: tabId } : {}),
		activeFileTabId: null,
		activeTerminalTabId: null,
		activeBrowserTabId: null,
		inputMode: 'ai',
	};
}

/**
 * Session patch that lands on a specific file preview tab.
 *
 * The file-tab counterpart to {@link aiTabFocusFields}: spread it into a session
 * update (`{ ...s, ...fileTabFocusFields(tabId) }`) to make that file tab the
 * visible one. Clears the terminal and browser selections and forces AI mode,
 * because both of those outrank the file tab in the render precedence - leaving
 * either set would keep the old view on screen and the focus would appear to do
 * nothing.
 *
 * @param tabId - The file preview tab to activate.
 */
export function fileTabFocusFields(tabId: string): Partial<Session> {
	return {
		activeFileTabId: tabId,
		activeTerminalTabId: null,
		activeBrowserTabId: null,
		inputMode: 'ai',
	};
}

/**
 * Session patch that lands on a specific browser tab.
 *
 * Same contract as {@link fileTabFocusFields}: clear every selection that
 * outranks a browser tab in the render precedence, or the previous view stays
 * on screen and the focus silently does nothing. A browser tab renders in AI
 * mode, so `inputMode` goes to `'ai'` and the terminal selection is cleared.
 *
 * @param tabId - The browser tab to activate.
 */
export function browserTabFocusFields(tabId: string): Partial<Session> {
	return {
		activeBrowserTabId: tabId,
		activeFileTabId: null,
		activeTerminalTabId: null,
		inputMode: 'ai',
	};
}

/**
 * Session patch that lands on a specific terminal tab.
 *
 * The one focus helper that sets `inputMode: 'terminal'` - a terminal tab is
 * only rendered in terminal mode, so leaving the mode alone would activate a
 * tab the user cannot see. File and browser selections are cleared for the same
 * precedence reason as the other helpers.
 *
 * @param tabId - The terminal tab to activate.
 */
export function terminalTabFocusFields(tabId: string): Partial<Session> {
	return {
		activeTerminalTabId: tabId,
		activeFileTabId: null,
		activeBrowserTabId: null,
		inputMode: 'terminal',
	};
}
