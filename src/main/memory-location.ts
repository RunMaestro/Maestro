/**
 * Which memory store one Memory Viewer request is about.
 *
 * The store lives under the account dir the agent actually runs as
 * (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), not under `~/.claude` by assumption: an
 * agent on a second account writes its memories into that account, and a
 * viewer reading the default one shows a store the agent never loads.
 *
 * An agent whose project knowledge is managed by provider translation reads
 * that managed directory instead, whatever its provider.
 */

import os from 'os';
import path from 'path';
import { MEMORY_INDEX_FILE, type MemoryTarget } from '../shared/agentMemory';
import { getProviderProfileConfig } from '../shared/providerProfiles';
import {
	discoverClaudeMemoryPath,
	resolveMemoryRepositoryRoot,
} from '../shared/maestro-lib/translation/memory';
import { assertTranslationTarget } from '../shared/maestro-lib/translation/resource-projections';
import { resolveAgentAccountDir } from './agents/provider-account-dirs';
import { memoryLayoutFor, type MemoryLayout } from './memory-manager';
import { isInitialized } from './stores/instances';
import { getSessionsStore } from './stores/getters';
import { execGitReadOnly } from './utils/remote-git';

export async function resolveMemoryLayout(target: MemoryTarget): Promise<MemoryLayout> {
	const { projectPath, toolType, agentId } = target;

	const sessions = isInitialized()
		? (getSessionsStore().get('sessions', []) as Array<Record<string, unknown>>)
		: [];
	const session = agentId ? sessions.find((s) => s?.id === agentId) : undefined;
	if (session) {
		const sshConfig = session.sessionSshRemoteConfig as { enabled?: boolean } | undefined;
		if (sshConfig?.enabled || session.sshRemoteId) {
			// The store is on the remote host; reading the same path here would show
			// this machine's memories (or none) as if they were the agent's.
			throw new Error('This agent runs on an SSH remote, and its memory lives on that host');
		}
		const agentRoot = (session.projectRoot || session.cwd) as string | undefined;
		if (agentRoot && path.resolve(agentRoot) !== path.resolve(projectPath)) {
			throw new Error('Memory scope does not match the selected local agent');
		}
		const managed = session.providerTranslationKnowledgeDirectory as string | undefined;
		if (managed) {
			await assertTranslationTarget(path.join(managed, 'memory', MEMORY_INDEX_FILE), projectPath);
			return {
				...memoryLayoutFor('claude-code', { projectPath, accountDir: managed }),
				directoryPath: path.join(managed, 'memory'),
			};
		}
	}

	const config = getProviderProfileConfig(toolType);
	if (!config) throw new Error(`Memory viewer is not supported for agent "${toolType}"`);

	const accountDir =
		(agentId && resolveAgentAccountDir(agentId, { sessions })) ||
		path.join(os.homedir(), config.defaultSubdir);
	const layout = memoryLayoutFor(toolType, { projectPath, accountDir });
	if (toolType !== 'claude-code') return layout;

	// Claude honors `autoMemoryDirectory`, and keys a worktree's memory by its
	// main checkout rather than by the worktree path.
	const memoryProjectRoot = await resolveMemoryRepositoryRoot(projectPath, async (cwd) => {
		const result = await execGitReadOnly(['rev-parse', '--git-common-dir'], cwd);
		return result.exitCode === 0 ? result.stdout : undefined;
	});
	return {
		...layout,
		directoryPath: await discoverClaudeMemoryPath(projectPath, accountDir, memoryProjectRoot),
	};
}
