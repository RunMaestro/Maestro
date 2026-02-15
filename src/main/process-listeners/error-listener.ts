/**
 * Agent error listener.
 * Handles agent errors (auth expired, token exhaustion, rate limits, etc.).
 * When account multiplexing is active, triggers throttle handling for
 * rate_limited and auth_expired errors on sessions with account assignments.
 */

import type { ProcessManager } from '../process-manager';
import type { AgentError } from '../../shared/types';
import type { ProcessListenerDependencies } from './types';
import { capabilitySnapshots } from '../agents/capability-snapshot';
import type { AccountThrottleHandler } from '../accounts/account-throttle-handler';
import type { AccountRegistry } from '../accounts/account-registry';

/**
 * Sets up the agent-error listener.
 * Handles logging and forwarding of agent errors to renderer.
 * Optionally triggers throttle handling for account multiplexing.
 *
 * Side effect: when the classified error is `auth_expired`, mirrors the
 * status into the capability snapshot store so the Settings → Agents tab
 * flips to a yellow "Auth required" pill without a separate eager probe.
 */
export function setupErrorListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'safeSend' | 'logger'>,
	accountDeps?: {
		getAccountRegistry: () => AccountRegistry | null;
		getThrottleHandler: () => AccountThrottleHandler | null;
	}
): void {
	const { safeSend, logger } = deps;

	// Handle agent errors (auth expired, token exhaustion, rate limits, etc.)
	processManager.on('agent-error', (sessionId: string, agentError: AgentError) => {
		logger.info(`Agent error detected: ${agentError.type}`, 'AgentError', {
			sessionId,
			agentId: agentError.agentId,
			errorType: agentError.type,
			message: agentError.message,
			recoverable: agentError.recoverable,
		});
		safeSend('agent:error', sessionId, agentError);

		// Reactive capability classification: an auth-expired event means the
		// binary is present (otherwise we wouldn't have spawned it) but the
		// user needs to re-authenticate. Snapshot stays auth_required until a
		// subsequent successful detect / spawn clears it. When the spawn was
		// SSH-backed, the AgentError payload carries the remote UUID so the
		// per-remote pill flips, not the local one.
		if (agentError.type === 'auth_expired' && agentError.agentId) {
			capabilitySnapshots.markAuthRequired(
				agentError.agentId,
				agentError.message,
				agentError.sshRemoteId
			);
		}

		// Trigger throttle handling for rate-limited/auth-expired errors on sessions with accounts
		if (accountDeps && (agentError.type === 'rate_limited' || agentError.type === 'auth_expired')) {
			const accountRegistry = accountDeps.getAccountRegistry();
			const throttleHandler = accountDeps.getThrottleHandler();
			if (accountRegistry && throttleHandler) {
				const assignment = accountRegistry.getAssignment(sessionId);
				if (assignment) {
					throttleHandler.handleThrottle({
						sessionId,
						accountId: assignment.accountId,
						errorType: agentError.type,
						errorMessage: agentError.message,
					});
				}
			}
		}
	});
}
