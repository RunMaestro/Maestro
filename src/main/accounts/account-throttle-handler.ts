/**
 * Account Throttle Handler
 *
 * Handles throttle/rate-limit detection for account multiplexing.
 * When a throttle is detected:
 * 1. Records the throttle event in stats DB
 * 2. Marks the account as throttled
 * 3. Determines if auto-switch should occur
 * 4. Notifies the renderer with switch recommendation
 */

import type { AccountRegistry } from './account-registry';
import type { StatsDB } from '../stats';
import { DEFAULT_TOKEN_WINDOW_MS } from '../../shared/account-types';
import { getWindowBounds } from './account-utils';

const LOG_CONTEXT = 'account-throttle';

export interface ThrottleContext {
	sessionId: string;
	accountId: string;
	errorType: string;
	errorMessage: string;
}

export class AccountThrottleHandler {
	constructor(
		private accountRegistry: AccountRegistry,
		private getStatsDB: () => StatsDB,
		private safeSend: (channel: string, ...args: unknown[]) => void,
		private logger: {
			info: (message: string, context: string, data?: Record<string, unknown>) => void;
			error: (message: string, context: string, data?: Record<string, unknown>) => void;
			warn: (message: string, context: string, data?: Record<string, unknown>) => void;
		},
	) {}

	/**
	 * Called when a rate_limited or similar error is detected on a session
	 * that has an account assignment.
	 */
	handleThrottle(context: ThrottleContext): void {
		const { sessionId, accountId, errorType, errorMessage } = context;

		try {
			// 1. Look up the account
			const account = this.accountRegistry.get(accountId);
			if (!account) return;

			const statsDb = this.getStatsDB();
			if (!statsDb.isReady()) return;

			const windowMs = account.tokenWindowMs || DEFAULT_TOKEN_WINDOW_MS;
			const now = Date.now();
			const { start, end } = getWindowBounds(now, windowMs);

			// Get tokens at time of throttle
			const usage = statsDb.getAccountUsageInWindow(accountId, start, end);
			const tokensAtThrottle = usage.inputTokens + usage.outputTokens
				+ usage.cacheReadTokens + usage.cacheCreationTokens;

			// Record throttle event
			statsDb.insertThrottleEvent(
				accountId, sessionId, errorType,
				tokensAtThrottle, start, end
			);

			// 2. Mark account as throttled
			this.accountRegistry.setStatus(accountId, 'throttled');
			this.logger.warn(`Account ${account.name} throttled`, LOG_CONTEXT, {
				reason: errorType, tokens: tokensAtThrottle, sessionId,
			});

			// 3. Determine if auto-switch should occur
			const switchConfig = this.accountRegistry.getSwitchConfig();
			if (!switchConfig.enabled) {
				// Auto-switching disabled — just notify
				this.safeSend('account:throttled', {
					accountId,
					accountName: account.name,
					sessionId,
					reason: errorType,
					message: errorMessage,
					tokensAtThrottle,
					autoSwitchAvailable: false,
				});
				return;
			}

			// 4. Find next available account
			const nextAccount = this.accountRegistry.selectNextAccount([accountId]);
			if (!nextAccount) {
				// No alternative accounts available
				this.safeSend('account:throttled', {
					accountId,
					accountName: account.name,
					sessionId,
					reason: errorType,
					message: errorMessage,
					tokensAtThrottle,
					autoSwitchAvailable: false,
					noAlternatives: true,
				});
				this.logger.warn('No alternative accounts available for switching', LOG_CONTEXT);
				return;
			}

			// 5. Notify renderer with switch recommendation
			if (switchConfig.promptBeforeSwitch) {
				// Prompt mode: ask user to confirm switch
				this.safeSend('account:switch-prompt', {
					sessionId,
					fromAccountId: accountId,
					fromAccountName: account.name,
					toAccountId: nextAccount.id,
					toAccountName: nextAccount.name,
					reason: errorType,
					tokensAtThrottle,
				});
			} else {
				// Auto mode: tell renderer to execute switch immediately
				this.safeSend('account:switch-execute', {
					sessionId,
					fromAccountId: accountId,
					fromAccountName: account.name,
					toAccountId: nextAccount.id,
					toAccountName: nextAccount.name,
					reason: errorType,
					automatic: true,
				});
			}

		} catch (error) {
			this.logger.error('Failed to handle throttle', LOG_CONTEXT, {
				error: String(error), sessionId, accountId,
			});
		}
	}
}
