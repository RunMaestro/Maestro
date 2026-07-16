import type { Theme, UnifiedTab } from '../../types';

/** The kind of content a tab holds - matches the UnifiedTab discriminant. */
export type TabKind = UnifiedTab['type'];

/**
 * Signature color for each tab kind. AI/file/terminal track the active theme
 * via semantic tokens so the palette adapts to light/dark/vibe themes. Browser
 * uses a fixed sky blue - there's no "info/blue" semantic token in the theme,
 * and the obvious fallback (`ansiBlue`) lands on desaturated purples/grays in
 * several vibe themes (pedurple, winamp, inquest), making the icon read as
 * gray next to the other kinds. A stable browser-blue keeps the kind visually
 * distinct from accent/warning/success on every theme.
 * - ai      → accent  (brand hue)
 * - browser → sky blue (fixed; universal "browser" color)
 * - file    → warning (yellow/orange)
 * - terminal→ success (green) - terminal tabs additionally override with
 *             their run-state, so this is the idle base.
 */
const BROWSER_TAB_COLOR = '#3b82f6';

export function getTabKindColor(kind: TabKind, theme: Theme): string {
	switch (kind) {
		case 'ai':
			return theme.colors.accent;
		case 'browser':
			return BROWSER_TAB_COLOR;
		case 'file':
			return theme.colors.warning;
		case 'terminal':
			return theme.colors.success;
		default:
			return theme.colors.textDim;
	}
}

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
	inputMode: 'ai' | 'terminal' | undefined,
	activeGroupId?: string | null
): boolean {
	// A tiled group is the active tab when it takes over the panel; it outranks the
	// standalone selections (which navigation clears when a group activates).
	if (tab.type === 'group') {
		return tab.id === activeGroupId;
	}
	// While a group is active, no standalone chip should read as active.
	if (activeGroupId) return false;
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
 *
 * When useCmd0AsLastTab is true (Maestro default): returns 1-9 for the first 9 tabs,
 * 0 for the last tab (Cmd+0), null for others.
 *
 * When useCmd0AsLastTab is false (browser-style): returns 1-8 for the first 8 tabs,
 * 9 for the last tab (Cmd+9), null for others.
 *
 * Callers pass the tab's index within the currently displayed list (filtered or not) so
 * hints stay aligned with Cmd+N behaviour - the jump shortcuts index into the same
 * filtered list when the unread filter is active.
 */
export function getShortcutHint(
	displayedIndex: number,
	isLastTab: boolean,
	useCmd0AsLastTab = true
): number | null {
	if (useCmd0AsLastTab) {
		if (isLastTab) return 0;
		if (displayedIndex < 9) return displayedIndex + 1;
		return null;
	}
	if (isLastTab) return 9;
	if (displayedIndex < 8) return displayedIndex + 1;
	return null;
}
