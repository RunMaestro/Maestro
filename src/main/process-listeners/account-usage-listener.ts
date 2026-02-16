/**
 * Account usage listener.
 * Aggregates per-session usage events into per-account usage windows
 * for limit tracking and prediction.
 */

import type { ProcessManager } from '../process-manager';
import type { AccountRegistry } from '../accounts/account-registry';
import type { StatsDB } from '../stats';
import type { UsageStats } from './types';
import { DEFAULT_TOKEN_WINDOW_MS } from '../../shared/account-types';
import { getWindowBounds } from '../accounts/account-utils';

const LOG_CONTEXT = 'account-usage-listener';

/**
 * Sets up the account usage listener that aggregates per-session usage events
 * into per-account usage windows for limit tracking and prediction.
 *
 * Only fires when usage events occur for sessions with account assignments,
 * so it has zero impact on sessions without accounts.
 */
export function setupAccountUsageListener(
	processManager: ProcessManager,
	deps: {
		getAccountRegistry: () => AccountRegistry | null;
		getStatsDB: () => StatsDB;
		safeSend: (channel: string, ...args: unknown[]) => void;
		logger: {
			info?: (message: string, context: string, data?: Record<string, unknown>) => void;
			error: (message: string, context: string, data?: Record<string, unknown>) => void;
			debug: (message: string, context: string, data?: Record<string, unknown>) => void;
		};
	}
): void {
	const { getAccountRegistry, getStatsDB, safeSend, logger } = deps;

	processManager.on('usage', (sessionId: string, usageStats: UsageStats) => {
		try {
			const accountRegistry = getAccountRegistry();
			if (!accountRegistry) return; // Account system not initialized

			// Look up the account assigned to this session
			const assignment = accountRegistry.getAssignment(sessionId);
			if (!assignment) return; // No account assigned — skip

			const account = accountRegistry.get(assignment.accountId);
			if (!account) return; // Account was deleted — skip

			const statsDb = getStatsDB();
			if (!statsDb.isReady()) return; // Stats DB not ready

			const windowMs = account.tokenWindowMs || DEFAULT_TOKEN_WINDOW_MS;
			const now = Date.now();
			const { start, end } = getWindowBounds(now, windowMs);

			// Aggregate tokens into the account's current window
			statsDb.upsertAccountUsageWindow(account.id, start, end, {
				inputTokens: usageStats.inputTokens || 0,
				outputTokens: usageStats.outputTokens || 0,
				cacheReadTokens: usageStats.cacheReadInputTokens || 0,
				cacheCreationTokens: usageStats.cacheCreationInputTokens || 0,
				costUsd: usageStats.totalCostUsd || 0,
			});

			// Read back aggregated window usage and broadcast to renderer
			const windowUsage = statsDb.getAccountUsageInWindow(account.id, start, end);
			const totalTokens = windowUsage.inputTokens + windowUsage.outputTokens
				+ windowUsage.cacheReadTokens + windowUsage.cacheCreationTokens;
			const limitTokens = account.tokenLimitPerWindow || 0;
			const usagePercent = limitTokens > 0
				? Math.min(100, (totalTokens / limitTokens) * 100)
				: null;

			// Broadcast usage update to renderer for real-time dashboard
			safeSend('account:usage-update', {
				accountId: account.id,
				usagePercent,
				totalTokens,
				inputTokens: windowUsage.inputTokens,
				outputTokens: windowUsage.outputTokens,
				cacheReadTokens: windowUsage.cacheReadTokens,
				cacheCreationTokens: windowUsage.cacheCreationTokens,
				limitTokens,
				windowStart: start,
				windowEnd: end,
				queryCount: windowUsage.queryCount,
				costUsd: windowUsage.costUsd,
			});

			// Check warning/auto-switch thresholds (only if limit is configured)
			if (limitTokens > 0 && usagePercent !== null) {
				const switchConfig = accountRegistry.getSwitchConfig();
				if (usagePercent >= switchConfig.warningThresholdPercent && usagePercent < switchConfig.autoSwitchThresholdPercent) {
					safeSend('account:limit-warning', {
						accountId: account.id,
						accountName: account.name,
						usagePercent,
						sessionId,
					});
				}

				if (usagePercent >= switchConfig.autoSwitchThresholdPercent) {
					safeSend('account:limit-reached', {
						accountId: account.id,
						accountName: account.name,
						usagePercent,
						sessionId,
					});
				}
			}

			// Auto-recover from throttle if window has advanced past throttle point
			if (account.status === 'throttled' && account.lastThrottledAt > 0) {
				const timeSinceThrottle = now - account.lastThrottledAt;
				if (timeSinceThrottle > windowMs) {
					accountRegistry.setStatus(account.id, 'active');
					safeSend('account:status-changed', {
						accountId: account.id,
						accountName: account.name,
						oldStatus: 'throttled',
						newStatus: 'active',
					});
					logger.info?.(`Account ${account.name} recovered from throttle`, LOG_CONTEXT);
				}
			}

			// Update the account's lastUsedAt
			accountRegistry.touchLastUsed(account.id);

		} catch (error) {
			logger.error('Failed to track account usage', LOG_CONTEXT, { error: String(error), sessionId });
		}
	});
}
