import type { Session, AITab, LogEntry, ThinkingMode } from '../../types';

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
		// Landing on a standalone AI tab always leaves any active tiled group so the
		// group's layout stops taking over the panel. A no-op when no group is active.
		activeGroupId: null,
	};
}

/**
 * Field patch for flipping a tab's read-only state.
 *
 * Keeps the legacy `readOnlyMode` boolean and the 3-way `permissionMode` in
 * lockstep, so the toolbar pill (resolved via resolveTabPermissionMode) and the
 * spawn path can never drift: toggling read-only ON means `readonly`, OFF means
 * full access. This mirrors what the toolbar's permission cycle already writes.
 * Every read-only toggle entry point (keyboard shortcut, quick action, prompt
 * composer, tab menu, tab store) spreads this instead of writing `readOnlyMode`
 * alone - the old inline `readOnlyMode: !tab.readOnlyMode` left `permissionMode`
 * stale, so a Full Access tab kept its pill after being switched to read-only.
 * `standard` is reachable only through the toolbar cycle, so toggling read-only
 * off lands on `full` (the non-readonly default).
 */
export function toggleReadOnlyModeFields(tab: Pick<AITab, 'readOnlyMode'>): {
	readOnlyMode: boolean;
	permissionMode: 'full' | 'readonly';
} {
	const nextReadOnly = !tab.readOnlyMode;
	return { readOnlyMode: nextReadOnly, permissionMode: nextReadOnly ? 'readonly' : 'full' };
}

/**
 * Field patch for cycling a tab's thinking-display mode: off -> on -> sticky -> off.
 *
 * Turning the mode OFF also drops the tab's stored thinking logs - only thinking
 * logs are storage-gated (tool logs are always recorded and hidden purely at
 * render, see the global tool-call visibility setting + TerminalOutput), so this
 * must never touch anything but `source: 'thinking'` entries. Every entry point
 * that cycles this mode (quick actions, prompt composer, tab store, keyboard
 * shortcut) should spread this instead of re-deriving the cycle, so the four
 * copies that existed before can't drift on the log-clearing behavior.
 */
export function cycleShowThinkingFields(tab: Pick<AITab, 'showThinking' | 'logs'>): {
	showThinking: ThinkingMode;
	logs: LogEntry[];
} {
	const current = tab.showThinking;
	const newMode: ThinkingMode =
		!current || current === 'off' ? 'on' : current === 'on' ? 'sticky' : 'off';
	if (newMode === 'off') {
		return { showThinking: 'off', logs: tab.logs.filter((l) => l.source !== 'thinking') };
	}
	return { showThinking: newMode, logs: tab.logs };
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
		// A standalone file tab takes over the panel, so it must leave any active
		// tiled group - otherwise the group keeps winning render precedence and the
		// file the user just opened never appears.
		activeGroupId: null,
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
		// A standalone terminal takes over the panel, so it must leave any active
		// tiled group (mirrors selectTerminalTab). Without this the group stays
		// active, TiledLayout keeps publishing pane rects, and a tiled browser
		// overlay bleeds over the terminal view (its webview sits above at z-index 2).
		activeGroupId: null,
	};
}
