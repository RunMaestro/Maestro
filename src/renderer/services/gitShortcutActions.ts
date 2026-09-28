/**
 * gitShortcutActions - the active agent's git actions, published for the
 * global keyboard handler.
 *
 * The keyboard handler has to fire the same actions the branch-pill menu and
 * the Cmd+K palette fire, and those come from `useGitAgentActions`. Calling
 * that hook in `App` would subscribe the whole app tree to `GitStatusContext`,
 * which hands back a new value on every git poll - a re-render of everything,
 * several times a minute, to serve four chords.
 *
 * So `GitShortcutActionsBridge` (a component that renders nothing) holds the
 * subscription and publishes the resulting action set here. The keyboard
 * handler reads it at event time. One source of truth for what "Git Pull"
 * does, no re-render cost.
 */

import type { GitAgentActions } from '../hooks/git/useGitAgentActions';

let currentActions: GitAgentActions | null = null;

/** Called by the bridge on every render, and with `null` when it unmounts. */
export function publishGitShortcutActions(actions: GitAgentActions | null): void {
	currentActions = actions;
}

/**
 * The active agent's git actions, or null before the bridge has mounted (and
 * in tests that render the keyboard handler on its own). Callers must still
 * check `isGitRepo` - a non-git agent publishes an action set whose every
 * entry is a no-op.
 */
export function getGitShortcutActions(): GitAgentActions | null {
	return currentActions;
}
