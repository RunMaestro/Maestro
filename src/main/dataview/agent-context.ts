/**
 * Where a Dataview query runs for an agent (D2, DV-4, DV-6): the agent's working directory, which roots a
 * note outside any vault, and the SSH remote its files live on. Resolved in main from the stored agent
 * record, so the renderer and the CLI only ever name the agent.
 */

import { getLiveSessions, getSettingsStore } from '../stores/getters';
import { createSshRemoteStoreAdapter, resolveSshLaunchTarget } from '../utils/ssh-remote-resolver';
import { sshUnresolvedRemoteMessage } from '../../shared/maestro-lib/launch/ssh-spawn-wrapper';
import type { AgentSshRemoteConfig } from '../../shared/types';
import type { DataviewAgentContext } from './dataview-service';

/**
 * The context of a live agent. Throws when no live agent has the id, and when the agent has SSH on but its
 * remote is missing or disabled: the same path on this machine is a different folder, so a query never
 * falls back to the local disk.
 */
export function resolveDataviewAgentContext(agentId: string): DataviewAgentContext {
	const session = getLiveSessions().find((candidate) => candidate.id === agentId);
	if (!session) throw new Error(`Dataview: no agent with id "${agentId}"`);
	const sshConfig = session.sessionSshRemoteConfig as AgentSshRemoteConfig | undefined;
	const target = resolveSshLaunchTarget(createSshRemoteStoreAdapter(getSettingsStore()), sshConfig);
	if (target.kind === 'local') return { agentCwd: session.cwd, sshRemoteId: null };
	if (target.kind === 'unresolved' || !sshConfig) {
		throw new Error(sshUnresolvedRemoteMessage(sshConfig ?? { enabled: true, remoteId: null }));
	}
	// The remote cwd follows the agent's override, as the context groomer does (guide, D2).
	return {
		agentCwd: sshConfig.workingDirOverride || session.cwd,
		sshRemoteId: target.remote.id,
	};
}
