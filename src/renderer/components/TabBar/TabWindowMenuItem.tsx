/**
 * TabWindowMenuItem - the Tab Windows slot of every tab chip menu (TW-11).
 *
 * One component for the four chip menus (AI, file, terminal, browser) so the
 * label, icon, and shortcut cannot drift between them. In an app window it
 * reads "Move to Tab Window"; in a tab window the same slot reads "Dock to
 * Main Window". The chord is read from the live shortcut map, and it is the
 * same chord in both windows (`moveTabToTabWindow`: pop out in the app window,
 * dock in the tab window).
 *
 * The chip draws this only when its `onTabWindowMove` callback is set; the
 * caller decides visibility (web-desktop, hidden consult tabs) and the action
 * (`popOutTabFromUi` / the tab window's dock), so this stays presentational.
 */

import { memo } from 'react';
import { PictureInPicture2 } from 'lucide-react';
import type React from 'react';
import type { Theme } from '../../types';
import { useSettingsStore } from '../../stores/settingsStore';
import { isTabWindow } from '../../utils/runtimeContext';
import { ShortcutHint } from '../ui/ShortcutHint';

/** The slot's label in an app window. */
export const MOVE_TO_TAB_WINDOW_LABEL = 'Move to Tab Window';
/** The slot's label in a tab window. */
export const DOCK_TO_MAIN_WINDOW_LABEL = 'Dock to Main Window';

export interface TabWindowMenuItemProps {
	theme: Theme;
	onClick: (e: React.MouseEvent) => void;
}

export const TabWindowMenuItem = memo(function TabWindowMenuItem({
	theme,
	onClick,
}: TabWindowMenuItemProps) {
	const shortcut = useSettingsStore((s) => s.shortcuts.moveTabToTabWindow);
	return (
		<button
			onClick={onClick}
			className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-white/10"
			style={{ color: theme.colors.textMain }}
			data-testid="tab-window-menu-item"
		>
			<PictureInPicture2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
			{isTabWindow() ? DOCK_TO_MAIN_WINDOW_LABEL : MOVE_TO_TAB_WINDOW_LABEL}
			{shortcut && <ShortcutHint keys={shortcut.keys} theme={theme} />}
		</button>
	);
});
