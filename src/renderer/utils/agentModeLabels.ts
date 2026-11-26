/**
 * The three words that name an agent's mode, in one place: the mode pill (`AgentModePill`, drawn by
 * `FederationBadge`) shows them in capitals, and every surface that counts agents BY mode (the Usage
 * Dashboard's location chart and its Local Agents tile) shows the same words in title case. No
 * surface spells a mode any other way ("SSH Remote", "remote agent").
 */

import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';

/** An agent's mode, as the pill names it. */
export type AgentModeKind = 'local' | 'remote' | 'hosted';

/** The mode words, in title case. */
export const AGENT_MODE_LABELS: Readonly<Record<AgentModeKind, string>> = {
	local: 'Local',
	remote: 'Remote',
	hosted: 'Hosted',
};

/** The pill's own text for a mode (`LOCAL`, `REMOTE`, `HOSTED`). */
export function agentModePillLabel(kind: AgentModeKind): string {
	return AGENT_MODE_LABELS[kind].toUpperCase();
}

/** The slice of an agent record its mode is read from. */
export interface AgentModeFields {
	liftedTo?: unknown;
	sshRemoteId?: string | null;
	sessionSshRemoteConfig?: { enabled?: boolean } | null;
	cwd?: string;
}

/**
 * The mode the pill shows for an agent: `hosted` for a lifted record while hosted agents are on
 * (`federationHostedAgents`; off, a lifted record stands as the SSH agent it was), `remote` for an
 * SSH agent (its config is set before the first spawn, `sshRemoteId` after; a `scheme://` cwd is a
 * remote path), else `local`.
 */
export function agentModeKind(agent: AgentModeFields, hostingOn: boolean): AgentModeKind {
	if (hostingOn && readLiftedTo(agent.liftedTo)) return 'hosted';
	if (agent.sessionSshRemoteConfig?.enabled || agent.sshRemoteId || agent.cwd?.includes('://')) {
		return 'remote';
	}
	return 'local';
}
