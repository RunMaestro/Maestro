import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { getHistoryManager } from '../../history-manager';

export function registerDirectorNotesCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getProcessManager' | 'sessionsStore' | 'settingsStore'>
): void {
	const { getProcessManager, sessionsStore, settingsStore } = deps;

	server.setGenerateDirectorNotesSynopsisCallback(
		async (lookbackDays: number, provider: string) => {
			const processManager = getProcessManager();
			if (!processManager) {
				return {
					success: false,
					synopsis: '',
					error: 'Process manager not available',
				};
			}

			const { groomContext } = await import('../../utils/context-groomer');
			const { buildDirectorNotesSynopsisPrompt } =
				await import('../../utils/director-notes-prompt');
			const { getPrompt } = await import('../../prompt-manager');
			const { AgentDetector } = await import('../../agents');
			const { getAgentConfigsStore } = await import('../../stores');

			const agentDetector = new AgentDetector();
			const agentConfigsStore = getAgentConfigsStore();

			const agent = await agentDetector.getAgent(provider as any);
			if (!agent || !agent.available) {
				return {
					success: false,
					synopsis: '',
					error: `Agent "${provider}" is not available.`,
				};
			}

			const historyManager = getHistoryManager();

			// Build session name map
			const storedSessions = sessionsStore.get('sessions', []) as Array<{
				id: string;
				name?: string;
			}>;
			const sessionNameMap = new Map<string, string>();
			for (const s of storedSessions) {
				if (s.id && s.name) sessionNameMap.set(s.id, s.name);
			}

			// Same cross-host corpus the desktop path folds in, so a CLI-driven
			// synopsis covers work done by peer Maestro instances too.
			const { prepareSharedHistoryForSynopsis } =
				await import('../../utils/director-notes-shared-history');
			const cutoffTime = lookbackDays > 0 ? Date.now() - lookbackDays * 24 * 60 * 60 * 1000 : 0;

			// Scope the manifest to the lookback window so the batch agent only
			// reads files it needs (see director-notes-prompt for the rationale).
			const { prompt, agentCount, entryCount } = await buildDirectorNotesSynopsisPrompt({
				historyManager,
				sessionNameMap,
				lookbackDays,
				basePrompt: getPrompt('director-notes'),
				// Same setting the desktop path reads, so a CLI-driven synopsis
				// is framed by the end state too.
				idealEndState: (() => {
					const dn = (settingsStore.get('directorNotesSettings') ?? {}) as Record<string, unknown>;
					return typeof dn.idealEndState === 'string' ? dn.idealEndState : '';
				})(),
				sharedHistoryFile: await prepareSharedHistoryForSynopsis(cutoffTime),
			});

			if (!prompt) {
				return {
					success: true,
					synopsis: `# Director's Notes\n\n*Generated for the past ${lookbackDays} days*\n\nNo history files found.`,
					generatedAt: Date.now(),
					stats: { agentCount: 0, entryCount: 0, durationMs: 0 },
				};
			}

			try {
				const allConfigs = agentConfigsStore.get('configs', {});
				const dnAgentConfigValues = allConfigs[provider] || {};

				// Intentionally local, same as the desktop Director's Notes handler:
				// the prompt manifests history files on THIS machine, so grooming
				// gets no `sessionSshRemoteConfig` and spawns locally (issue #1416).
				const result = await groomContext(
					{
						projectRoot: process.cwd(),
						agentType: provider as any,
						prompt,
						readOnlyMode: true,
						agentConfigValues: dnAgentConfigValues,
					},
					processManager,
					agentDetector
				);

				const synopsis = result.response.trim();
				if (!synopsis) {
					return {
						success: false,
						synopsis: '',
						error: 'Agent returned an empty response.',
					};
				}

				return {
					success: true,
					synopsis,
					generatedAt: Date.now(),
					stats: { agentCount, entryCount, durationMs: result.durationMs },
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					success: false,
					synopsis: '',
					error: `Synopsis generation failed: ${errorMsg}`,
				};
			}
		}
	);
}
