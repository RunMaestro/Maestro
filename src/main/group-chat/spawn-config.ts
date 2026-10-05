/**
 * @file spawn-config.ts
 * @description The one mapping from the library's spawn description (`GroupChatSpawn`) to
 * the config `spawnGroupChatAgent` takes.
 *
 * Two desktop runners start a process from a `GroupChatSpawn` over a `ProcessManager`: the group
 * chat launcher (`desktop-engine.ts`) and the cross-agent consult runner
 * (`cross-agent/consult-runner.ts`). They share this so the two cannot drift on a field, and it is
 * its own module (not an export of `spawnGroupChatAgent.ts`) so a test that replaces the spawn
 * helper still gets the real mapping.
 */

import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import type { GroupChatSpawn } from '../../shared/maestro-lib/groupchat/types';
import type { IProcessManager } from './group-chat-moderator';
import type { SpawnGroupChatAgentConfig } from './spawnGroupChatAgent';

export function toSpawnGroupChatAgentConfig(
	spawn: GroupChatSpawn,
	deps: { processManager: IProcessManager; sshStore: SshRemoteSettingsStore | null }
): SpawnGroupChatAgentConfig {
	return {
		sessionId: spawn.processId,
		agentId: spawn.providerId,
		agent: spawn.agent,
		command: spawn.command,
		args: spawn.args,
		cwd: spawn.cwd,
		prompt: spawn.prompt,
		customEnvVars: spawn.customEnvVars,
		agentConfigValues: spawn.agentConfigValues,
		sshRemoteConfig: spawn.sshRemoteConfig,
		sshStore: deps.sshStore,
		tokenMode: spawn.tokenMode,
		maestroPPath: spawn.maestroPPath,
		processManager: deps.processManager,
		readOnlyMode: spawn.readOnlyMode,
		debugLabel: spawn.debugLabel,
		maxWaitSeconds: spawn.maxWaitSeconds,
	};
}
