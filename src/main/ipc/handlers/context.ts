/**
 * Context Merge IPC Handlers
 *
 * This module provides IPC handlers for context merging operations,
 * enabling session context transfer and grooming across AI agents.
 *
 * Usage:
 * - window.maestro.context.getStoredSession(agentId, projectRoot, sessionId)
 * - window.maestro.context.groomContext(projectRoot, agentType, prompt)
 * - window.maestro.context.cancelGrooming()
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { getSessionStorage, type SessionMessagesResult } from '../../agents';
import { groomContext, cancelAllGroomingSessions } from '../../utils/context-groomer';
import { createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { getSettingsStore } from '../../stores';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type Store from 'electron-store';
import type { AgentConfigsData, MaestroSettings } from '../../stores/types';
import { captureException } from '../../utils/sentry';
import { cheapTurnSettings } from '../../../shared/modelTiers';
import type { ToolType } from '../../../shared/types';
import { MAX_TASK_MAX_TOKENS, runLocalTask } from '../../local-models/task-router';
import type { ClaudeTokenSourceFields } from '../../../shared/claudeTokenMode';
import { resolveUtilityProvider } from '../../../shared/local-models/tasks';

const LOG_CONTEXT = '[ContextMerge]';

/**
 * Ceiling for one summary on the assigned local model or endpoint. Longer than
 * an agent turn's budget: a local model on CPU writes a long summary slowly.
 */
const LOCAL_SUMMARY_TIMEOUT_MS = 5 * 60_000;

/** Local summaries in flight, so `context:cancelGrooming` stops them too. */
const activeLocalSummaries = new Set<AbortController>();

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation' | 'logSuccess'> => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess: false,
	...extra,
});

/**
 * Dependencies required for context handler registration
 */
export interface ContextHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
}

/**
 * Register all Context Merge IPC handlers.
 *
 * These handlers support context merging operations:
 * - getStoredSession: Retrieve messages from an agent session storage
 * - groomContext: Run one batch turn with a prompt and return its response
 * - cancelGrooming: Stop every grooming turn in progress
 */
export function registerContextHandlers(deps: ContextHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore } = deps;

	logger.info('Registering context IPC handlers', LOG_CONTEXT);

	// Get context from a stored agent session
	ipcMain.handle(
		'context:getStoredSession',
		withIpcErrorLogging(
			handlerOpts('getStoredSession'),
			async (
				agentId: string,
				projectRoot: string,
				sessionId: string
			): Promise<SessionMessagesResult | null> => {
				logger.debug('Getting stored session context', LOG_CONTEXT, {
					agentId,
					projectRoot,
					sessionId,
				});

				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return null;
				}

				try {
					const result = await storage.readSessionMessages(projectRoot, sessionId);
					logger.debug('Retrieved session messages', LOG_CONTEXT, {
						agentId,
						sessionId,
						messageCount: result.messages.length,
						total: result.total,
					});
					return result;
				} catch (error) {
					void captureException(error);
					logger.error('Failed to read session messages', LOG_CONTEXT, {
						agentId,
						projectRoot,
						sessionId,
						error: String(error),
					});
					return null;
				}
			}
		)
	);

	// Single-call grooming: spawns a batch mode process with the prompt.
	ipcMain.handle(
		'context:groomContext',
		withIpcErrorLogging(
			handlerOpts('groomContext'),
			async (
				projectRoot: string,
				agentType: string,
				prompt: string,
				options?: {
					sshRemoteConfig?: {
						enabled: boolean;
						remoteId: string | null;
						workingDirOverride?: string;
					};
					customPath?: string;
					customArgs?: string;
					customEnvVars?: Record<string, string>;
					/**
					 * Pin this turn to the bottom of both ladders. Summarization sets it;
					 * grooming and transfer must not, because their output becomes the
					 * context every later turn reads. The handler cannot tell the three
					 * apart - it only receives a prompt string - so the caller decides.
					 *
					 * The same flag routes the turn through the `tab-summary` Local
					 * Models assignment (see `summarizeWithAssignedModel`). Grooming
					 * and transfer never set it, so they always stay on the agent's
					 * own model: a weak result there would degrade every later turn.
					 */
					cheapTurn?: boolean;
					/**
					 * For a turn that only ANSWERS (a classification, a one-word
					 * decision): no tool may run, nothing may be written, and the call
					 * gives up after `timeoutMs` instead of the grooming default. Quick
					 * Chat's tab routing sets all three.
					 */
					readOnly?: boolean;
					disableTools?: boolean;
					timeoutMs?: number;
					/** The session agent's Claude token source (see GroomContextOptions). */
					claudeTokenSource?: ClaudeTokenSourceFields;
				}
			): Promise<string> => {
				// A cheap turn that may use tools is a context SUMMARY, so the model
				// assigned to `tab-summary` gets it first. An answer-only turn (Quick
				// Chat's tab routing) is cheap too, but it is a question with a
				// one-word answer, not a summary: it must not be sent to the summary
				// model, with the summary's token budget and timeout.
				if (options?.cheapTurn && !options.disableTools) {
					const assigned = await summarizeWithAssignedModel(prompt);
					if (assigned !== null) return assigned;
				}

				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				// Resolve the agent: use the utility agent if configured, otherwise the
				// requested agent. Null/empty leaves behavior unchanged (session agent).
				// Local utility sources handle the text tasks above. Tool-based
				// grooming and transfer stay on the owning session's provider, not
				// a provider choice left over from an earlier utility configuration.
				const utility = resolveUtilityProvider(
					{
						utilitySource: settingsStore.get('utilitySource'),
						utilityAgentId: settingsStore.get('utilityAgentId', null),
						utilityModelId: settingsStore.get('utilityModelId', null),
					},
					agentType
				);
				const effectiveAgentType = utility.agentType;

				// Look up agent-level config values for override resolution
				const allConfigs = agentConfigsStore.get('configs', {});
				const agentConfigValues = allConfigs[effectiveAgentType] || {};

				// The session's executable overrides describe the SESSION's agent: a
				// pinned binary path, its CLI flags, its env. Carrying them onto a
				// different utility agent would launch the wrong executable, or feed
				// one agent's flags to another. The utility agent's own settings come
				// from `agentConfigValues`, which is already keyed by the effective id.
				//
				// `sshRemoteConfig` is deliberately NOT dropped: it says WHERE the work
				// runs, not WHICH binary runs it, and grooming a remote agent's context
				// on the local machine would look at the wrong filesystem.
				const usingUtilityAgent = utility.changesProvider;

				// Only summarization opts in (see `cheapTurn` above). Left undefined
				// for grooming and transfer, which keep the agent's configured model.
				const cheapTurn = options?.cheapTurn
					? cheapTurnSettings(effectiveAgentType as ToolType)
					: undefined;

				// Use the shared groomContext utility
				const result = await groomContext(
					{
						projectRoot,
						agentType: effectiveAgentType,
						prompt,
						// Only apply the model override when a utility agent is actually in use.
						modelId: utility.modelId,
						// Pass SSH and custom config for remote execution support.
						// The store lets groomContext resolve `remoteId` and actually
						// wrap the spawn with ssh - without it grooming would run the
						// prompt locally (issue #1416).
						sessionSshRemoteConfig: options?.sshRemoteConfig,
						sshStore: options?.sshRemoteConfig?.enabled
							? createSshRemoteStoreAdapter(getSettingsStore())
							: undefined,
						// A utility agent runs as ITSELF, so the calling session's own
						// binary path / args / env must not leak into its spawn.
						sessionCustomPath: usingUtilityAgent ? undefined : options?.customPath,
						sessionCustomArgs: usingUtilityAgent ? undefined : options?.customArgs,
						sessionCustomEnvVars: usingUtilityAgent ? undefined : options?.customEnvVars,
						// Undefined unless the caller asked for a cheap turn, and
						// undefined means "inherit the agent's own value" all the way
						// down - so grooming and transfer are untouched by this. An
						// explicit tier is not the caller's own setting leaking, so it
						// applies to a utility agent too.
						sessionCustomModel: utility.modelId ?? cheapTurn?.model,
						sessionCustomEffort: cheapTurn?.effort,
						// The token source belongs to the session's agent, like its path
						// and env above, so a utility agent runs on its own default.
						claudeTokenSource: usingUtilityAgent ? undefined : options?.claudeTokenSource,
						agentConfigValues,
						readOnlyMode: options?.readOnly,
						disableTools: options?.disableTools,
						timeoutMs: options?.timeoutMs,
					},
					processManager,
					agentDetector
				);

				return result.response;
			}
		)
	);

	// Cancel all active grooming sessions
	ipcMain.handle(
		'context:cancelGrooming',
		withIpcErrorLogging(handlerOpts('cancelGrooming'), async (): Promise<void> => {
			logger.info('Cancelling all grooming sessions via IPC', LOG_CONTEXT);
			cancelAllGroomingSessions();
			for (const controller of activeLocalSummaries) controller.abort();
		})
	);
}

/**
 * Write a context summary with the `tab-summary` Local Models assignment, when
 * it is a local model or an endpoint. Returns `null` when the caller should
 * keep its agent path.
 *
 * Compaction is something the user asked for, and it cannot happen without a
 * model, so the verdicts differ from a cosmetic task like tab naming:
 *   - `use-utility-agent` (the default) and `off` keep the agent path. `off`
 *     cannot mean "skip": a skipped compaction is a failed one.
 *   - `unavailable` does NOT fall back to an agent: it fails the compaction
 *     with the reason, which the "Compaction Failed" toast shows. That toast is
 *     the notice, raised once per attempt the user made, so the deduplicated
 *     Local Models notice would only repeat it.
 *   - `cancelled` (Stop, or the timeout) fails the compaction the same way.
 *
 * SSH: a local model runs on THIS machine even when the agent is remote. The
 * transcript being summarized already came from this machine's renderer, so
 * nothing crosses that would not have crossed already.
 */
async function summarizeWithAssignedModel(prompt: string): Promise<string | null> {
	const controller = new AbortController();
	activeLocalSummaries.add(controller);
	try {
		const verdict = await runLocalTask('tab-summary', {
			prompt,
			maxTokens: MAX_TASK_MAX_TOKENS,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(LOCAL_SUMMARY_TIMEOUT_MS)]),
		});
		switch (verdict.status) {
			case 'use-utility-agent':
			case 'off':
				return null;
			case 'cancelled':
				throw new Error('The summary on the assigned local model was stopped before it finished.');
			case 'unavailable':
				logger.warn('Context summary skipped: assigned model unavailable', LOG_CONTEXT, {
					source: verdict.source,
					code: verdict.code,
					reason: verdict.reason,
				});
				throw new Error(verdict.reason);
			case 'ok':
				logger.info('Context summary on the assigned model', LOG_CONTEXT, {
					source: verdict.source,
					durationMs: verdict.durationMs,
					responseLength: verdict.text.length,
				});
				return verdict.text;
		}
	} finally {
		activeLocalSummaries.delete(controller);
	}
}
