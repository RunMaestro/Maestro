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

const LOG_CONTEXT = '[ContextMerge]';

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
					 */
					cheapTurn?: boolean;
				}
			): Promise<string> => {
				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				// Resolve the agent: use the utility agent if configured, otherwise the
				// requested agent. Null/empty leaves behavior unchanged (session agent).
				const utilityAgentId = settingsStore.get('utilityAgentId', null) as string | null;
				const utilityModelId = settingsStore.get('utilityModelId', null) as string | null;
				const effectiveAgentType = utilityAgentId || agentType;

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
				const usingUtilityAgent = !!utilityAgentId && effectiveAgentType !== agentType;

				// Only summarization opts in (see `cheapTurn` above). Left undefined
				// for grooming and transfer, which keep the agent's configured model.
				const cheapTurn = options?.cheapTurn ? cheapTurnSettings(agentType as ToolType) : undefined;

				// Use the shared groomContext utility
				const result = await groomContext(
					{
						projectRoot,
						agentType: effectiveAgentType,
						prompt,
						// Only apply the model override when a utility agent is actually in use.
						modelId: utilityAgentId ? (utilityModelId ?? undefined) : undefined,
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
						sessionCustomModel: cheapTurn?.model,
						sessionCustomEffort: cheapTurn?.effort,
						agentConfigValues,
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
		})
	);
}
