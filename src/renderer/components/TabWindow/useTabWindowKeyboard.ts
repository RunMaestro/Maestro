/**
 * useTabWindowKeyboard - the tab shortcuts of a tab window (Tab Windows, TW-6).
 *
 * A tab window does not mount `App.tsx`, so `useMainKeyboardHandler` never runs
 * here. Instead it binds the SAME entries that handler uses for tab switching
 * (`matchTabNavigationShortcut`, read through the same `isTabShortcut` lookup,
 * so a rebound key behaves the same in both windows) and applies them to the
 * agent narrowed to this window's strip (`buildTabWindowStripSession`). The
 * navigators themselves are the `tabHelpers` ones; nothing is re-derived.
 *
 * Live: `Cmd+Shift+[` / `Cmd+Shift+]`, `Cmd+1..9` (and `Cmd+0` under
 * `useCmd0AsLastTab`), `Cmd+W`, and `moveTabToTabWindow` (`Opt+Cmd+O`), which
 * pops a tab out in the app window and docks the shown tab here (TW-11). Every other shortcut is inert in a tab
 * window, because nothing else listens: the Left Bar and Right Bar toggles and
 * tabs, agent cycling (`Cmd+[` / `Cmd+]`), and every surface those open. The
 * full list is in `docs/agent-guides/TAB-WINDOWS.md` ("Keyboard").
 *
 * Shortcut usage is not recorded for keyboard mastery here: that is a settings
 * write with a level-up modal, and it stays in the app window.
 */

import { useCallback } from 'react';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { useKeyboardShortcutHelpers } from '../../hooks/keyboard/useKeyboardShortcutHelpers';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useSettingsStore } from '../../stores/settingsStore';
import { matchTabNavigationShortcut } from '../../utils/tabNavigationShortcuts';
import type { SingleTabType } from '../../../shared/unifiedTabRef';
import type { Session } from '../../types';

export interface UseTabWindowKeyboardOptions {
	/** The agent narrowed to this window's strip, with the shown tab active. */
	stripSession: Session;
	/** The tab this window shows, or null when its record names no live tab. */
	activeTabRef: { type: SingleTabType; id: string } | null;
	/** Show a tab of this window (the chip-click path). */
	onSelectTab: (type: SingleTabType, id: string) => void;
	/** Close a tab of this window (the chip close path). */
	onCloseTab: (type: SingleTabType, id: string) => void;
	/** Dock a tab of this window (the chip menu's "Dock to Main Window" path). */
	onDockTab: (ref: { type: SingleTabType; id: string }) => void;
}

export function useTabWindowKeyboard({
	stripSession,
	activeTabRef,
	onSelectTab,
	onCloseTab,
	onDockTab,
}: UseTabWindowKeyboardOptions): void {
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);
	const { isShortcut, isTabShortcut } = useKeyboardShortcutHelpers({ shortcuts, tabShortcuts });
	const { hasOpenModal } = useLayerStack();

	const handleKeyDown = useCallback(
		(event: Event) => {
			const e = event as KeyboardEvent;
			// A modal owns the keyboard while it is open, as in the app window.
			if (e.defaultPrevented || hasOpenModal()) return;

			const navigation = matchTabNavigationShortcut(
				e,
				isTabShortcut,
				useSettingsStore.getState().useCmd0AsLastTab
			);
			if (navigation) {
				e.preventDefault();
				// The strip has no unread filter toggle, so it always shows every tab.
				const result = navigation.navigate(stripSession, false);
				if (result && result.type !== 'group') onSelectTab(result.type, result.id);
				return;
			}
			if (isTabShortcut(e, 'closeTab')) {
				e.preventDefault();
				if (activeTabRef) onCloseTab(activeTabRef.type, activeTabRef.id);
				return;
			}
			if (isShortcut(e, 'moveTabToTabWindow')) {
				e.preventDefault();
				if (activeTabRef) onDockTab(activeTabRef);
			}
		},
		[
			hasOpenModal,
			isShortcut,
			isTabShortcut,
			stripSession,
			activeTabRef,
			onSelectTab,
			onCloseTab,
			onDockTab,
		]
	);

	useEventListener('keydown', handleKeyDown);
}
