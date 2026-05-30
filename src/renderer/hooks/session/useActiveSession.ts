/**
 * useActiveSession.ts
 *
 * Simple hook for selecting the active session from the session store.
 * Extracted for reuse across components that need the active session object.
 */

import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import type { Session } from '../../types';

/**
 * Returns the currently active session, or null if none is selected.
 *
 * @example
 * const activeSession = useActiveSession();
 */
export function useActiveSession(): Session | null {
	return useSessionStore(selectActiveSession);
}
