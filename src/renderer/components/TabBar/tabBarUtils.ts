import type { UnifiedTab } from '../../types';

/**
 * Determine if a unified tab is currently active, based on tab type and input mode.
 * - AI tabs: active when matching activeTabId AND no file/terminal tab is active
 * - File tabs: active when matching activeFileTabId
 * - Terminal tabs: active when matching activeTerminalTabId AND in terminal mode
 */
export function isUnifiedTabActive(
	tab: UnifiedTab,
	activeTabId: string,
	activeFileTabId: string | null | undefined,
	activeBrowserTabId: string | null | undefined,
	activeTerminalTabId: string | null | undefined,
	inputMode: 'ai' | 'terminal' | undefined
): boolean {
	if (tab.type === 'ai') {
		return (
			tab.id === activeTabId && !activeFileTabId && !activeBrowserTabId && inputMode !== 'terminal'
		);
	}
	if (tab.type === 'file') {
		return tab.id === activeFileTabId;
	}
	if (tab.type === 'browser') {
		return tab.id === activeBrowserTabId && inputMode !== 'terminal';
	}
	return tab.id === activeTerminalTabId && inputMode === 'terminal';
}

/**
 * Compute shortcut hint for a tab at a given position.
 * Returns 1-9 for first 9 tabs, 0 for last tab (Cmd+0), null for others.
 *
 * Callers pass the tab's index within the currently displayed list (filtered or not) so
 * hints stay aligned with Cmd+N behaviour — the jump shortcuts index into the same
 * filtered list when the unread filter is active.
 */
export function getShortcutHint(displayedIndex: number, isLastTab: boolean): number | null {
	if (isLastTab) return 0;
	if (displayedIndex < 9) return displayedIndex + 1;
	return null;
}
