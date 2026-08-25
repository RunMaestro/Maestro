import { useCallback } from 'react';
import type { Shortcut } from '../../types';
import { eventMatchesShortcutKeys } from '../../utils/shortcutMatch';

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
	 * This is the binding LOOKUP; `eventMatchesShortcutKeys` owns the matching
	 * rules (modifier equality, Shift- and Alt-rewritten characters), shared
	 * with `isTabShortcut` below and the AI composer's forced-parallel chord so
	 * a rebound key cannot behave differently depending on which surface reads
	 * it. An action with no binding never matches.
	 */
	const isShortcut = useCallback(
		(e: KeyboardEvent, actionId: string): boolean =>
			eventMatchesShortcutKeys(e, shortcuts[actionId]?.keys),
		[shortcuts]
	);

	/**
	 * Check if a keyboard event matches a tab shortcut (AI mode only).
	 *
	 * Uses user-configurable tabShortcuts, falling back to global shortcuts
	 * if a tab-specific shortcut isn't defined.
	 */
	const isTabShortcut = useCallback(
		(e: KeyboardEvent, actionId: string): boolean =>
			eventMatchesShortcutKeys(e, (tabShortcuts[actionId] || shortcuts[actionId])?.keys),
		[tabShortcuts, shortcuts]
	);

	return { isShortcut, isTabShortcut };
}
