/**
 * Account Environment Injector
 *
 * Shared utility for injecting the provider's config-dir env var
 * (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_DATA_HOME for opencode) into spawn
 * environments. Called by ALL code paths that spawn multiplexable agents:
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
import { getAccountProviderMeta, isMultiplexingCapable } from '../../shared/accountProviderMeta';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = 'account-env-injector';

interface SpawnEnv {
	[key: string]: string | undefined;
}

/**
 * Injects the provider's config-dir env var into the spawn environment for
 * account multiplexing. Called by all code paths that spawn multiplexable agents.
 * Providers without a config-dir env var (gemini-cli, factory-droid) and
 * non-multiplexable agents are left completely untouched.
 *
 * Does NOT validate credential freshness - providers handle their own
 * token refresh. If the refresh fails, the error listener catches the auth error.
 *
 * @param sessionId - The session ID being spawned
 * @param agentType - The agent type ('claude-code', 'codex', 'opencode')
 * @param env - Mutable env object to inject into
 * @param accountRegistry - The account registry instance
 * @param accountId - Pre-assigned account ID (optional, auto-assigns if missing)
 * @param safeSend - Optional safeSend function to notify renderer of assignment
 * @param getStatsDB - Optional function to get stats DB for capacity-aware selection
 * @param options - Controls whether the resolved account is recorded on the session
 */
export function injectAccountEnv(
	sessionId: string,
	agentType: string,
	env: SpawnEnv,
	accountRegistry: AccountRegistry,
	accountId?: string | null,
	safeSend?: SafeSendFn,
	getStatsDB?: () => AccountUsageStatsProvider | null,
	options?: { recordAssignment?: boolean }
): string | null {
	if (!isMultiplexingCapable(agentType)) return null;
	const meta = getAccountProviderMeta(agentType);
	const envVar = meta.envVar as string;

	// If the env var is already explicitly set in customEnvVars, respect it
	if (env[envVar]) {
		logger.info(`${envVar} already set, skipping account injection`, LOG_CONTEXT, {
			sessionId,
		});
		return null;
	}

	const accounts = accountRegistry
		.getAll()
		.filter((a) => a.status === 'active' && (a.agentType ?? 'claude-code') === agentType);
	if (accounts.length === 0) return null;

	// Use provided accountId, check for existing assignment, or auto-assign
	let resolvedAccountId = accountId;
	if (!resolvedAccountId) {
		// Check for existing assignment (e.g., session resume)
		const existingAssignment = accountRegistry.getAssignment(sessionId);
		if (existingAssignment) {
			const existingAccount = accountRegistry.get(existingAssignment.accountId);
			if (
				existingAccount &&
				existingAccount.status === 'active' &&
				(existingAccount.agentType ?? 'claude-code') === agentType
			) {
				resolvedAccountId = existingAssignment.accountId;
				logger.info(`Reusing existing assignment for session ${sessionId}`, LOG_CONTEXT);
			}
		}
	}
	if (!resolvedAccountId) {
		const defaultAccount = accountRegistry.getDefaultAccount(meta.agentType);
		const statsDB = getStatsDB?.() ?? undefined;
		const selected =
			defaultAccount ?? accountRegistry.selectNextAccount([], statsDB ?? undefined, meta.agentType);
		if (!selected) return null;
		resolvedAccountId = selected.id;
	}

	const account = accountRegistry.get(resolvedAccountId);
	if (
		!account ||
		account.status !== 'active' ||
		(account.agentType ?? 'claude-code') !== agentType
	) {
		return null;
	}

	// Ensure credentials exist in the account dir before spawning.
	// If missing, attempt a best-effort sync from the provider's base dir.
	const credPath = meta.credentialFile
		? path.join(account.configDir, ...meta.credentialFile.split('/'))
		: null;
	if (credPath && !fs.existsSync(credPath)) {
		logger.info('No credentials in account dir, attempting sync from base', LOG_CONTEXT, {
			sessionId,
			configDir: account.configDir,
		});
		// Fire-and-forget; don't block spawn on this
		syncCredentialsFromBase(account.configDir)
			.then((result) => {
				if (result.success) {
					logger.info('Auto-synced credentials from base dir', LOG_CONTEXT);
				} else {
					logger.warn(`Credential sync failed: ${result.error}`, LOG_CONTEXT);
				}
			})
			.catch((error) => {
				void captureException(error, {
					sessionId,
					accountId: account.id,
					configDir: account.configDir,
				});
				logger.warn(`Credential sync threw unexpectedly: ${String(error)}`, LOG_CONTEXT);
			});
	}

	// Inject the env var. This isolates accounts on Windows too: opencode's
	// XDG_DATA_HOME resolution goes through the npm xdg-basedir package, which
	// reads the env var with NO platform branch (verified 2026-07-14 against
	// sst/opencode packages/core/src/global.ts + sindresorhus/xdg-basedir), and
	// CLAUDE_CONFIG_DIR/CODEX_HOME are documented cross-platform overrides.
	env[envVar] = account.configDir;

	// Create/update assignment
	if (options?.recordAssignment !== false) {
		accountRegistry.assignToSession(sessionId, resolvedAccountId);
	}

	// Notify renderer if safeSend is available
	if (safeSend) {
		safeSend('account:assigned', {
			sessionId,
			accountId: resolvedAccountId,
			accountName: account.name,
		});
	}

	logger.info(`Assigned account ${account.id} to session ${sessionId}`, LOG_CONTEXT);
	return resolvedAccountId;
}
