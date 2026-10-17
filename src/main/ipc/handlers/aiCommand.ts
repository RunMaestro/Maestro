/**
 * AI Command Mode IPC Handler
 *
 * AI command mode is the second rung of the composer's bang ladder: the user
 * describes what they want in plain English and a model returns ONE shell
 * command line, which Maestro shows for a yes/no before running it. Which model
 * is the `ai-command` Local Models assignment: the tab's own provider by
 * default (`utility-agent`), or a local model or endpoint the user assigned.
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
import { createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { resolveConfiguredShell } from '../../stores/defaults';
import {
	AI_COMMAND_HISTORY_LIMIT,
	AI_COMMAND_LOCAL_HISTORY_LIMIT,
	AI_COMMAND_REPLY_SCHEMA,
	AI_COMMAND_TIMEOUT_MS,
	buildAiCommandPrompt,
	extractCommandLine,
	parseAiCommandReply,
	type AiCommandHistoryEntry,
	type AiCommandHost,
} from '../../../shared/aiCommand';
import { localModelAssignmentSourceLabel } from '../../../shared/local-models/tasks';
import { taskAssignmentLocation } from '../../../shared/local-models/settings-location';
import { getConfiguredLocalModelEndpoints } from '../../local-models/endpoint-service';
import { runLocalTask } from '../../local-models/task-router';
import { captureException } from '../../utils/sentry';
import type { AgentConfigsData } from '../../stores/types';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { MaestroSettings } from './persistence';
import type { ClaudeTokenSourceFields } from '../../../shared/claudeTokenMode';

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
	/** The agent's Claude token source, so a TUI agent suggests through maestro-p. */
	claudeTokenSource?: ClaudeTokenSourceFields;
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
	/**
	 * One sentence on what the command does. Only a Local Models source is asked
	 * for one; the agent path replies with a bare command line.
	 */
	explanation?: string;
	/**
	 * The local model or endpoint that produced the command, named for a person.
	 * Absent when the tab's own provider answered: the renderer already knows
	 * that model, because it chose it.
	 */
	producedBy?: string;
}

export function registerAiCommandHandlers(deps: AiCommandHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore } = deps;

	logger.info('Registering AI command IPC handlers', LOG_CONTEXT);

	ipcMain.handle(
		'aiCommand:suggest',
		withIpcErrorLogging(
			handlerOpts('suggest'),
			async (config: AiCommandSuggestRequest): Promise<AiCommandSuggestResult> => {
				const request = (config.request || '').trim();
				if (!request) {
					return { success: false, error: 'Describe what you want to do first.' };
				}

				// Describe the machine the command will actually land on. Over SSH the
				// shell and OS are the remote's and we cannot see them from here, so
				// the prompt names the remote and the model is told to stay portable
				// rather than being handed a local shell that is not the one running.
				const isRemote = !!config.sessionSshRemoteConfig?.enabled;
				const host: AiCommandHost = {
					platform: isRemote ? 'linux' : process.platform,
					release: isRemote ? undefined : os.release(),
					shell: isRemote ? 'POSIX shell over SSH' : resolveConfiguredShell(settingsStore),
					cwd: config.cwd,
					isGitRepo: config.isGitRepo,
					remoteName: isRemote ? config.sshRemoteName : undefined,
				};
				// Re-clamp here rather than trusting the renderer's slice: this is an
				// IPC boundary, and an oversized history would silently blow up the
				// prompt (and the bill) for every suggestion.
				const recentCommands = (config.recentCommands ?? []).slice(-AI_COMMAND_HISTORY_LIMIT);

				// Local Models assignment first. Only `use-utility-agent` (the default)
				// continues to the tab's own provider below, unchanged. It runs before
				// the provider is looked up because an assigned model does not need
				// the tab's agent to be installed.
				let assigned: AiCommandSuggestResult | null;
				try {
					assigned = await suggestWithAssignedModel(host, request, recentCommands);
				} catch (error) {
					// The router throws only for an unclassified engine failure: a bug
					// worth reporting, and the composer still needs an answer to show.
					void captureException(error);
					const message = error instanceof Error ? error.message : String(error);
					logger.error('Command suggestion on the assigned model failed', LOG_CONTEXT, {
						error: message,
					});
					return { success: false, error: message };
				}
				if (assigned) return assigned;

				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				const agent = await agentDetector.getAgent(config.agentType);
				if (!agent || !agent.available) {
					return {
						success: false,
						error: `${config.agentType} is not available, so it cannot suggest a command.`,
					};
				}

				const prompt = buildAiCommandPrompt(getPrompt('ai-command'), host, request, recentCommands);

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
							// Where groomContext looks the remote up. It refuses an SSH agent
							// that comes without one rather than run the prompt on this
							// machine, so leaving it out fails every suggestion for an agent
							// on a remote.
							sshStore: isRemote ? createSshRemoteStoreAdapter(settingsStore) : undefined,
							sessionCustomPath: config.customPath,
							sessionCustomArgs: config.customArgs,
							sessionCustomEnvVars: config.customEnvVars,
							sessionCustomModel: config.customModel,
							sessionCustomEffort: config.customEffort,
							claudeTokenSource: config.claudeTokenSource,
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

/**
 * Tokens a Local Models suggestion may spend: one command line and one
 * sentence, as JSON.
 */
const LOCAL_AI_COMMAND_MAX_TOKENS = 256;

/**
 * Suggest the command with the `ai-command` Local Models assignment, when it is
 * a local model or an endpoint. Returns null for `use-utility-agent`: the
 * caller keeps the tab's own provider, which is the default, so nothing changes
 * until the user assigns a model.
 *
 * Every other verdict is answered here, and none of them falls back to an
 * agent:
 *   - `off` refuses and says where the switch is. The feature cannot work
 *     without a model, but Off sits beside Utility Agent in the same picker, so
 *     it is the user choosing "no model", and the tab's provider is not used
 *     behind their back. It cannot skip silently either: the user is waiting on
 *     a spinner in the composer.
 *   - `unavailable` fails with the reason, which names the model or endpoint.
 *     The composer shows that text in place of the proposal on every attempt,
 *     so it needs no separate deduplicated toast (`reportLocalTaskUnavailable`)
 *     on top.
 *   - `cancelled` means the timeout below fired.
 *
 * A small model is acceptable for this task because nothing it writes runs
 * unreviewed: the command and its one-line explanation are shown for a yes/no
 * first.
 *
 * SSH: a local model runs on THIS machine even when the command will run on a
 * remote host. That is fine: the request, the working directory, and the recent
 * commands already crossed to this machine (the renderer sent them), and the
 * prompt names the remote rather than reading anything from it.
 */
async function suggestWithAssignedModel(
	host: AiCommandHost,
	request: string,
	recentCommands: readonly AiCommandHistoryEntry[]
): Promise<AiCommandSuggestResult | null> {
	const verdict = await runLocalTask('ai-command', {
		prompt: buildAiCommandPrompt(
			getPrompt('ai-command-local'),
			host,
			request,
			recentCommands.slice(-AI_COMMAND_LOCAL_HISTORY_LIMIT)
		),
		maxTokens: LOCAL_AI_COMMAND_MAX_TOKENS,
		jsonSchema: AI_COMMAND_REPLY_SCHEMA,
		signal: AbortSignal.timeout(AI_COMMAND_TIMEOUT_MS),
	});

	switch (verdict.status) {
		case 'use-utility-agent':
			return null;
		case 'off':
			return {
				success: false,
				error: `AI command mode is switched off. Pick a source for it in ${taskAssignmentLocation('ai-command')}.`,
			};
		case 'cancelled':
			logger.warn('Command suggestion on the assigned model timed out', LOG_CONTEXT, {
				source: verdict.source,
			});
			return { success: false, error: 'The assigned model took too long to answer. Try again.' };
		case 'unavailable':
			logger.warn('Command suggestion skipped: assigned model unavailable', LOG_CONTEXT, {
				source: verdict.source,
				code: verdict.code,
				reason: verdict.reason,
			});
			return { success: false, error: verdict.reason };
		case 'ok': {
			const producedBy =
				localModelAssignmentSourceLabel(verdict.source, getConfiguredLocalModelEndpoints()) ??
				undefined;
			const reply = parseAiCommandReply(verdict.json, verdict.text);
			if (!reply) {
				logger.warn('Assigned model returned nothing usable', LOG_CONTEXT, {
					source: verdict.source,
					responseLength: verdict.text.length,
				});
				return {
					success: false,
					error: 'The model did not return a command. Try rephrasing the request.',
					...(producedBy && { producedBy }),
				};
			}
			logger.info('Command suggestion ready from the assigned model', LOG_CONTEXT, {
				source: verdict.source,
				durationMs: verdict.durationMs,
				length: reply.command.length,
			});
			return { success: true, ...reply, ...(producedBy && { producedBy }) };
		}
	}
}
