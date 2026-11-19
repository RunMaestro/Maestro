/**
 * Side Question IPC Handler (`/btw`)
 *
 * Answers a side question about a tab's conversation without touching it. The
 * turn resumes the tab's provider session as a throwaway fork (the agent's
 * `ephemeralForkArgs`), with tools off, so it can run while the tab's own turn
 * is still working and nothing it says lands in the tab's history.
 *
 * Usage:
 * - window.maestro.sideQuestion.ask(request)
 */

import { ipcMain } from 'electron';
import type Store from 'electron-store';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { groomContext } from '../../utils/context-groomer';
import { createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { buildSideQuestionPrompt, SIDE_QUESTION_TIMEOUT_MS } from '../../../shared/sideQuestion';
import type { AgentConfigsData } from '../../stores/types';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { MaestroSettings } from './persistence';

const LOG_CONTEXT = '[SideQuestion]';

const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation' | 'logSuccess'> => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess: false,
	...extra,
});

export interface SideQuestionHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
}

/** What the renderer sends. Mirrors the agent config a chat spawn would use. */
export interface SideQuestionRequest {
	question: string;
	/** Provider that owns the tab. */
	agentType: string;
	/** The agent's working directory (where the tab's session lives). */
	cwd: string;
	/**
	 * The tab's provider session. Absent for a tab that has not had a turn yet:
	 * the question is then answered with no conversation to read.
	 */
	agentSessionId?: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** The tab's current model and effort, resolved by the caller. */
	customModel?: string;
	customEffort?: string;
}

export interface SideQuestionResult {
	success: boolean;
	answer?: string;
	error?: string;
}

export function registerSideQuestionHandlers(deps: SideQuestionHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore } = deps;

	ipcMain.handle(
		'sideQuestion:ask',
		withIpcErrorLogging(
			handlerOpts('ask'),
			async (config: SideQuestionRequest): Promise<SideQuestionResult> => {
				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				const question = (config.question || '').trim();
				if (!question) {
					return { success: false, error: 'Type a question after /btw.' };
				}

				const agent = await agentDetector.getAgent(config.agentType);
				if (!agent || !agent.available) {
					return { success: false, error: `${config.agentType} is not available.` };
				}
				if (!agent.ephemeralForkArgs?.length) {
					return {
						success: false,
						error: `${agent.name} cannot fork a session, so it cannot answer side questions.`,
					};
				}

				const isRemote = !!config.sessionSshRemoteConfig?.enabled;
				const agentConfigValues = agentConfigsStore.get('configs', {})[config.agentType] || {};

				logger.info('Asking side question', LOG_CONTEXT, {
					agentType: config.agentType,
					questionLength: question.length,
					hasSession: !!config.agentSessionId,
					model: config.customModel,
					remote: isRemote,
				});

				try {
					const result = await groomContext(
						{
							projectRoot: config.cwd,
							agentType: config.agentType,
							prompt: buildSideQuestionPrompt(question),
							agentSessionId: config.agentSessionId,
							// The whole point: read the conversation, never write to it.
							ephemeralFork: true,
							// A side question is a lookup, not an errand. With tools on, a
							// task-shaped question makes the fork start doing the task.
							readOnlyMode: true,
							disableTools: true,
							timeoutMs: SIDE_QUESTION_TIMEOUT_MS,
							sessionSshRemoteConfig: config.sessionSshRemoteConfig,
							sshStore: isRemote ? createSshRemoteStoreAdapter(settingsStore) : undefined,
							sessionCustomPath: config.customPath,
							sessionCustomArgs: config.customArgs,
							sessionCustomEnvVars: config.customEnvVars,
							sessionCustomModel: config.customModel,
							sessionCustomEffort: config.customEffort,
							// No `claudeTokenSource` on purpose: maestro-p tails the transcript
							// it resumed, and a fork never writes to it, so the TUI path would
							// wait out the timeout. Side questions always run `claude --print`.
							agentConfigValues,
						},
						processManager,
						agentDetector
					);
					const answer = result.response.trim();
					if (!answer) {
						return { success: false, error: 'The model returned an empty answer.' };
					}
					return { success: true, answer };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn('Side question failed', LOG_CONTEXT, { error: message });
					return { success: false, error: message };
				}
			}
		)
	);
}
