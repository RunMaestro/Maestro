/**
 * Agent error listener.
 * Handles agent errors (auth expired, token exhaustion, rate limits, etc.).
 * When account multiplexing is active, triggers throttle handling for
 * rate_limited and auth_expired errors on sessions with account assignments.
 */

import type { ProcessManager } from '../process-manager';
import type { AgentError, ToolType } from '../../shared/types';
import type { ProcessListenerDependencies } from './types';
import { capabilitySnapshots } from '../agents/capability-snapshot';
import type { AccountThrottleHandler } from '../accounts/account-throttle-handler';
import type { AccountAuthRecovery } from '../accounts/account-auth-recovery';
import type { ProviderErrorTracker } from '../providers/provider-error-tracker';
import type { AccountRegistry } from '../accounts/account-registry';

/**
 * Sets up the agent-error listener.
 * Handles logging and forwarding of agent errors to renderer.
 * When account multiplexing is active:
 * - auth_expired errors → auth recovery (automatic re-login + respawn)
 * - rate_limited errors → throttle handler (account switching)
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
		getAuthRecovery?: () => AccountAuthRecovery | null;
	},
	getProviderErrorTracker?: () => ProviderErrorTracker | null
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

		// Feed into provider error tracker for failover detection (Virtuosos)
		const providerErrorTracker = getProviderErrorTracker?.();
		if (providerErrorTracker && agentError.agentId) {
			providerErrorTracker.recordError(sessionId, agentError.agentId as ToolType, {
				type: agentError.type,
				message: agentError.message,
				recoverable: agentError.recoverable,
			});
		}

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

		// Account multiplexing: route errors on sessions with account assignments
		if (!accountDeps) return;
		const accountRegistry = accountDeps.getAccountRegistry();
		if (!accountRegistry) return;
		const assignment = accountRegistry.getAssignment(sessionId);
		if (!assignment) return;

		if (agentError.type === 'auth_expired') {
			// Auth expired → attempt automatic re-login (kill → login → respawn).
			// Falls back to the throttle handler when recovery isn't available so
			// the user still gets a switch prompt instead of a dead session.
			const authRecovery = accountDeps.getAuthRecovery?.();
			if (authRecovery) {
				authRecovery.recoverAuth(sessionId, assignment.accountId).catch((err) => {
					logger.error('Auth recovery failed', 'AgentError', {
						error: String(err),
						sessionId,
					});
				});
				return;
			}
		}

		if (agentError.type === 'rate_limited' || agentError.type === 'auth_expired') {
			// Rate limited (or auth expired without recovery) → throttle handler
			// records the event and prompts/executes an account switch.
			const throttleHandler = accountDeps.getThrottleHandler();
			if (throttleHandler) {
				throttleHandler.handleThrottle({
					sessionId,
					accountId: assignment.accountId,
					errorType: agentError.type,
					errorMessage: agentError.message,
				});
			}
		}
	});
}
