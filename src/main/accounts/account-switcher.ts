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
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = 'account-switcher';

/** Maximum time to wait for a killed process to emit exit (ms) */
const PROCESS_EXIT_TIMEOUT_MS = 3000;

export class AccountSwitcher {
	/** Tracks the last user prompt (and any images) per session for re-sending after switch */
	private lastPrompts = new Map<string, { prompt: string; images?: string[] }>();

	constructor(
		private processManager: ProcessManager,
		private accountRegistry: AccountRegistry,
		private safeSend: SafeSendFn
	) {}

	private async waitForProcessExit(sessionId: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const onExit = (exitedSessionId: string) => {
			if (exitedSessionId === sessionId || exitedSessionId.startsWith(`${sessionId}-ai`)) {
				resolve();
			}
		};
		this.processManager.on('exit', onExit);
		const timeout = setTimeout(resolve, PROCESS_EXIT_TIMEOUT_MS);

		await promise;
		clearTimeout(timeout);
		this.processManager.off('exit', onExit);
	}

	/**
	 * Record the last user prompt sent to a session.
	 * Called by the process spawn/write handlers so we can re-send after
	 * switching. Images (base64 data URLs) ride along so an image-bearing
	 * turn does not resume as text-only.
	 */
	recordLastPrompt(sessionId: string, prompt: string, images?: string[]): void {
		this.lastPrompts.set(sessionId, { prompt, images });
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
			const lastEntry = this.lastPrompts.get(sessionId);

			logger.info(
				`Switching session ${sessionId} from ${fromAccount?.id ?? fromAccountId} to ${toAccount.id}`,
				LOG_CONTEXT
			);

			// Notify renderer that switch is starting
			this.safeSend('account:switch-started', {
				sessionId,
				fromAccountId,
				toAccountId,
				toAccountName: toAccount.name,
			});

			// 1. Kill the current agent process(es). Manual switches pass the base
			// agent ID while running processes are keyed by suffixed IDs
			// (`${base}-ai-${tabId}`), so fall back to prefix matching; otherwise
			// an in-flight turn keeps running on the old account.
			let killed = this.processManager.kill(sessionId);
			if (!killed && typeof this.processManager.getAll === 'function') {
				for (const proc of this.processManager.getAll()) {
					if (proc.sessionId.startsWith(`${sessionId}-ai`)) {
						if (this.processManager.kill(proc.sessionId)) killed = true;
					}
				}
			}
			if (!killed) {
				logger.warn('Could not kill process (may have already exited)', LOG_CONTEXT, { sessionId });
			}

			if (killed) {
				await this.waitForProcessExit(sessionId);
			}

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
				lastPrompt: lastEntry?.prompt ?? null,
				lastImages: lastEntry?.images ?? null,
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
				from: fromAccount?.id,
				to: toAccount.id,
				reason,
			});

			return switchEvent;
		} catch (error) {
			void captureException(error, { sessionId, fromAccountId, toAccountId });
			logger.error('Account switch failed', LOG_CONTEXT, {
				error: String(error),
				sessionId,
				fromAccountId,
				toAccountId,
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

	/** Clean up tracking data when a session is closed. Receives the base agent
	 *  ID; prompts are recorded under suffixed process IDs (`${base}-ai-${tab}`),
	 *  so match by prefix as well as exact key. */
	cleanupSession(sessionId: string): void {
		this.lastPrompts.delete(sessionId);
		for (const key of this.lastPrompts.keys()) {
			if (key.startsWith(`${sessionId}-`)) this.lastPrompts.delete(key);
		}
	}
}
