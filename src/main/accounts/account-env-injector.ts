/**
 * Account Environment Injector
 *
 * Shared utility for injecting CLAUDE_CONFIG_DIR into spawn environments.
 * Called by ALL code paths that spawn Claude Code agents:
 * - Standard process:spawn handler
 * - Group Chat participants and moderators
 * - Context Grooming
 * - Session resume
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AccountRegistry, AccountUsageStatsProvider } from './account-registry';
import type { SafeSendFn } from '../utils/safe-send';
import { syncCredentialsFromBase } from './account-setup';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'account-env-injector';

interface SpawnEnv {
	[key: string]: string | undefined;
}

/**
 * Injects CLAUDE_CONFIG_DIR into spawn environment for account multiplexing.
 * Called by all code paths that spawn Claude Code agents.
 *
 * Does NOT validate credential freshness — Claude Code handles its own
 * token refresh via the OAuth refresh token in .credentials.json.
 * If the refresh fails, the error listener catches the auth error.
 *
 * @param sessionId - The session ID being spawned
 * @param agentType - The agent type (only 'claude-code' is handled)
 * @param env - Mutable env object to inject into
 * @param accountRegistry - The account registry instance
 * @param accountId - Pre-assigned account ID (optional, auto-assigns if missing)
 * @param safeSend - Optional safeSend function to notify renderer of assignment
 * @param getStatsDB - Optional function to get stats DB for capacity-aware selection
 * @returns The account ID used (or null if no accounts configured)
 */
export function injectAccountEnv(
	sessionId: string,
	agentType: string,
	env: SpawnEnv,
	accountRegistry: AccountRegistry,
	accountId?: string | null,
	safeSend?: SafeSendFn,
	getStatsDB?: () => AccountUsageStatsProvider | null,
): string | null {
	if (agentType !== 'claude-code') return null;

	// If CLAUDE_CONFIG_DIR is already explicitly set in customEnvVars, respect it
	if (env.CLAUDE_CONFIG_DIR) {
		logger.info('CLAUDE_CONFIG_DIR already set, skipping account injection', LOG_CONTEXT, { sessionId });
		return null;
	}

	const accounts = accountRegistry.getAll().filter(a => a.status === 'active');
	if (accounts.length === 0) return null;

	// Use provided accountId, check for existing assignment, or auto-assign
	let resolvedAccountId = accountId;
	if (!resolvedAccountId) {
		// Check for existing assignment (e.g., session resume)
		const existingAssignment = accountRegistry.getAssignment(sessionId);
		if (existingAssignment) {
			const existingAccount = accountRegistry.get(existingAssignment.accountId);
			if (existingAccount && existingAccount.status === 'active') {
				resolvedAccountId = existingAssignment.accountId;
				logger.info(`Reusing existing assignment for session ${sessionId}`, LOG_CONTEXT);
			}
		}
	}
	if (!resolvedAccountId) {
		const defaultAccount = accountRegistry.getDefaultAccount();
		const statsDB = getStatsDB?.() ?? undefined;
		const selected = defaultAccount ?? accountRegistry.selectNextAccount([], statsDB ?? undefined);
		if (!selected) return null;
		resolvedAccountId = selected.id;
	}

	const account = accountRegistry.get(resolvedAccountId);
	if (!account) return null;

	// Ensure credentials exist in the account dir before spawning.
	// If missing, attempt a best-effort sync from base ~/.claude dir.
	const credPath = path.join(account.configDir, '.credentials.json');
	if (!fs.existsSync(credPath)) {
		logger.info('No .credentials.json in account dir, attempting sync from base', LOG_CONTEXT, {
			sessionId, configDir: account.configDir,
		});
		// Fire-and-forget — don't block spawn on this
		syncCredentialsFromBase(account.configDir).then((result) => {
			if (result.success) {
				logger.info('Auto-synced credentials from base dir', LOG_CONTEXT);
			} else {
				logger.warn(`Credential sync failed: ${result.error}`, LOG_CONTEXT);
			}
		}).catch(() => {});
	}

	// Inject the env var
	env.CLAUDE_CONFIG_DIR = account.configDir;

	// Create/update assignment
	accountRegistry.assignToSession(sessionId, resolvedAccountId);

	// Notify renderer if safeSend is available
	if (safeSend) {
		safeSend('account:assigned', {
			sessionId,
			accountId: resolvedAccountId,
			accountName: account.name,
		});
	}

	logger.info(`Assigned account ${account.name} to session ${sessionId}`, LOG_CONTEXT);
	return resolvedAccountId;
}
