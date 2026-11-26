/**
 * History sharing: whether an agent writes its History entries to
 * `.maestro/history/` in its project folder, so the other Maestros working on
 * that project see them. Read by the renderer (History panel, Edit Agent) and
 * by main (the local mirror, Director's Notes), so both apply one rule.
 */

import type { AgentSshRemoteConfig } from './types';

/**
 * Whether an agent shares its History in its project's `.maestro/history/`
 * folder, so the other Maestros working on that project see its entries.
 *
 * One setting for the user, stored in the two fields its two transports read:
 * `syncHistory` (an SSH agent's entries are written to the folder on the
 * remote) and `shareHistoryToProjectDir` (a local agent's, and a hosted
 * agent's on its host, are written to the folder where it runs). The Edit Agent
 * toggle reads and writes both, so it means the same in every mode.
 */
export function sharesHistoryInProject(
	config: Pick<AgentSshRemoteConfig, 'syncHistory' | 'shareHistoryToProjectDir'> | undefined
): boolean {
	return config?.syncHistory === true || config?.shareHistoryToProjectDir === true;
}

/** `config` with History sharing turned on or off (see {@link sharesHistoryInProject}). */
export function withHistorySharedInProject(
	config: AgentSshRemoteConfig | undefined,
	share: boolean
): AgentSshRemoteConfig {
	return {
		enabled: config?.enabled ?? false,
		remoteId: config?.remoteId ?? null,
		workingDirOverride: config?.workingDirOverride,
		syncHistory: share,
		shareHistoryToProjectDir: share,
	};
}
