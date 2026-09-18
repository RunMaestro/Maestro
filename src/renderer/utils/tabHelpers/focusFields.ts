import type { Session, AITab, LogEntry, ThinkingMode } from '../../types';
import { nextThinkingMode } from '../../../shared/types';

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
 * Field patch for setting a tab's permission mode outright.
 *
 * Same invariant as {@link toggleReadOnlyModeFields} - the legacy
 * `readOnlyMode` boolean moves with the 3-way `permissionMode`, so the pill and
 * the spawn path cannot drift - but for the surfaces that name a mode rather
 * than flipping one. Two exist: the composer toolbar's cycle (`full` ->
 * `standard` -> `readonly`, tapping through the options) and the phone options
 * sheet (which lists them and lets the user pick, because tap-to-cycle through
 * three states is a poor control on a touchscreen). Both spread this rather
 * than writing the pair by hand.
 */
export function permissionModeFields(mode: 'full' | 'standard' | 'readonly'): {
	permissionMode: 'full' | 'standard' | 'readonly';
	readOnlyMode: boolean;
} {
	return { permissionMode: mode, readOnlyMode: mode === 'readonly' };
}

/**
 * The next mode in the composer's permission cycle.
 *
 * `full` -> `standard` -> `readonly` -> `full`, with `standard` skipped for an
 * agent that has no working relay for it, so the cycle can never land on a mode
 * that does nothing. Shared so the desktop toolbar pill and any other cycling
 * surface step in the same order.
 */
export function nextPermissionMode(
	current: 'full' | 'standard' | 'readonly',
	hasStandardCapability: boolean
): 'full' | 'standard' | 'readonly' {
	if (current === 'full') return hasStandardCapability ? 'standard' : 'readonly';
	if (current === 'standard') return 'readonly';
	return 'full';
}

/**
 * Field patch for cycling a tab's thinking-display mode via {@link nextThinkingMode}.
 *
 * Turning the mode OFF also drops the tab's stored thinking logs - only thinking
 * logs are storage-gated (tool logs are always recorded and hidden purely at
 * render, see the global tool-call visibility setting + TerminalOutput), so this
 * must never touch anything but `source: 'thinking'` entries.
 *
 * UI callers that should also clear logs on off: tab overlay
 * (`useAITabHandlers`), prompt composer, command palette, and the keyboard
 * shortcut's non-wizard branch. The keyboard wizard branch is separate: it
 * flips `wizardState.showWizardThinking` and must not go through this helper.
 *
 * `tabStore.cycleThinkingMode` and `maestro-cli tab thinking <id> cycle`
 * already share {@link nextThinkingMode} for the step order, but they still
 * only write `showThinking` and do not clear thinking logs. That split is
 * pre-existing; do not assume this helper closed it.
 */
export function cycleShowThinkingFields(tab: Pick<AITab, 'showThinking' | 'logs'>): {
	showThinking: ThinkingMode;
	logs: LogEntry[];
} {
	return setShowThinkingFields(tab, nextThinkingMode(tab.showThinking));
}

/**
 * Field patch for setting a tab's thinking-display mode outright.
 *
 * The set half of {@link cycleShowThinkingFields}, which now delegates here, so
 * the log-clearing rule above is written once. Reach for this from a surface
 * that NAMES a mode instead of stepping to the next one - the phone options
 * sheet lists all three, because cycling one step per tap through three states
 * is a poor control on a touchscreen.
 */
export function setShowThinkingFields(
	tab: Pick<AITab, 'logs'>,
	newMode: ThinkingMode
): {
	showThinking: ThinkingMode;
	logs: LogEntry[];
} {
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
