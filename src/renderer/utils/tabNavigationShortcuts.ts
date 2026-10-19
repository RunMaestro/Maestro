/**
 * The tab-switching shortcut entries, shared by every surface that has a tab
 * strip: the main window's keyboard handler and a tab window (Tab Windows,
 * TW-6).
 *
 * One table decides which binding means what (`nextTab`, `prevTab`,
 * `goToTab1..9`, `goToLastTab`, and the `useCmd0AsLastTab` remap), so a tab
 * window cannot drift from the main window on what `Cmd+Shift+]` or `Cmd+9`
 * does. Each surface applies the match to its own session: the main window to
 * the agent, a tab window to the agent narrowed to its strip
 * (`buildTabWindowStripSession`).
 */

import type { Session } from '../types';
import {
	navigateToLastUnifiedTab,
	navigateToNextUnifiedTab,
	navigateToPrevUnifiedTab,
	navigateToUnifiedTabByIndex,
	type NavigateToUnifiedTabResult,
} from './tabHelpers';

/** The unified tab navigators a match runs. Injectable so a caller can supply its own. */
export interface UnifiedTabNavigators {
	navigateToNextUnifiedTab: (
		session: Session,
		showUnreadOnly?: boolean
	) => NavigateToUnifiedTabResult | null;
	navigateToPrevUnifiedTab: (
		session: Session,
		showUnreadOnly?: boolean
	) => NavigateToUnifiedTabResult | null;
	navigateToUnifiedTabByIndex: (
		session: Session,
		index: number,
		showUnreadOnly?: boolean
	) => NavigateToUnifiedTabResult | null;
	navigateToLastUnifiedTab: (
		session: Session,
		showUnreadOnly?: boolean
	) => NavigateToUnifiedTabResult | null;
}

/**
 * The navigators in `tabHelpers`. Each one reads its import when it is called,
 * not when this module loads: the keyboard hooks import this module through
 * the hooks barrel, so loading it must not touch `tabHelpers` (a test that
 * replaces `tabHelpers` with a mock of a few functions still loads the barrel).
 */
export const UNIFIED_TAB_NAVIGATORS: UnifiedTabNavigators = {
	navigateToNextUnifiedTab: (session, showUnreadOnly) =>
		navigateToNextUnifiedTab(session, showUnreadOnly),
	navigateToPrevUnifiedTab: (session, showUnreadOnly) =>
		navigateToPrevUnifiedTab(session, showUnreadOnly),
	navigateToUnifiedTabByIndex: (session, index, showUnreadOnly) =>
		navigateToUnifiedTabByIndex(session, index, showUnreadOnly),
	navigateToLastUnifiedTab: (session, showUnreadOnly) =>
		navigateToLastUnifiedTab(session, showUnreadOnly),
};

/** A keystroke that switches tabs. */
export interface TabNavigationShortcut {
	/** The id to record for keyboard mastery. */
	shortcutId: string;
	/** The tab this keystroke lands on in `session`, or null when there is none. */
	navigate: (
		session: Session,
		showUnreadOnly: boolean,
		navigators?: UnifiedTabNavigators
	) => NavigateToUnifiedTabResult | null;
}

/**
 * Match a keystroke against the tab-switching bindings.
 *
 * `isTabShortcut` is the binding lookup from `useKeyboardShortcutHelpers`.
 * With `useCmd0AsLastTab` on, `Cmd+1..9` jump to tabs 1-9 and `Cmd+0` to the
 * last; with it off, `Cmd+1..8` jump to tabs 1-8 and `Cmd+9` to the last (the
 * browser convention). Returns null for any other keystroke.
 */
export function matchTabNavigationShortcut(
	e: KeyboardEvent,
	isTabShortcut: (e: KeyboardEvent, actionId: string) => boolean,
	useCmd0AsLastTab: boolean
): TabNavigationShortcut | null {
	if (isTabShortcut(e, 'nextTab')) {
		return {
			shortcutId: 'nextTab',
			navigate: (session, showUnreadOnly, navigators = UNIFIED_TAB_NAVIGATORS) =>
				navigators.navigateToNextUnifiedTab(session, showUnreadOnly),
		};
	}
	if (isTabShortcut(e, 'prevTab')) {
		return {
			shortcutId: 'prevTab',
			navigate: (session, showUnreadOnly, navigators = UNIFIED_TAB_NAVIGATORS) =>
				navigators.navigateToPrevUnifiedTab(session, showUnreadOnly),
		};
	}
	const maxNumberedTab = useCmd0AsLastTab ? 9 : 8;
	for (let i = 1; i <= maxNumberedTab; i++) {
		if (isTabShortcut(e, `goToTab${i}`)) {
			return {
				shortcutId: `goToTab${i}`,
				navigate: (session, showUnreadOnly, navigators = UNIFIED_TAB_NAVIGATORS) =>
					navigators.navigateToUnifiedTabByIndex(session, i - 1, showUnreadOnly),
			};
		}
	}
	if (isTabShortcut(e, useCmd0AsLastTab ? 'goToLastTab' : 'goToTab9')) {
		return {
			shortcutId: 'goToLastTab',
			navigate: (session, showUnreadOnly, navigators = UNIFIED_TAB_NAVIGATORS) =>
				navigators.navigateToLastUnifiedTab(session, showUnreadOnly),
		};
	}
	return null;
}
