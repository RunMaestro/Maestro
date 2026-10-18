import { useMemo } from 'react';
import type { Session } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { filterLiveAgents } from '../../../shared/agentVisibility';

/**
 * Every LIVE agent: the session store minus agents whose Encore Feature is
 * switched off (a dormant Pianola). Use it for any list a user picks from or
 * any work that walks agents (dashboards, pickers, polling). Returns the store
 * array itself when nothing is dormant, so memoized consumers stay stable.
 * See `src/shared/agentVisibility.ts`.
 */
export function useLiveSessions(): Session[] {
	const sessions = useSessionStore((s) => s.sessions);
	const pianola = useSettingsStore((s) => s.encoreFeatures.pianola);
	return useMemo(() => filterLiveAgents(sessions, { pianola }), [sessions, pianola]);
}

/** Non-React read of {@link useLiveSessions}, for services and event handlers. */
export function getLiveSessionsSnapshot(): Session[] {
	return filterLiveAgents(
		useSessionStore.getState().sessions,
		useSettingsStore.getState().encoreFeatures
	);
}
