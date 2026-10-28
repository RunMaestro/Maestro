import { getContextWindowForAgent } from '../../agentConstants';
import { isValidAgentId } from '../../agentIds';
import type { AgentRepository } from '../agents/repository';
import { findCodexSessionFile } from '../codex/session-files';
import { execFileNoThrow } from '../launch/exec-file';
import type { MaestroPaths } from '../paths/resolve';
import { getAgentDefinition } from '../providers/definitions';
import { readHistory } from '../store/read-history';
import { readAgentConfigsStore, readSettingsStore } from '../store/read-stores';
import type { AgentRecord } from '../store/records';
import { NativeTranslationService, type TranslationServiceSession } from '../translation/service';
import { locateProviderBinary } from '../turns/provider-binary';
import type { ProcessRegistry } from './processes';

/** The headless host owns the repository and registry; native conversion is shared with desktop. */
export function createRuntimeTranslationService(
	paths: MaestroPaths,
	repository: AgentRepository,
	registry: ProcessRegistry
): NativeTranslationService {
	const session = (record: AgentRecord | undefined): TranslationServiceSession => {
		if (!record || !isValidAgentId(record.toolType) || typeof record.cwd !== 'string')
			throw new Error('Agent is unavailable for native translation');
		return {
			...record,
			toolType: record.toolType,
			cwd: record.cwd,
			aiTabs: (record.aiTabs ?? []).map((tab) => {
				if (tab.tabProvider !== undefined && !isValidAgentId(tab.tabProvider))
					throw new Error(`Unknown tab provider: ${tab.tabProvider}`);
				return {
					...tab,
					tabProvider: tab.tabProvider,
					agentSessionId: tab.agentSessionId ?? null,
				};
			}),
		};
	};
	const providerConfig = (provider: string): Record<string, any> => {
		const read = readAgentConfigsStore(paths.agentConfigsFile);
		return read.status === 'ok' ? (read.data.configs?.[provider] ?? {}) : {};
	};
	return new NativeTranslationService({
		userDataDir: paths.userDataDir,
		getSession: (id) => session(repository.getAgent(id)),
		persist: async (id, update) => {
			const result = await repository.updateTranslation(
				id,
				(record) => ({ ...record, ...update(session(record)) }) as AgentRecord
			);
			if (!result.ok) throw new Error(result.error.message);
		},
		getProvider: async (provider) => {
			const definition = getAgentDefinition(provider);
			if (!definition) return undefined;
			const config = providerConfig(provider);
			const command = await locateProviderBinary(definition, {
				sshEnabled: false,
				providerCustomPath: typeof config.customPath === 'string' ? config.customPath : undefined,
			});
			return { path: command, defaultEnvVars: definition.defaultEnvVars };
		},
		providerConfig,
		globalEnv: () => {
			const read = readSettingsStore(paths.settingsFile);
			const env = read.status === 'ok' ? read.data.shellEnvVars : undefined;
			return env && typeof env === 'object'
				? Object.fromEntries(
						Object.entries(env).filter(
							(entry): entry is [string, string] => typeof entry[1] === 'string'
						)
					)
				: {};
		},
		isBusy: (agent) => registry.isBusy(agent.id),
		findCodexSessionFile,
		history: async (id) => {
			const read = readHistory(paths, id, { limit: Number.MAX_SAFE_INTEGER });
			if (read.status === 'corrupt' || read.status === 'unreadable') throw new Error(read.reason);
			return read.status === 'ok' ? read.entries : [];
		},
		execGit: (args, cwd) =>
			execFileNoThrow('git', args, cwd, {
				timeout: 10_000,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
			}),
		execFile: execFileNoThrow,
		contextWindow: (provider) => getContextWindowForAgent(provider),
	});
}
