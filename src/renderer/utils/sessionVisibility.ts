/**
 * sessionVisibility - which agents the Left Bar may surface at all.
 *
 * Some agents exist in the session store but are not part of the user's visible
 * agent list. Pianola is the only one today: it is a real `isPianola` Session
 * that PERSISTS after its Encore flag is switched off (so turning the feature
 * back on restores the same agent and its chat), and SessionList simply stops
 * rendering its pinned row. Every other surface that walks `sessions` -
 * Cmd+[ / Cmd+] cycling, arrow-key nav, Opt+Cmd+NUMBER jumps - would otherwise
 * still land on the hidden agent, showing "Pianola" for a disabled feature.
 *
 * One predicate, applied wherever a session list becomes navigable, so the
 * rendered list and the keyboard order can never disagree. Pairs with
 * {@link scopeSessionsToOwningWindow} in `windowTargets.ts`, which answers the
 * separate question of which agents THIS window owns.
 */

/** Minimal shape needed to decide sidebar visibility. */
export interface VisibilityScopableSession {
	isPianola?: boolean;
}

export interface SidebarVisibilityOptions {
	/** The `pianola` Encore flag. When false the pinned manager agent is hidden. */
	pianolaEnabled?: boolean;
}

/** True when this agent may appear in the Left Bar and its keyboard orders. */
export function isSessionVisibleInSidebar(
	session: VisibilityScopableSession,
	{ pianolaEnabled }: SidebarVisibilityOptions
): boolean {
	if (session.isPianola && !pianolaEnabled) return false;
	return true;
}

/**
 * Drop agents that are hidden from the Left Bar. Returns the original array
 * when nothing is filtered, so consumers that memoize on identity stay stable.
 */
export function filterSessionsVisibleInSidebar<T extends VisibilityScopableSession>(
	sessions: T[],
	options: SidebarVisibilityOptions
): T[] {
	if (options.pianolaEnabled) return sessions;
	if (!sessions.some((s) => s.isPianola)) return sessions;
	return sessions.filter((s) => isSessionVisibleInSidebar(s, options));
}
