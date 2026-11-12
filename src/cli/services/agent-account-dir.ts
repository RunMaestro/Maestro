// Which account dir one agent runs under, as the CLI resolves it from the
// desktop's stores on disk. The desktop's own wrapper is `resolveAgentAccountDir`
// in `src/main/agents/provider-account-dirs.ts`; both feed the same layers
// (agent env, provider env, Settings -> Environment, host env) to the shared
// resolver, so a verb here and the Memory Viewer name the same account.

import os from 'os';
import { resolveAgentAccountDir } from '../../shared/agentAccountDir';
import type { SessionInfo } from '../../shared/types';
import { readAgentConfig, readSettings } from './storage';

/** The agent's provider account dir, or undefined for a provider with none (or an SSH agent that sets none). */
export function resolveCliAgentAccountDir(
	agent: Pick<SessionInfo, 'toolType' | 'customEnvVars' | 'sessionSshRemoteConfig'>
): string | undefined {
	return resolveAgentAccountDir(
		{
			toolType: agent.toolType,
			customEnvVars: agent.customEnvVars,
			sshRemote: !!agent.sessionSshRemoteConfig?.enabled,
		},
		{
			agentLevelEnvVars: readAgentConfig(agent.toolType).customEnvVars as
				| Record<string, string>
				| undefined,
			globalShellEnvVars: readSettings().shellEnvVars as Record<string, string> | undefined,
			env: process.env,
			homeDir: os.homedir(),
		}
	);
}
