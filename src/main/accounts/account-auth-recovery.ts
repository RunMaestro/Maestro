/**
 * Account Auth Recovery Service
 *
 * Orchestrates automatic re-authentication when an agent encounters
 * an expired OAuth token:
 * 1. Kills the failed agent process
 * 2. Spawns the provider's login command with the account's config-dir env var
 * 3. Browser opens for OAuth — user clicks "Authorize"
 * 4. Credentials are refreshed in the account directory
 * 5. Sends respawn event to renderer (reuses account:switch-respawn channel)
 *
 * Fallback: if login fails, attempts to sync credentials
 * from the provider's base directory.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ProcessManager } from '../process-manager/ProcessManager';
import type { AccountRegistry } from './account-registry';
import type { AgentDetector } from '../agents';
import type { SafeSendFn } from '../utils/safe-send';
import { syncCredentialsFromBase } from './account-setup';
import { getAccountProviderMeta, inferProviderFromDir } from '../../shared/accountProviderMeta';
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

			// 4. Attempt the provider's login command (claude login / codex login / opencode auth login)
			const meta = getAccountProviderMeta(account.agentType);
			const loginSuccess = await this.runProviderLogin(account.agentType, account.configDir);

			if (loginSuccess) {
				return this.handleLoginSuccess(sessionId, accountId, account.configDir, account.name);
			}

			// 5. Fallback: sync credentials from the provider's base directory
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

			const manualCommand = meta.buildLoginCommand
				? meta.buildLoginCommand(account.configDir)
				: `re-authenticate ${meta.displayName}`;
			this.safeSend('account:auth-recovery-failed', {
				sessionId,
				accountId,
				accountName: account.name,
				error: `Authentication failed. Please run "${manualCommand}" manually in a terminal.`,
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
	 * Spawn the provider's login command with the account's config-dir env var.
	 * Opens a browser for OAuth. Returns true if login exited successfully.
	 * Providers without a login flow (gemini-cli, factory-droid) resolve false
	 * so recovery falls through to credential sync / manual instructions.
	 */
	private async runProviderLogin(agentType: string, configDir: string): Promise<boolean> {
		const meta = getAccountProviderMeta(agentType);
		if (!meta.loginSpawn || !meta.envVar) {
			logger.info(`No automated login flow for ${meta.displayName}, skipping`, LOG_CONTEXT);
			return false;
		}
		const envVar = meta.envVar;

		// Resolve the provider binary path
		const agent = await this.agentDetector.getAgent(meta.agentType);
		const binary = agent?.path ?? agent?.command ?? meta.loginSpawn.binary;

		logger.info(`Spawning ${meta.displayName} login with binary: ${binary}`, LOG_CONTEXT, {
			configDir,
		});

		return new Promise<boolean>((resolve) => {
			const child = spawn(binary, meta.loginSpawn!.args, {
				env: {
					...process.env,
					[envVar]: configDir,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let stderr = '';

			child.stdout?.on('data', (data) => {
				logger.debug(`login stdout: ${data.toString().trim()}`, LOG_CONTEXT);
			});

			child.stderr?.on('data', (data) => {
				stderr += data.toString();
				logger.debug(`login stderr: ${data.toString().trim()}`, LOG_CONTEXT);
			});

			// Timeout: if user doesn't authorize in time
			const timeout = setTimeout(() => {
				logger.warn(`${meta.displayName} login timed out`, LOG_CONTEXT, { configDir });
				child.kill('SIGTERM');
				resolve(false);
			}, LOGIN_TIMEOUT_MS);

			child.on('close', async (code) => {
				clearTimeout(timeout);

				if (code === 0) {
					// Verify credentials were actually written
					const credsExist = await this.verifyCredentials(configDir);
					if (credsExist) {
						logger.info(`${meta.displayName} login succeeded`, LOG_CONTEXT, { configDir });
						resolve(true);
					} else {
						logger.warn(`${meta.displayName} login exited 0 but no credentials found`, LOG_CONTEXT);
						resolve(false);
					}
				} else {
					logger.warn(`login exited with code ${code}`, LOG_CONTEXT, {
						stderr: stderr.slice(0, 500),
					});
					resolve(false);
				}
			});

			child.on('error', (err) => {
				clearTimeout(timeout);
				logger.error(`login spawn error: ${err.message}`, LOG_CONTEXT);
				resolve(false);
			});
		});
	}

	/**
	 * Verify that the provider's credential file exists in the account
	 * directory after a login attempt.
	 */
	private async verifyCredentials(configDir: string): Promise<boolean> {
		const meta = getAccountProviderMeta(inferProviderFromDir(configDir));
		if (!meta.credentialFile) return false;
		try {
			const credPath = path.join(configDir, ...meta.credentialFile.split('/'));
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
		// Prompts are recorded under suffixed process IDs (`${base}-ai-${tab}`);
		// cleanup receives the base agent ID, so also match by prefix.
		for (const key of this.lastPrompts.keys()) {
			if (key.startsWith(`${sessionId}-`)) this.lastPrompts.delete(key);
		}
		for (const key of activeRecoveries.keys()) {
			if (key.startsWith(`${sessionId}-`)) activeRecoveries.delete(key);
		}
	}
}
