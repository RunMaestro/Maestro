/**
 * Cross-Agent Dispatch IPC Handlers (Phase 03).
 *
 * Exposes `cross-agent:send` to the renderer: the user typed `@target ...` in
 * a source agent, and the renderer forwards the (already windowed) source
 * transcript + the user's prompt here. We stamp a `requestId`, kick off
 * {@link startCrossAgentRequest} (non-blocking), and forward every response
 * chunk back to the renderer via `cross-agent:chunk`.
 *
 * Session-config resolution reads the same main-process session store Group
 * Chat uses; SSH is honored via the shared SSH store adapter.
 */

import { ipcMain } from 'electron';
import * as os from 'os';
import type Store from 'electron-store';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { SessionsData, AgentConfigsData } from '../../stores/types';
import type { SafeSendFn } from '../../utils/safe-send';
import type { SshRemoteSettingsStore } from '../../utils/ssh-remote-resolver';
import type { ToolType } from '../../../shared/types';
import type {
	CrossAgentRequest,
	CrossAgentSendRequest,
	CrossAgentResponseChunk,
} from '../../../shared/crossAgentTypes';
import { generateUUID } from '../../../shared/uuid';
import { logger } from '../../utils/logger';
import {
	startCrossAgentRequest,
	type CrossAgentTargetSession,
} from '../../cross-agent/cross-agent-router';

const LOG_CONTEXT = '[CrossAgent]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface CrossAgentHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	/** Session store (source of the target agent's toolType / cwd / SSH config). */
	sessionsStore: Store<SessionsData>;
	/** Per-agent config values (context window, model, effort, custom env vars). */
	agentConfigsStore: Store<AgentConfigsData>;
	/** SSH remote store adapter; null disables remote execution. */
	sshStore: SshRemoteSettingsStore | null;
	/** Per-agent custom env var resolver (fallback when no session override). */
	getCustomEnvVars?: (toolType: string) => Record<string, string> | undefined;
	/** Safe renderer push used to stream `cross-agent:chunk` events. */
	safeSend: SafeSendFn;
}

/**
 * Register the cross-agent dispatch IPC handlers.
 */
export function registerCrossAgentHandlers(deps: CrossAgentHandlerDependencies): void {
	const {
		getProcessManager,
		getAgentDetector,
		sessionsStore,
		agentConfigsStore,
		sshStore,
		getCustomEnvVars,
		safeSend,
	} = deps;

	/** Resolve a target agent's stored config into the router's input shape. */
	const getTargetSession = (sessionId: string): CrossAgentTargetSession | null => {
		const sessions = sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
		const s = sessions.find((x) => x && typeof x === 'object' && x.id === sessionId) as
			| Record<string, any>
			| undefined;
		if (!s) return null;
		return {
			id: s.id,
			name: s.name,
			toolType: s.toolType as ToolType,
			cwd: s.cwd || s.fullPath || os.homedir(),
			customArgs: s.customArgs,
			customEnvVars: s.customEnvVars,
			customModel: s.customModel,
			customEffort: s.customEffort,
			customContextWindow: s.customContextWindow,
			enableMaestroP: s.enableMaestroP,
			maestroPMode: s.maestroPMode,
			maestroPPath: s.maestroPPath,
			sshRemoteConfig: s.sessionSshRemoteConfig ?? null,
		};
	};

	/** Agent-level config values (mirrors director-notes' resolution). */
	const getAgentConfig = (toolType: string): Record<string, unknown> => {
		const allConfigs = agentConfigsStore.get('configs', {}) as Record<
			string,
			Record<string, unknown>
		>;
		return allConfigs[toolType] || {};
	};

	ipcMain.handle(
		'cross-agent:send',
		withIpcErrorLogging(
			handlerOpts('send'),
			async (payload: CrossAgentSendRequest): Promise<{ requestId: string }> => {
				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				const requestId = generateUUID();
				const request: CrossAgentRequest = {
					requestId,
					sourceSessionId: payload.sourceSessionId,
					sourceAgentName: payload.sourceAgentName,
					sourceTabId: payload.sourceTabId,
					targetSessionId: payload.targetSessionId,
					targetTabId: payload.targetTabId,
					resumeAgentSessionId: payload.resumeAgentSessionId,
					userPrompt: payload.userPrompt,
					transcript: payload.transcript,
					strategy: payload.strategy,
					sourceCwd: payload.sourceCwd,
					createdAt: Date.now(),
				};

				logger.info(`${LOG_CONTEXT} Dispatching cross-agent request`, LOG_CONTEXT, {
					requestId,
					sourceSessionId: payload.sourceSessionId,
					targetSessionId: payload.targetSessionId,
					transcriptEntries: payload.transcript.length,
				});

				// Fire-and-forget: startCrossAgentRequest resolves once the spawn is
				// initiated; response chunks arrive over time via onChunk. Any error
				// during dispatch is surfaced as a terminal error chunk (either by the
				// router or the catch below), never thrown back to the renderer.
				void startCrossAgentRequest(request, {
					processManager,
					agentDetector,
					sshStore,
					getTargetSession,
					getAgentConfig,
					getCustomEnvVars,
					onChunk: (chunk: CrossAgentResponseChunk) => safeSend('cross-agent:chunk', chunk),
				}).catch((err) => {
					logger.error(`${LOG_CONTEXT} Cross-agent dispatch failed`, LOG_CONTEXT, {
						requestId,
						error: err instanceof Error ? err.message : String(err),
					});
					const errorTarget = getTargetSession(payload.targetSessionId);
					const errorChunk: CrossAgentResponseChunk = {
						requestId,
						sourceSessionId: payload.sourceSessionId,
						sourceTabId: payload.sourceTabId,
						targetSessionId: payload.targetSessionId,
						targetTabId: payload.targetTabId,
						targetAgentName: errorTarget?.name ?? payload.targetSessionId,
						targetToolType: (errorTarget?.toolType ?? 'claude-code') as ToolType,
						chunk: '',
						done: true,
						error: err instanceof Error ? err.message : String(err),
					};
					safeSend('cross-agent:chunk', errorChunk);
				});

				return { requestId };
			}
		)
	);
}
