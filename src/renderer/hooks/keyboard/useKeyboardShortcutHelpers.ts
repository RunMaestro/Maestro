import { useCallback } from 'react';
import type { Shortcut } from '../../types';
import { matchesShortcut } from './shortcutMatcher';

/**
 * Dependencies for useKeyboardShortcutHelpers hook
 */
export interface UseKeyboardShortcutHelpersDeps {
	/** User-configurable global shortcuts (from useSettings) */
	shortcuts: Record<string, Shortcut>;
	/** User-configurable tab shortcuts (from useSettings) */
	tabShortcuts: Record<string, Shortcut>;
}

/**
 * Return type for useKeyboardShortcutHelpers hook
 */
export interface UseKeyboardShortcutHelpersReturn {
	/** Check if a keyboard event matches a shortcut by action ID */
	isShortcut: (e: KeyboardEvent, actionId: string) => boolean;
	/** Check if a keyboard event matches a tab shortcut (AI mode only) */
	isTabShortcut: (e: KeyboardEvent, actionId: string) => boolean;
	/**
	 * Check if a keyboard event matches a Ctrl+Cmd pane-tiling shortcut. Kept
	 * separate from isShortcut because that matcher collapses Ctrl and Cmd into a
	 * single "meta" flag (so it can't tell Cmd+W from Ctrl+Cmd+W); the tiling
	 * family needs BOTH modifiers held to fire, so it gets its own explicit matcher.
	 */
	isPaneShortcut: (e: KeyboardEvent, actionId: string) => boolean;
}

/**
 * Keyboard shortcut matching utilities.
 *
 * Provides pure utility functions for matching keyboard events against
 * configured shortcuts. Handles modifier keys (Meta/Ctrl, Shift, Alt),
 * special key mappings, and macOS-specific Alt key character production.
 *
 * @param deps - Hook dependencies containing the shortcuts configuration
 * @returns Functions for matching keyboard events to shortcuts
 */
export function useKeyboardShortcutHelpers(
	deps: UseKeyboardShortcutHelpersDeps
): UseKeyboardShortcutHelpersReturn {
	const { shortcuts, tabShortcuts } = deps;

	/**
	 * Check if a keyboard event matches a shortcut by action ID.
	 *
	 * Handles:
	 * - Modifier keys (Meta/Ctrl/Command, Shift, Alt)
	 * - Arrow keys, Backspace, special characters
	 * - Shift+bracket producing { and } characters
	 * - Shift+number producing symbol characters (US layout)
	 * - Alt-rewritten characters on macOS/AltGr layouts (uses e.code fallback)
	 */
	const isShortcut = useCallback(
		(e: KeyboardEvent, actionId: string): boolean => {
			const shortcut = shortcuts[actionId];
			return shortcut ? matchesShortcut(e, shortcut.keys) : false;
		},
		[shortcuts]
	);

	/**
	 * Check if a keyboard event matches a tab shortcut (AI mode only).
	 *
	 * Uses user-configurable tabShortcuts, falling back to global shortcuts
	 * if a tab-specific shortcut isn't defined.
	 */
	const isTabShortcut = useCallback(
		(e: KeyboardEvent, actionId: string): boolean => {
			const shortcut = tabShortcuts[actionId] || shortcuts[actionId];
			return shortcut ? matchesShortcut(e, shortcut.keys) : false;
		},
		[tabShortcuts, shortcuts]
	);

	/**
	 * Match a Ctrl+Cmd pane-tiling shortcut. Unlike isShortcut, this requires
	 * BOTH the Control key and the Meta/Cmd key to be physically held (and honors
	 * Shift / no-Shift and Alt-absence), so Ctrl+Cmd+W never fires on a plain
	 * Cmd+W. The shortcut's config carries a literal 'Control' token; the last
	 * entry is the main key (arrow / letter / '='), which we compare against
	 * e.key, tolerating Shift-rewritten symbols where relevant.
	 */
	const isPaneShortcut = useCallback(
		(e: KeyboardEvent, actionId: string): boolean => {
			const shortcut = shortcuts[actionId];
			return shortcut
				? matchesShortcut(e, shortcut.keys, { requirePhysicalMetaAndCtrl: true })
				: false;
		},
		[shortcuts]
	);

	return { isShortcut, isTabShortcut, isPaneShortcut };
}
