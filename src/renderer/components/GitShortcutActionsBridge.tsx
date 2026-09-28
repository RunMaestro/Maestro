/**
 * GitShortcutActionsBridge - publishes the active agent's git actions for the
 * global keyboard handler.
 *
 * Renders nothing. It exists so the `GitStatusContext` subscription that
 * `useGitAgentActions` needs lives in a leaf that costs nothing to re-render,
 * instead of in `App`, where every git poll would cascade through the whole
 * tree. See `services/gitShortcutActions.ts`.
 */

import { useEffect } from 'react';
import { useSessionStore, selectActiveSession } from '../stores/sessionStore';
import { useGitAgentActions } from '../hooks/git/useGitAgentActions';
import { publishGitShortcutActions } from '../services/gitShortcutActions';

export function GitShortcutActionsBridge() {
	const activeSession = useSessionStore(selectActiveSession);
	const actions = useGitAgentActions(activeSession);

	// Published during render, not in an effect: a chord pressed in the same
	// frame the active agent changed must fire against the NEW agent's repo.
	// Same reason App assigns `keyboardHandlerRef.current` during render.
	publishGitShortcutActions(actions);

	useEffect(() => () => publishGitShortcutActions(null), []);

	return null;
}

export default GitShortcutActionsBridge;
