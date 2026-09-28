/**
 * AI Command Mode IPC Handler
 *
 * AI command mode is the second rung of the composer's bang ladder: the user
 * describes what they want in plain English and the tab's own model returns ONE
 * shell command line, which Maestro shows for a yes/no before running it.
 *
 * This handler is only the model round trip. It never executes anything - the
 * accepted command goes back through the renderer's ordinary command-mode path
 * (`process:runCommand`), so a suggested command and a typed one run through
 * exactly the same code, in the same directory, on the same SSH remote.
 *
 * Usage:
 * - window.maestro.aiCommand.suggest(request)
 */

import { ipcMain } from 'electron';
import * as os from 'os';
import type Store from 'electron-store';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { getPrompt } from '../../prompt-manager';
import { groomContext } from '../../utils/context-groomer';
import { resolveConfiguredShell } from '../../stores/defaults';
import {
	AI_COMMAND_HISTORY_LIMIT,
	AI_COMMAND_TIMEOUT_MS,
	buildAiCommandPrompt,
	extractCommandLine,
	type AiCommandHistoryEntry,
} from '../../../shared/aiCommand';
import type { AgentConfigsData } from '../../stores/types';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { MaestroSettings } from './persistence';

const LOG_CONTEXT = '[AICommand]';

const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation' | 'logSuccess'> => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess: false,
	...extra,
});

export interface AiCommandHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
}

/** What the renderer sends. Mirrors the agent config a chat spawn would use. */
export interface AiCommandSuggestRequest {
	/** The user's plain-English description. */
	request: string;
	/** Provider that owns the tab (never hard-coded - the user picks it). */
	agentType: string;
	/** Directory the accepted command will run in. */
	cwd: string;
	isGitRepo?: boolean;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	/** Display name of the SSH remote, for the prompt's environment block. */
	sshRemoteName?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** The tab's current model and effort, resolved by the caller. */
	customModel?: string;
	customEffort?: string;
	/**
	 * Commands already run in this tab, oldest first, so a follow-up like
	 * "actually just the count" can refine the last one instead of guessing at a
	 * fresh command. Collected by the renderer from the tab's own transcript.
	 */
	recentCommands?: AiCommandHistoryEntry[];
}

export interface AiCommandSuggestResult {
	success: boolean;
	command?: string;
	error?: string;
}

export function registerAiCommandHandlers(deps: AiCommandHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore } = deps;

	logger.info('Registering AI command IPC handlers', LOG_CONTEXT);

	ipcMain.handle(
		'aiCommand:suggest',
		withIpcErrorLogging(
			handlerOpts('suggest'),
			async (config: AiCommandSuggestRequest): Promise<AiCommandSuggestResult> => {
				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				const request = (config.request || '').trim();
				if (!request) {
					return { success: false, error: 'Describe what you want to do first.' };
				}

				const agent = await agentDetector.getAgent(config.agentType);
				if (!agent || !agent.available) {
					return {
						success: false,
						error: `${config.agentType} is not available, so it cannot suggest a command.`,
					};
				}

				// Describe the machine the command will actually land on. Over SSH the
				// shell and OS are the remote's and we cannot see them from here, so
				// the prompt names the remote and the model is told to stay portable
				// rather than being handed a local shell that is not the one running.
				const isRemote = !!config.sessionSshRemoteConfig?.enabled;
				// Re-clamp here rather than trusting the renderer's slice: this is an
				// IPC boundary, and an oversized history would silently blow up the
				// prompt (and the bill) for every suggestion.
				const recentCommands = (config.recentCommands ?? []).slice(-AI_COMMAND_HISTORY_LIMIT);
				const prompt = buildAiCommandPrompt(
					getPrompt('ai-command'),
					{
						platform: isRemote ? 'linux' : process.platform,
						release: isRemote ? undefined : os.release(),
						shell: isRemote ? 'POSIX shell over SSH' : resolveConfiguredShell(settingsStore),
						cwd: config.cwd,
						isGitRepo: config.isGitRepo,
						remoteName: isRemote ? config.sshRemoteName : undefined,
					},
					request,
					recentCommands
				);

				const allConfigs = agentConfigsStore.get('configs', {});
				const agentConfigValues = allConfigs[config.agentType] || {};

				logger.info('Requesting command suggestion', LOG_CONTEXT, {
					agentType: config.agentType,
					requestLength: request.length,
					model: config.customModel,
					effort: config.customEffort,
					remote: isRemote,
					historyCount: recentCommands.length,
				});

				let response: string;
				try {
					const result = await groomContext(
						{
							projectRoot: config.cwd,
							agentType: config.agentType,
							prompt,
							// A command suggestion is a text transform, not an errand. Both
							// flags exist to stop the model wandering off into the repo: it
							// must not edit anything, and with tools available a task-shaped
							// request ("clean up the build output") makes it try to DO the
							// work instead of naming the command.
							readOnlyMode: true,
							disableTools: true,
							timeoutMs: AI_COMMAND_TIMEOUT_MS,
							sessionSshRemoteConfig: config.sessionSshRemoteConfig,
							sessionCustomPath: config.customPath,
							sessionCustomArgs: config.customArgs,
							sessionCustomEnvVars: config.customEnvVars,
							sessionCustomModel: config.customModel,
							sessionCustomEffort: config.customEffort,
							agentConfigValues,
						},
						processManager,
						agentDetector
					);
					response = result.response;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn('Command suggestion failed', LOG_CONTEXT, { error: message });
					return { success: false, error: message };
				}

				const command = extractCommandLine(response);
				if (!command) {
					logger.warn('Command suggestion returned nothing usable', LOG_CONTEXT, {
						responseLength: response.length,
					});
					return {
						success: false,
						error: 'The model did not return a command. Try rephrasing the request.',
					};
				}

				logger.info('Command suggestion ready', LOG_CONTEXT, { length: command.length });
				return { success: true, command };
			}
		)
	);
}
