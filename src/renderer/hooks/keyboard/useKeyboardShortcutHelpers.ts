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
			const sc = shortcuts[actionId];
			if (!sc) return false;
			// Same guard as isShortcut/isTabShortcut: an action with no binding must
			// never match. An empty `keys` reads as "no modifiers, no main key", and
			// the checks below would then let an unrelated keypress fire it.
			if (!sc.keys?.length) return false;
			const keys = sc.keys.map((k) => k.toLowerCase());

			// Both Ctrl and Cmd must be down. On macOS these are distinct physical
			// modifiers; on Windows/Linux users press Ctrl and the Windows/Meta key.
			const wantsCtrl = keys.includes('control') || keys.includes('ctrl');
			const wantsMeta = keys.includes('meta') || keys.includes('command');
			if (wantsCtrl && !e.ctrlKey) return false;
			if (wantsMeta && !e.metaKey) return false;
			if (!wantsCtrl || !wantsMeta) return false;

			const wantsShift = keys.includes('shift');
			if (e.shiftKey !== wantsShift) return false;
			// The tiling family never uses Alt; requiring its absence keeps these from
			// firing on unrelated Alt combos.
			if (e.altKey) return false;

			const mainKey = keys[keys.length - 1];
			const key = e.key.toLowerCase();
			if (mainKey === key) return true;
			// Arrow keys.
			if (mainKey.startsWith('arrow') && key === mainKey) return true;
			// '=' can arrive as '+' when Shift is held on some layouts; the tiling
			// rebalance binding is unshifted, but tolerate the symbol for robustness.
			if (mainKey === '=' && (key === '=' || key === '+')) return true;
			return false;
		},
		[shortcuts]
	);

	return { isShortcut, isTabShortcut, isPaneShortcut };
}
