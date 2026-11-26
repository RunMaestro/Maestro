/**
 * Provider Account Directories
 *
 * Answers one question for any provider that keeps its account in a config
 * directory: which account dirs exist on this machine, deduped to the distinct
 * transcript pools behind them.
 *
 * The account-selecting env var per provider (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `COPILOT_HOME`, `GROK_HOME`) lives in `PROVIDER_PROFILE_CONFIGS`, so this
 * module is provider-agnostic: a provider gains multi-account attribution by
 * gaining an entry there, not by gaining a discovery function here.
 *
 * Five sources, in order:
 *   1. Every local live agent's account, resolved through the canonical
 *      session/provider/global/process environment layers.
 *   2. The provider-default selection through those same layers, even when no
 *      local agent currently inherits it.
 *   3. Maestro's own `process.env`, for a user who exports the var in a shell
 *      profile.
 *   4. `~/<defaultSubdir>`, the implicit default account.
 *   5. A sibling scan of `$HOME` for `<defaultSubdir>` and `<defaultSubdir>-*`.
 *      The only source that still finds an account whose agents have all been
 *      deleted.
 *
 * The rule itself is `findProviderAccountDirs()` in `provider-account-dirs-core.ts`
 * (no stores, no Electron); this module fills in the sources from the stores.
 *
 * Sources 1 and 5 are each sorted before being appended, so the output order
 * (and therefore which dir wins a dedupe) is stable across runs.
 */

import os from 'os';

import { isInitialized } from '../stores/instances';
import { getAgentConfigsStore, getSessionsStore, getSettingsStore } from '../stores/getters';
import { filterLiveAgents } from '../../shared/agentVisibility';
import { resolveAgentAccountDir as resolveAccountDirForAgent } from '../../shared/agentAccountDir';
import {
	findProviderAccountDirs,
	type ProviderAccountDirsOptions,
} from './provider-account-dirs-core';

export {
	findProviderAccountDirs,
	type ProviderAccountDirsOptions,
} from './provider-account-dirs-core';

/**
 * Live stored agents (a dormant Pianola is left out), or an empty list before
 * `initializeStores()` has run.
 */
function readStoredSessions(): Array<Record<string, unknown>> {
	if (!isInitialized()) return [];
	return filterLiveAgents(
		getSessionsStore().get('sessions', []) as Array<Record<string, unknown>>,
		getSettingsStore().get('encoreFeatures')
	);
}

/** Provider-level `customEnvVars`, or none before `initializeStores()` has run. */
function readAgentLevelEnvVars(toolType: string): Record<string, string> {
	if (!isInitialized()) return {};
	const configs = getAgentConfigsStore().get('configs', {});
	const envVars = configs[toolType]?.customEnvVars;
	return envVars && typeof envVars === 'object' ? (envVars as Record<string, string>) : {};
}

/** Settings -> Environment, or none before `initializeStores()` has run. */
function readGlobalShellEnvVars(): Record<string, string> {
	if (!isInitialized()) return {};
	const vars = getSettingsStore().get('shellEnvVars', {});
	return vars && typeof vars === 'object' ? (vars as Record<string, string>) : {};
}

/**
 * The account dirs to read for a provider ({@link findProviderAccountDirs}),
 * with any source the caller does not give read from this machine's stores.
 */
export async function getProviderAccountDirs(
	toolType: string,
	options: ProviderAccountDirsOptions = {}
): Promise<string[]> {
	return findProviderAccountDirs(toolType, {
		...options,
		sessions: options.sessions ?? readStoredSessions(),
		agentLevelEnvVars: options.agentLevelEnvVars ?? readAgentLevelEnvVars(toolType),
		globalShellEnvVars: options.globalShellEnvVars ?? readGlobalShellEnvVars(),
	});
}

export type AgentAccountDirOptions = ProviderAccountDirsOptions;

/**
 * The account dir one STORED agent runs under, read from the stores. The rule
 * itself lives in `shared/agentAccountDir.ts`, shared with the CLI.
 */
export function resolveAgentAccountDir(
	maestroSessionId: string,
	options: AgentAccountDirOptions = {}
): string | undefined {
	const sessions = options.sessions ?? readStoredSessions();
	const session = sessions.find((s) => s?.id === maestroSessionId);
	if (!session || typeof session.toolType !== 'string') return undefined;
	const sshConfig = session.sessionSshRemoteConfig as { enabled?: boolean } | undefined;
	return resolveAccountDirForAgent(
		{
			toolType: session.toolType,
			customEnvVars:
				session.customEnvVars && typeof session.customEnvVars === 'object'
					? (session.customEnvVars as Record<string, string>)
					: undefined,
			sshRemote: !!sshConfig?.enabled,
		},
		{
			agentLevelEnvVars: options.agentLevelEnvVars ?? readAgentLevelEnvVars(session.toolType),
			globalShellEnvVars: options.globalShellEnvVars ?? readGlobalShellEnvVars(),
			env: options.env ?? process.env,
			homeDir: options.homeDir ?? os.homedir(),
		}
	);
}
