import { registerDiscoveryHandlers } from './discovery';
import { registerDashboardHandlers } from './dashboard';
import { registerLifecycleHandlers } from './lifecycle';
import { registerContributionStartHandlers } from './contributionStart';
import { registerContributionFinishHandlers } from './contributionFinish';
import { registerSyncHandlers } from './sync';
import { logHandlersRegistered, SymphonyHandlerDependencies } from './shared';

export type { SymphonyHandlerDependencies } from './shared';

/**
 * Register all Symphony IPC handlers.
 *
 * Handlers for fetching Symphony registry, GitHub issues with runmaestro.ai
 * label, managing contributions, and coordinating contribution runs, split
 * by domain across this directory:
 * - discovery.ts: getRegistry, getIssues, getIssueCounts (registry/issue browsing)
 * - dashboard.ts: getState, getActive, getCompleted, getStats
 * - lifecycle.ts: registerActive, updateStatus, complete, cancel (state transitions
 *   for an already-started contribution)
 * - contributionStart.ts: start, cloneRepo, startContribution (kick off a contribution)
 * - contributionFinish.ts: createDraftPR, fetchDocumentContent, manualCredit
 *   (wrap up or credit a contribution)
 * - sync.ts: checkPRStatuses, syncContribution, clearCache
 *
 * Cache Strategy:
 * - Registry cached with 2-hour TTL
 * - Issues cached with 5-minute TTL (change frequently)
 * - Force refresh bypasses cache
 */
export function registerSymphonyHandlers(deps: SymphonyHandlerDependencies): void {
	registerDiscoveryHandlers(deps);
	registerDashboardHandlers(deps);
	registerLifecycleHandlers(deps);
	registerContributionStartHandlers(deps);
	registerContributionFinishHandlers(deps);
	registerSyncHandlers(deps);

	logHandlersRegistered();
}
