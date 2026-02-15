/**
 * Account Switcher Service
 *
 * Orchestrates the actual account switch for a session:
 * 1. Kills the current agent process
 * 2. Updates the session's account assignment
 * 3. Sends respawn event to renderer (which handles spawn with --resume + new CLAUDE_CONFIG_DIR)
 * 4. Notifies renderer of switch completion
 */

import type { ProcessManager } from '../process-manager/ProcessManager';
import type { AccountRegistry } from './account-registry';
import type { AccountSwitchEvent } from '../../shared/account-types';
import type { SafeSendFn } from '../utils/safe-send';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'account-switcher';

/** Delay between killing old process and sending respawn event (ms) */
const SWITCH_DELAY_MS = 1000;

export class AccountSwitcher {
	/** Tracks the last user prompt per session for re-sending after switch */
	private lastPrompts = new Map<string, string>();

	constructor(
		private processManager: ProcessManager,
		private accountRegistry: AccountRegistry,
		private safeSend: SafeSendFn,
	) {}

	/**
	 * Record the last user prompt sent to a session.
	 * Called by the process write handler so we can re-send after switching.
	 */
	recordLastPrompt(sessionId: string, prompt: string): void {
		this.lastPrompts.set(sessionId, prompt);
	}

	/**
	 * Execute an account switch for a session.
	 * 1. Kill the current agent process
	 * 2. Update the session's account assignment
	 * 3. Restart with --resume using the new account's CLAUDE_CONFIG_DIR
	 * 4. Re-send the last user prompt
	 *
	 * Returns the switch event on success, or null on failure.
	 */
	async executeSwitch(params: {
		sessionId: string;
		fromAccountId: string;
		toAccountId: string;
		reason: AccountSwitchEvent['reason'];
		automatic: boolean;
	}): Promise<AccountSwitchEvent | null> {
		const { sessionId, fromAccountId, toAccountId, reason, automatic } = params;

		try {
			const toAccount = this.accountRegistry.get(toAccountId);
			if (!toAccount) {
				logger.error('Target account not found', LOG_CONTEXT, { toAccountId });
				return null;
			}

			const fromAccount = this.accountRegistry.get(fromAccountId);
			const lastPrompt = this.lastPrompts.get(sessionId);

			logger.info(`Switching session ${sessionId} from ${fromAccount?.name ?? fromAccountId} to ${toAccount.name}`, LOG_CONTEXT);

			// Notify renderer that switch is starting
			this.safeSend('account:switch-started', {
				sessionId,
				fromAccountId,
				toAccountId,
				toAccountName: toAccount.name,
			});

			// 1. Kill the current agent process
			const killed = this.processManager.kill(sessionId);
			if (!killed) {
				logger.warn('Could not kill process (may have already exited)', LOG_CONTEXT, { sessionId });
			}

			// Wait for process cleanup
			await new Promise(resolve => setTimeout(resolve, SWITCH_DELAY_MS));

			// 2. Update the account assignment
			this.accountRegistry.assignToSession(sessionId, toAccountId);

			// 3. Send respawn event to renderer with the new account config.
			// The renderer has access to the full session config and will call process:spawn
			// with the correct parameters including --resume and the new CLAUDE_CONFIG_DIR.
			this.safeSend('account:switch-respawn', {
				sessionId,
				toAccountId,
				toAccountName: toAccount.name,
				configDir: toAccount.configDir,
				lastPrompt: lastPrompt ?? null,
				reason,
			});

			// 4. Create the switch event
			const switchEvent: AccountSwitchEvent = {
				sessionId,
				fromAccountId,
				toAccountId,
				reason,
				automatic,
				timestamp: Date.now(),
			};

			// Notify renderer that switch is complete
			this.safeSend('account:switch-completed', {
				...switchEvent,
				fromAccountName: fromAccount?.name ?? fromAccountId,
				toAccountName: toAccount.name,
			});

			logger.info(`Account switch completed for session ${sessionId}`, LOG_CONTEXT, {
				from: fromAccount?.name, to: toAccount.name, reason,
			});

			return switchEvent;

		} catch (error) {
			logger.error('Account switch failed', LOG_CONTEXT, {
				error: String(error), sessionId, fromAccountId, toAccountId,
			});

			this.safeSend('account:switch-failed', {
				sessionId,
				fromAccountId,
				toAccountId,
				error: String(error),
			});

			return null;
		}
	}

	/** Clean up tracking data when a session is closed */
	cleanupSession(sessionId: string): void {
		this.lastPrompts.delete(sessionId);
	}
}
