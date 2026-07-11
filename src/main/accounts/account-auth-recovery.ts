/**
 * Account Auth Recovery Service
 *
 * Orchestrates automatic re-authentication when an agent encounters
 * an expired OAuth token:
 * 1. Kills the failed agent process
 * 2. Spawns `claude login` with the account's CLAUDE_CONFIG_DIR
 * 3. Browser opens for OAuth — user clicks "Authorize"
 * 4. Credentials are refreshed in the account directory
 * 5. Sends respawn event to renderer (reuses account:switch-respawn channel)
 *
 * Fallback: if `claude login` fails, attempts to sync credentials
 * from the base ~/.claude directory.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ProcessManager } from '../process-manager/ProcessManager';
import type { AccountRegistry } from './account-registry';
import type { AgentDetector } from '../agents';
import type { SafeSendFn } from '../utils/safe-send';
import { syncCredentialsFromBase } from './account-setup';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'account-auth-recovery';

/** Timeout for `claude login` to complete (user must authorize in browser) */
const LOGIN_TIMEOUT_MS = 120_000;

/** Delay between killing old process and starting login (ms) */
const KILL_DELAY_MS = 1000;

/** Set of session IDs currently undergoing auth recovery (prevents double-fire) */
const activeRecoveries = new Set<string>();

export class AccountAuthRecovery {
	/** Tracks the last user prompt per session for re-sending after recovery */
	private lastPrompts = new Map<string, string>();

	constructor(
		private processManager: ProcessManager,
		private accountRegistry: AccountRegistry,
		private agentDetector: AgentDetector,
		private safeSend: SafeSendFn
	) {}

	/**
	 * Record the last user prompt sent to a session.
	 * Called by the process write handler so we can re-send after recovery.
	 */
	recordLastPrompt(sessionId: string, prompt: string): void {
		this.lastPrompts.set(sessionId, prompt);
	}

	/**
	 * Check if a session is currently undergoing auth recovery.
	 */
	isRecovering(sessionId: string): boolean {
		return activeRecoveries.has(sessionId);
	}

	/**
	 * Main entry point: recover authentication for a session.
	 *
	 * @param sessionId - The session that hit an auth error
	 * @param accountId - The account assigned to that session
	 * @returns true if recovery succeeded and respawn was triggered
	 */
	async recoverAuth(sessionId: string, accountId: string): Promise<boolean> {
		// Prevent double-fire if error listener fires multiple times
		if (activeRecoveries.has(sessionId)) {
			logger.warn('Auth recovery already in progress for session', LOG_CONTEXT, { sessionId });
			return false;
		}

		activeRecoveries.add(sessionId);

		try {
			const account = this.accountRegistry.get(accountId);
			if (!account) {
				logger.error('Account not found for auth recovery', LOG_CONTEXT, { accountId });
				return false;
			}

			logger.info(`Starting auth recovery for account ${account.name}`, LOG_CONTEXT, {
				sessionId,
				accountId,
				configDir: account.configDir,
			});

			// 1. Mark account as expired
			this.accountRegistry.setStatus(accountId, 'expired');

			// 2. Kill the current agent process
			const killed = this.processManager.kill(sessionId);
			if (!killed) {
				logger.warn('Could not kill process (may have already exited)', LOG_CONTEXT, { sessionId });
			}

			// 3. Notify renderer that recovery is starting
			this.safeSend('account:auth-recovery-started', {
				sessionId,
				accountId,
				accountName: account.name,
			});

			// Wait for process cleanup
			await new Promise((resolve) => setTimeout(resolve, KILL_DELAY_MS));

			// 4. Attempt `claude login`
			const loginSuccess = await this.runClaudeLogin(account.configDir);

			if (loginSuccess) {
				return this.handleLoginSuccess(sessionId, accountId, account.configDir, account.name);
			}

			// 5. Fallback: sync credentials from base ~/.claude directory
			logger.info('Login failed, attempting credential sync from base dir', LOG_CONTEXT);
			const syncResult = await syncCredentialsFromBase(account.configDir);

			if (syncResult.success) {
				logger.info('Credential sync from base succeeded', LOG_CONTEXT);
				return this.handleLoginSuccess(sessionId, accountId, account.configDir, account.name);
			}

			// 6. All recovery failed
			logger.error('All auth recovery methods failed', LOG_CONTEXT, {
				sessionId,
				accountId,
				syncError: syncResult.error,
			});

			this.safeSend('account:auth-recovery-failed', {
				sessionId,
				accountId,
				accountName: account.name,
				error: 'Authentication failed. Please run "claude login" manually in a terminal.',
			});

			return false;
		} catch (error) {
			logger.error('Auth recovery threw unexpectedly', LOG_CONTEXT, {
				error: String(error),
				sessionId,
				accountId,
			});

			this.safeSend('account:auth-recovery-failed', {
				sessionId,
				accountId,
				error: String(error),
			});

			return false;
		} finally {
			activeRecoveries.delete(sessionId);
		}
	}

	/**
	 * Handle successful credential refresh: mark active, send respawn event.
	 */
	private handleLoginSuccess(
		sessionId: string,
		accountId: string,
		configDir: string,
		accountName: string
	): boolean {
		// Mark account as active again
		this.accountRegistry.setStatus(accountId, 'active');

		const lastPrompt = this.lastPrompts.get(sessionId);

		// Notify renderer that recovery completed
		this.safeSend('account:auth-recovery-completed', {
			sessionId,
			accountId,
			accountName,
		});

		// Reuse the switch-respawn channel — renderer already handles it
		this.safeSend('account:switch-respawn', {
			sessionId,
			toAccountId: accountId,
			toAccountName: accountName,
			configDir,
			lastPrompt: lastPrompt ?? null,
			reason: 'auth-recovery',
		});

		logger.info(`Auth recovery completed for account ${accountName}`, LOG_CONTEXT, {
			sessionId,
			accountId,
		});

		return true;
	}

	/**
	 * Spawn `claude login` with the account's CLAUDE_CONFIG_DIR.
	 * Opens a browser for OAuth. Returns true if login exited successfully.
	 */
	private async runClaudeLogin(configDir: string): Promise<boolean> {
		// Resolve the claude binary path
		const agent = await this.agentDetector.getAgent('claude-code');
		const claudeBinary = agent?.path ?? agent?.command ?? 'claude';

		logger.info(`Spawning claude login with binary: ${claudeBinary}`, LOG_CONTEXT, { configDir });

		return new Promise<boolean>((resolve) => {
			const child = spawn(claudeBinary, ['login'], {
				env: {
					...process.env,
					CLAUDE_CONFIG_DIR: configDir,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let stdout = '';
			let stderr = '';

			child.stdout?.on('data', (data) => {
				stdout += data.toString();
				logger.debug(`claude login stdout: ${data.toString().trim()}`, LOG_CONTEXT);
			});

			child.stderr?.on('data', (data) => {
				stderr += data.toString();
				logger.debug(`claude login stderr: ${data.toString().trim()}`, LOG_CONTEXT);
			});

			// Timeout: if user doesn't authorize in time
			const timeout = setTimeout(() => {
				logger.warn('claude login timed out', LOG_CONTEXT, { configDir });
				child.kill('SIGTERM');
				resolve(false);
			}, LOGIN_TIMEOUT_MS);

			child.on('close', async (code) => {
				clearTimeout(timeout);

				if (code === 0) {
					// Verify credentials were actually written
					const credsExist = await this.verifyCredentials(configDir);
					if (credsExist) {
						logger.info('claude login succeeded', LOG_CONTEXT, { configDir });
						resolve(true);
					} else {
						logger.warn('claude login exited 0 but no credentials found', LOG_CONTEXT);
						resolve(false);
					}
				} else {
					logger.warn(`claude login exited with code ${code}`, LOG_CONTEXT, {
						stderr: stderr.slice(0, 500),
					});
					resolve(false);
				}
			});

			child.on('error', (err) => {
				clearTimeout(timeout);
				logger.error(`claude login spawn error: ${err.message}`, LOG_CONTEXT);
				resolve(false);
			});
		});
	}

	/**
	 * Verify that .credentials.json exists in the account directory
	 * after a login attempt.
	 */
	private async verifyCredentials(configDir: string): Promise<boolean> {
		try {
			const credPath = path.join(configDir, '.credentials.json');
			await fs.access(credPath);
			return true;
		} catch {
			return false;
		}
	}

	/** Clean up tracking data when a session is closed */
	cleanupSession(sessionId: string): void {
		this.lastPrompts.delete(sessionId);
		activeRecoveries.delete(sessionId);
	}
}
