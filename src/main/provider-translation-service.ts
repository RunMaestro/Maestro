import { app } from 'electron';
import type Store from 'electron-store';
import type { AgentDetector } from './agents';
import type { AgentConfigsData, SessionsData, StoredSession } from './stores/types';
import type { MaestroSettings } from './ipc/handlers/persistence';
import { broadcastSessionLifecycle } from './ipc/handlers/persistence';
import { isAgentBusy, type ProcessLivenessProbe } from './utils/agent-busy';
import { capabilitySnapshots } from './agents/capability-snapshot';
import { execGitReadOnly } from './utils/remote-git';
import { execFileNoThrow } from './utils/execFile';
import { captureMessage } from './utils/sentry';
import { CodexSessionStorage } from './storage/codex-session-storage';
import { getHistoryManager } from './history-manager';
import { getContextWindowForAgent } from '../shared/agentConstants';
import { translationSessionTabs } from '../shared/maestro-lib/translation/session';
import {
	NativeTranslationService,
	type TranslationServiceSession,
} from '../shared/maestro-lib/translation/service';
import type { TranslationLimitation } from '../shared/maestro-lib/translation/types';
import type { TranslationServiceHost } from '../shared/maestro-lib/translation/service';
import { createSshRemoteStoreAdapter } from './utils/ssh-remote-resolver';
import { resolveSshTranslationHost } from './provider-translation-ssh';
import { getAgentDefinition } from '../shared/maestro-lib/providers/definitions';

export interface ProviderTranslationDependencies {
	sessionsStore: Store<SessionsData>;
	settingsStore: Store<MaestroSettings>;
	agentConfigsStore: Store<AgentConfigsData>;
	getAgentDetector(): AgentDetector | null;
	getProcessManager(): ProcessLivenessProbe | null;
}

/** Desktop host for the same native translation service the runtime uses. */
export class ProviderTranslationService extends NativeTranslationService {
	constructor(deps: ProviderTranslationDependencies) {
		const session = (agentId: string): TranslationServiceSession => {
			const found = deps.sessionsStore.get('sessions', []).find((s) => s.id === agentId);
			if (!found) throw new Error('Agent not found');
			return found as StoredSession & TranslationServiceSession;
		};
		const host: TranslationServiceHost = {
			userDataDir: app.getPath('userData'),
			getSession: session,
			persist: async (agentId, update) => {
				const before = session(agentId);
				const next = update(before) as StoredSession;
				deps.sessionsStore.set(
					'sessions',
					deps.sessionsStore.get('sessions', []).map((s) => (s.id === agentId ? next : s))
				);
				broadcastSessionLifecycle(undefined, {
					added: [],
					removedIds: [],
					baselines: [before as StoredSession],
					updated: [next],
				});
			},
			getProvider: async (provider) => {
				const detector = deps.getAgentDetector();
				if (!detector) throw new Error('Agent detector unavailable');
				return detector.getAgent(provider);
			},
			providerConfig: (provider) => deps.agentConfigsStore.get('configs', {})[provider] ?? {},
			globalEnv: () => deps.settingsStore.get('shellEnvVars', {}) as Record<string, string>,
			isBusy: (agent) => {
				const manager = deps.getProcessManager();
				if (!manager)
					throw new Error(
						'Live process ownership is unavailable; native migration cannot be planned safely'
					);
				return isAgentBusy({ ...agent, aiTabs: translationSessionTabs(agent) }, manager);
			},
			findCodexSessionFile: (id, root) => new CodexSessionStorage().findSessionFile(id, root),
			history: (id) => getHistoryManager().getEntries(id),
			execGit: execGitReadOnly,
			execFile: execFileNoThrow,
			contextWindow: (provider) =>
				getContextWindowForAgent(provider, capabilitySnapshots.get(provider)),
			reportPlan: (plan) => {
				const limitationCounts: Record<
					TranslationLimitation['severity'],
					Record<string, number>
				> = {
					info: Object.create(null),
					warning: Object.create(null),
					block: Object.create(null),
				};
				for (const limitation of plan.limitations) {
					const counts = limitationCounts[limitation.severity];
					counts[limitation.code] = (counts[limitation.code] ?? 0) + 1;
				}
				void captureMessage('provider-translation-plan', 'info', {
					sourceProvider: plan.source.provider,
					destinationProvider: plan.destination.provider,
					sourceVersion: plan.source.version,
					destinationVersion: plan.destination.version,
					status: plan.status,
					verification: plan.verification,
					limitationCounts,
				});
			},
		};
		super({
			...host,
			resolveNativeHost: (agent) => {
				if (!agent.sessionSshRemoteConfig?.enabled && !agent.sshRemoteId)
					return Promise.resolve(undefined);
				return resolveSshTranslationHost(agent, createSshRemoteStoreAdapter(deps.settingsStore), {
					...host,
					getProvider: async (provider) => getAgentDefinition(provider),
				});
			},
		});
	}
}
