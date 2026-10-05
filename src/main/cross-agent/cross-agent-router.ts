/**
 * @file cross-agent-router.ts
 * @description The desktop's binding of the cross-agent consult service.
 *
 * Dispatching a consult (the prompt, the budgets, the completion rule, Stop) lives in the
 * library: `createConsultService()` in `src/shared/maestro-lib/agents/consult.ts`. This module
 * keeps the names and signatures the IPC handler and its tests already use, and supplies what
 * is the desktop's own: a `ProcessManager`-backed runner (`consult-runner.ts`), agent
 * resolution through the detector, and the SSH store.
 *
 * One service instance serves the whole app, so `cancelCrossAgentRequestsForSource` sees every
 * consult a source agent has in flight, whichever IPC call started it.
 */

import type { ProcessManager } from '../process-manager';
import type { AgentDetector } from '../agents';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import type { CrossAgentRequest, CrossAgentResponseChunk } from '../../shared/crossAgentTypes';
import { CROSS_AGENT_SESSION_PREFIX } from '../../shared/crossAgentTypes';
import {
	createConsultService,
	type CrossAgentTargetSession,
} from '../../shared/maestro-lib/agents/consult';
import {
	buildCrossAgentPrompt,
	serializeTranscript,
} from '../../shared/maestro-lib/agents/consult-prompt';
import { createDesktopConsultRunner } from './consult-runner';

/**
 * Session-id prefix for the ephemeral processes cross-agent dispatch spawns.
 * Re-exported from `shared/crossAgentTypes` so the renderer's Process Monitor
 * can recognize a consult without importing from `src/main`.
 */
export { CROSS_AGENT_SESSION_PREFIX, buildCrossAgentPrompt, serializeTranscript };
export type { CrossAgentTargetSession };

const consultService = createConsultService();

/**
 * Stop every consult the given source agent still has in flight. Each is killed and settles
 * stamped `canceled`, not `error`, so the source agent's bubble reports that the user stopped it.
 *
 * @returns How many consults were cancelled.
 */
export function cancelCrossAgentRequestsForSource(sourceSessionId: string): number {
	return consultService.cancelForSource(sourceSessionId);
}

export interface StartCrossAgentRequestOptions {
	/** Concrete process manager (needed for both spawn and the data/exit events). */
	processManager: ProcessManager;
	/** Resolves an agent id to its executable config. */
	agentDetector: AgentDetector;
	/** SSH settings store; required only when the target opted into SSH. */
	sshStore: SshRemoteSettingsStore | null;
	/** Resolve the target agent's stored config from its session id. */
	getTargetSession: (sessionId: string) => CrossAgentTargetSession | null;
	/** Per-agent custom env vars (mirrors group chat's getCustomEnvVarsCallback). */
	getCustomEnvVars?: (toolType: string) => Record<string, string> | undefined;
	/** Per-agent config values (context window, model, effort, ...). */
	getAgentConfig?: (toolType: string) => Record<string, unknown> | undefined;
	/**
	 * When true, the user opted into read/write cross-agent mentions
	 * (`crossAgentMentionsWritable`), so the consult spawns with write access.
	 * Defaults to false: consults are read-only.
	 */
	writable?: boolean;
	/** Called with each response chunk; `done: true` marks completion/failure. */
	onChunk: (chunk: CrossAgentResponseChunk) => void;
}

/**
 * Dispatch a cross-agent request to the target agent without blocking the caller. Response
 * text is streamed back via `opts.onChunk`; the promise resolves once the spawn has been
 * initiated (or an error chunk emitted).
 */
export function startCrossAgentRequest(
	request: CrossAgentRequest,
	opts: StartCrossAgentRequestOptions
): Promise<void> {
	return consultService.start(request, {
		runner: createDesktopConsultRunner(opts.processManager, opts.sshStore),
		resolveAgent: (providerId) => opts.agentDetector.getAgent(providerId),
		sshStore: opts.sshStore,
		getTargetSession: opts.getTargetSession,
		getCustomEnvVars: opts.getCustomEnvVars,
		getAgentConfig: opts.getAgentConfig,
		writable: opts.writable,
		onChunk: opts.onChunk,
	});
}
