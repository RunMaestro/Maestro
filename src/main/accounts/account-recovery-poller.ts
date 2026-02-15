/**
 * Account Recovery Poller
 *
 * Timer-based service that proactively checks whether throttled accounts
 * have passed their rate-limit window and can be recovered to active status.
 *
 * This solves the "all accounts exhausted" deadlock: when every configured
 * account is throttled, no usage events fire (no agents running), so the
 * passive recovery in account-usage-listener never triggers. This poller
 * runs independently on a fixed interval.
 */

import type { AccountRegistry } from './account-registry';
import type { AccountProfile } from '../../shared/account-types';
import { DEFAULT_TOKEN_WINDOW_MS } from '../../shared/account-types';
import type { SafeSendFn } from '../utils/safe-send';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'account-recovery-poller';

/** How often to check throttled accounts (ms) */
const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 minute

/** Minimum time after throttle before considering recovery (safety margin) */
const RECOVERY_MARGIN_MS = 30_000; // 30 seconds past window

export interface AccountRecoveryPollerDeps {
	accountRegistry: AccountRegistry;
	safeSend: SafeSendFn;
}

export class AccountRecoveryPoller {
	private timer: ReturnType<typeof setInterval> | null = null;
	private pollIntervalMs: number;
	private deps: AccountRecoveryPollerDeps;

	constructor(deps: AccountRecoveryPollerDeps, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
		this.deps = deps;
		this.pollIntervalMs = pollIntervalMs;
	}

	/**
	 * Start the poller. Safe to call multiple times (idempotent).
	 */
	start(): void {
		if (this.timer) return;

		logger.info('Starting account recovery poller', LOG_CONTEXT, {
			intervalMs: this.pollIntervalMs,
		});

		// Run immediately on start, then on interval
		this.poll();
		this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
	}

	/**
	 * Stop the poller. Safe to call when not running.
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			logger.info('Stopped account recovery poller', LOG_CONTEXT);
		}
	}

	/**
	 * Check all throttled accounts and recover those past their window.
	 * Returns the list of recovered account IDs.
	 */
	poll(): string[] {
		const { accountRegistry, safeSend } = this.deps;
		const now = Date.now();
		const recovered: string[] = [];

		const throttledAccounts = accountRegistry.getAll().filter(
			(a: AccountProfile) => a.status === 'throttled' && a.lastThrottledAt > 0
		);

		if (throttledAccounts.length === 0) return recovered;

		for (const account of throttledAccounts) {
			const windowMs = account.tokenWindowMs || DEFAULT_TOKEN_WINDOW_MS;
			const timeSinceThrottle = now - account.lastThrottledAt;

			// Recover if enough time has passed (window + safety margin)
			if (timeSinceThrottle > windowMs + RECOVERY_MARGIN_MS) {
				accountRegistry.setStatus(account.id, 'active');
				recovered.push(account.id);

				logger.info(`Account ${account.name} recovered from throttle via poller`, LOG_CONTEXT, {
					accountId: account.id,
					timeSinceThrottleMs: timeSinceThrottle,
					windowMs,
				});

				safeSend('account:status-changed', {
					accountId: account.id,
					accountName: account.name,
					oldStatus: 'throttled',
					newStatus: 'active',
					recoveredBy: 'poller',
				});
			}
		}

		// If any accounts recovered, also broadcast a recovery summary event
		// so the renderer can auto-resume paused sessions
		if (recovered.length > 0) {
			const totalAccounts = accountRegistry.getAll().length;
			const stillThrottled = throttledAccounts.length - recovered.length;

			safeSend('account:recovery-available', {
				recoveredAccountIds: recovered,
				recoveredCount: recovered.length,
				stillThrottledCount: stillThrottled,
				totalAccounts,
			});

			logger.info(`Recovery poll: ${recovered.length} account(s) recovered`, LOG_CONTEXT, {
				recovered: recovered.length,
				stillThrottled,
			});
		}

		return recovered;
	}

	/** Check if the poller is currently running */
	isRunning(): boolean {
		return this.timer !== null;
	}
}
