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

import type { AccountRegistry } from './account-registry';
import type { SafeSendFn } from '../utils/safe-send';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'account-env-injector';

interface SpawnEnv {
	[key: string]: string | undefined;
}

/**
 * Injects CLAUDE_CONFIG_DIR into spawn environment for account multiplexing.
 * Called by all code paths that spawn Claude Code agents.
 *
 * @param sessionId - The session ID being spawned
 * @param agentType - The agent type (only 'claude-code' is handled)
 * @param env - Mutable env object to inject into
 * @param accountRegistry - The account registry instance
 * @param accountId - Pre-assigned account ID (optional, auto-assigns if missing)
 * @param safeSend - Optional safeSend function to notify renderer of assignment
 * @returns The account ID used (or null if no accounts configured)
 */
export function injectAccountEnv(
	sessionId: string,
	agentType: string,
	env: SpawnEnv,
	accountRegistry: AccountRegistry,
	accountId?: string | null,
	safeSend?: SafeSendFn,
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
		const selected = defaultAccount ?? accountRegistry.selectNextAccount();
		if (!selected) return null;
		resolvedAccountId = selected.id;
	}

	const account = accountRegistry.get(resolvedAccountId);
	if (!account) return null;

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
