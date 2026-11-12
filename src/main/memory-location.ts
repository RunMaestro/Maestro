/**
 * Which memory store one Memory Viewer request is about.
 *
 * The store lives under the account dir the agent actually runs as
 * (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), not under `~/.claude` by assumption: an
 * agent on a second account writes its memories into that account, and a
 * viewer reading the default one shows a store the agent never loads.
 */

import os from 'os';
import path from 'path';
import type { MemoryTarget } from '../shared/agentMemory';
import { getProviderProfileConfig } from '../shared/providerProfiles';
import { resolveAgentAccountDir } from './agents/provider-account-dirs';
import { memoryLayoutFor, type MemoryLayout } from './memory-manager';
import { isInitialized } from './stores/instances';
import { getSessionsStore } from './stores/getters';

export function resolveMemoryLayout(target: MemoryTarget): MemoryLayout {
	const { projectPath, toolType, agentId } = target;
	const config = getProviderProfileConfig(toolType);
	if (!config) throw new Error(`Memory viewer is not supported for agent "${toolType}"`);

	const sessions = isInitialized()
		? (getSessionsStore().get('sessions', []) as Array<Record<string, unknown>>)
		: [];
	const session = agentId ? sessions.find((s) => s?.id === agentId) : undefined;
	const sshConfig = session?.sessionSshRemoteConfig as { enabled?: boolean } | undefined;
	if (sshConfig?.enabled) {
		// The store is on the remote host; reading the same path here would show
		// this machine's memories (or none) as if they were the agent's.
		throw new Error('This agent runs on an SSH remote, and its memory lives on that host');
	}

	const accountDir =
		(agentId && resolveAgentAccountDir(agentId, { sessions })) ||
		path.join(os.homedir(), config.defaultSubdir);
	return memoryLayoutFor(toolType, { projectPath, accountDir });
}
