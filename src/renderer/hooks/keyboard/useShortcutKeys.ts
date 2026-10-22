/**
 * useShortcutKeys - the chord and sequence to DRAW for an action, in whichever
 * keyboard mode is live.
 *
 * The one-line answer for a surface that advertises a shortcut next to the
 * control that fires it. Hand it an action id and it reads the live mode's
 * effective maps through `useActiveShortcuts()`, so a rebind, a mode switch, or
 * a mode override that displaces the action all reach the display with no work
 * at the call site:
 *
 *   const { keys, sequence } = useShortcutKeys('goToHistory');
 *   // default mode: keys = ['Meta', 'Shift', 'h']
 *   // Vim mode:     keys = ['Ctrl', 'Alt', 'Shift', 'h']
 *
 * Use the non-hook `resolveShortcutKeys(actionId, maps)` instead when a surface
 * draws MANY chords (the command palette's rows, the help modal's list) or
 * cannot call a hook at all. `useActiveShortcuts()` subscribes to six slices of
 * the settings store, and one subscription set shared by a list beats one per
 * row.
 */

import { useMemo } from 'react';
import { useActiveShortcuts } from '../settings/useActiveShortcuts';
import { resolveShortcutKeys, type ResolvedShortcut } from '../../utils/shortcutResolve';

/**
 * The live mode's binding for `actionId`.
 *
 * `actionId` is optional, and an absent or unknown one resolves to the shared
 * unbound answer (`keys: []`, no `sequence`). That is what lets a component
 * with an optional `actionId` prop call this unconditionally instead of
 * branching around a hook.
 */
export function useShortcutKeys(actionId: string | undefined): ResolvedShortcut {
	const { shortcuts, tabShortcuts } = useActiveShortcuts();
	return useMemo(
		() => resolveShortcutKeys(actionId, { shortcuts, tabShortcuts }),
		[actionId, shortcuts, tabShortcuts]
	);
}
