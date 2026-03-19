/**
 * Process event listeners module.
 * Handles all events emitted by ProcessManager and routes them appropriately.
 *
 * This module extracts the setupProcessListeners() logic from main/index.ts
 * into smaller, focused modules for better maintainability.
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessListenerDependencies } from './types';

// Import individual listener setup functions
import { setupForwardingListeners } from './forwarding-listeners';
import { setupDataListener } from './data-listener';
import { setupUsageListener } from './usage-listener';
import { setupSessionIdListener } from './session-id-listener';
import { setupErrorListener } from './error-listener';
import { setupStatsListener } from './stats-listener';
import { setupExitListener } from './exit-listener';
import { setupAccountUsageListener } from './account-usage-listener';

// Re-export types for consumers
export type { ProcessListenerDependencies, ParticipantInfo } from './types';

/**
 * Sets up all process event listeners.
 * This is the main entry point that orchestrates all listener modules.
 *
 * @param processManager - The ProcessManager instance to attach listeners to
 * @param deps - Dependencies for the listeners
 */
export function setupProcessListeners(
	processManager: ProcessManager,
	deps: ProcessListenerDependencies
): void {
	// Simple forwarding listeners (slash-commands, thinking-chunk, tool-execution, stderr, command-exit)
	setupForwardingListeners(processManager, deps);

	// Data output listener (with group chat buffering and web broadcast)
	setupDataListener(processManager, deps);

	// Usage statistics listener (with group chat participant/moderator updates)
	setupUsageListener(processManager, deps);

	// Session ID listener (with group chat participant/moderator storage)
	setupSessionIdListener(processManager, deps);

	// Agent error listener (with optional account throttle/auth recovery handling + provider failover)
	const providerErrorTracker = deps.getProviderErrorTracker?.() ?? undefined;
	setupErrorListener(
		processManager,
		deps,
		deps.getAccountRegistry
			? {
					getAccountRegistry: deps.getAccountRegistry,
					getThrottleHandler: deps.getThrottleHandler ?? (() => null),
					getAuthRecovery: deps.getAuthRecovery ?? (() => null),
				}
			: undefined,
		providerErrorTracker
	);

	// Reset provider error tracking on successful query completion
	if (providerErrorTracker) {
		processManager.on('query-complete', (sessionId: string) => {
			providerErrorTracker.clearSession(sessionId);
		});
	}

	// Stats/query-complete listener
	setupStatsListener(processManager, deps);

	// Exit listener (with group chat routing, recovery, and synthesis)
	setupExitListener(processManager, deps);

	// Account usage listener (per-account token aggregation for limit tracking)
	if (deps.getAccountRegistry) {
		setupAccountUsageListener(processManager, {
			getAccountRegistry: deps.getAccountRegistry,
			getStatsDB: deps.getStatsDB,
			safeSend: deps.safeSend,
			logger: deps.logger,
		});
	}
}
