/**
 * Wire the AgentRunCaptureService to the ProcessManager lifecycle (F1).
 *
 * Symmetric with setupExitListener: `spawn` creates the run, `exit` settles it.
 * Both handlers are guarded inside the service, so a capture failure never
 * disturbs spawning or the Cue/exit path. Terminal and group-chat sessions are
 * filtered inside the service (ISC-1.7).
 */

import { getSessionsStore } from '../stores/getters';
import { pianolaNewTabSpawns } from '../pianola/pianola-new-tab-dispatch';
import type { ProcessManager } from '../process-manager';
import type { ProcessConfig, TurnSettlement } from '../process-manager/types';
import type { AgentError } from '../../shared/types';
import {
	findActiveRunBySession,
	getAgentRun,
	upsertAgentRun,
	appendAgentRunEvent,
} from '../../cli/services/agent-run-store';
import { logger } from '../utils/logger';
import { AgentRunCaptureService, type CaptureServiceDeps } from './capture-service';
import { broadcastRunUpdated, broadcastEventAppended } from './broadcast';
import { redactPrompt } from '../../shared/agent-run';
import { buildEnrichHook } from './producers';

import { nativeCurrentTurns } from '../pianola/current-turn';

const LOG_CONTEXT = '[AgentRunCapture]';

export interface CaptureListenerOptions {
	/** F2 enrich hook (git diff / usage / etc.), injected by the producers wave. */
	enrich?: CaptureServiceDeps['enrich'];
	/** F6 prompt redaction/gating, injected by the integrity wave. */
	preparePrompt?: CaptureServiceDeps['preparePrompt'];
}

export function setupAgentRunCapture(
	processManager: ProcessManager,
	options: CaptureListenerOptions = {}
): AgentRunCaptureService {
	const service = new AgentRunCaptureService({
		resolveNativeTabSession: (input) => {
			const matches = getSessionsStore()
				.get('sessions', [])
				.flatMap((agent) =>
					(agent.aiTabs ?? [])
						.filter((tab: { id: string }) => input.sessionId === `${agent.id}-ai-${tab.id}`)
						.map((tab: { id: string; createdAt: number; agentSessionId?: string | null }) => ({
							agent,
							tab,
						}))
				);
			const target = matches.length === 1 ? matches[0] : undefined;
			return target && (target.tab.agentSessionId ?? undefined) === input.agentSessionId
				? {
						agentId: target.agent.id,
						tabId: target.tab.id,
						createdAt: target.tab.createdAt,
						initialSessionId: target.tab.agentSessionId,
					}
				: undefined;
		},
		getAgentRun,
		upsertAgentRun: (run) => {
			const saved = upsertAgentRun(run);
			pianolaNewTabSpawns.observeRun(saved);
			broadcastRunUpdated(saved);
			return saved;
		},
		appendAgentRunEvent: (event) => {
			const saved = appendAgentRunEvent(event);
			broadcastEventAppended(saved);
			return saved;
		},
		findActiveRunBySession,
		enrich: options.enrich ?? buildEnrichHook({}),
		preparePrompt: options.preparePrompt ?? redactPrompt,
		log: (level, message, error) => {
			logger[level](`${message}`, LOG_CONTEXT, error ? { error: String(error) } : undefined);
		},
	});

	processManager.on('spawn', (config: ProcessConfig) => {
		nativeCurrentTurns.spawning(config.sessionId);
		const run = service.captureSpawn({
			sessionId: config.sessionId,
			transcriptBoundaryId: config.transcriptBoundaryId,
			toolType: config.toolType,
			cwd: config.cwd,
			tabId: config.tabId,
			agentSessionId: config.agentSessionId,
			prompt: config.prompt,
			worktreePath: config.projectPath,
		});
		if (run) nativeCurrentTurns.begin(run, config.transcriptBoundaryId);
		if (run)
			pianolaNewTabSpawns.captured(
				config.sessionId,
				run.id,
				config.pianolaDispatchId,
				config.pianolaQueueItemId
			);
	});

	processManager.on('session-id', (sessionId: string, agentSessionId: string) => {
		service.captureSessionAnnouncement(sessionId, agentSessionId);
		nativeCurrentTurns.announce(sessionId, agentSessionId);
	});

	processManager.on('agent-error', (sessionId: string, error: AgentError) => {
		service.captureError(sessionId, error);
	});

	processManager.on(
		'exit',
		(sessionId: string, code: number, signal?: number, settlement?: TurnSettlement) => {
			void service.captureExit({ sessionId, exitCode: code, signal, settlement });
		}
	);

	logger.info('AgentRun capture wired to ProcessManager', LOG_CONTEXT);
	return service;
}
