/**
 * Wire the AgentRunCaptureService to the ProcessManager lifecycle (F1).
 *
 * Symmetric with setupExitListener: `spawn` creates the run, `exit` settles it.
 * Both handlers are guarded inside the service, so a capture failure never
 * disturbs spawning or the Cue/exit path. Terminal and group-chat sessions are
 * filtered inside the service (ISC-1.7).
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessConfig } from '../process-manager/types';
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
		getAgentRun,
		upsertAgentRun: (run) => {
			const saved = upsertAgentRun(run);
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
		service.captureSpawn({
			sessionId: config.sessionId,
			toolType: config.toolType,
			cwd: config.cwd,
			tabId: config.tabId,
			prompt: config.prompt,
			worktreePath: config.projectPath,
		});
	});

	processManager.on('exit', (sessionId: string, code: number) => {
		void service.captureExit({ sessionId, exitCode: code });
	});

	logger.info('AgentRun capture wired to ProcessManager', LOG_CONTEXT);
	return service;
}
