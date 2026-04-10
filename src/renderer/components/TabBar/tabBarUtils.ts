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
 * Returns null when unread filter is active (positions aren't stable).
 */
export function getShortcutHint(
	originalIndex: number,
	isLastTab: boolean,
	showUnreadOnly: boolean
): number | null {
	if (showUnreadOnly) return null;
	if (isLastTab) return 0;
	if (originalIndex < 9) return originalIndex + 1;
	return null;
}
