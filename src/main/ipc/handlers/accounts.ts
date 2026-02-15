/**
 * Account Multiplexing IPC Handlers
 *
 * Registers IPC handlers for all account management operations:
 * - CRUD operations for account profiles
 * - Session-to-account assignments
 * - Usage queries (windowed token consumption)
 * - Throttle event queries (capacity planning)
 * - Switch configuration management
 * - Account selection (default, next available)
 */

import { ipcMain } from 'electron';
import type { AccountRegistry } from '../../accounts/account-registry';
import type { AccountSwitcher } from '../../accounts/account-switcher';
import type { AccountSwitchConfig, AccountSwitchEvent } from '../../../shared/account-types';
import { getStatsDB } from '../../stats';
import { logger } from '../../utils/logger';
import {
	validateBaseClaudeDir,
	discoverExistingAccounts,
	createAccountDirectory,
	validateAccountSymlinks,
	repairAccountSymlinks,
	readAccountEmail,
	buildLoginCommand,
	removeAccountDirectory,
	validateRemoteAccountDir,
} from '../../accounts/account-setup';

const LOG_CONTEXT = '[Accounts]';

/**
 * Dependencies for account handlers
 */
export interface AccountHandlerDependencies {
	getAccountRegistry: () => AccountRegistry | null;
	getAccountSwitcher?: () => AccountSwitcher | null;
}

/**
 * Register all account multiplexing IPC handlers.
 */
export function registerAccountHandlers(deps: AccountHandlerDependencies): void {
	const { getAccountRegistry, getAccountSwitcher } = deps;

	/** Get the account registry or throw if not initialized */
	function requireRegistry(): AccountRegistry {
		const registry = getAccountRegistry();
		if (!registry) {
			throw new Error('Account registry not initialized');
		}
		return registry;
	}

	// --- Account CRUD ---

	ipcMain.handle('accounts:list', async () => {
		try {
			return requireRegistry().getAll();
		} catch (error) {
			logger.error('list accounts error', LOG_CONTEXT, { error: String(error) });
			return [];
		}
	});

	ipcMain.handle('accounts:get', async (_event, accountId: string) => {
		try {
			return requireRegistry().get(accountId);
		} catch (error) {
			logger.error('get account error', LOG_CONTEXT, { error: String(error) });
			return null;
		}
	});

	ipcMain.handle('accounts:add', async (_event, params: {
		name: string; email: string; configDir: string;
	}) => {
		try {
			const profile = requireRegistry().add(params);
			return { success: true, account: profile };
		} catch (error) {
			logger.error('add account error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('accounts:update', async (_event, accountId: string, updates: Record<string, unknown>) => {
		try {
			const updated = requireRegistry().update(accountId, updates);
			if (!updated) return { success: false, error: 'Account not found' };
			return { success: true, account: updated };
		} catch (error) {
			logger.error('update account error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('accounts:remove', async (_event, accountId: string) => {
		try {
			const removed = requireRegistry().remove(accountId);
			return { success: removed, error: removed ? undefined : 'Account not found' };
		} catch (error) {
			logger.error('remove account error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('accounts:set-default', async (_event, accountId: string) => {
		try {
			const updated = requireRegistry().update(accountId, { isDefault: true });
			return { success: !!updated };
		} catch (error) {
			logger.error('set default error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// --- Assignments ---

	ipcMain.handle('accounts:assign', async (_event, sessionId: string, accountId: string) => {
		try {
			const assignment = requireRegistry().assignToSession(sessionId, accountId);
			return { success: true, assignment };
		} catch (error) {
			logger.error('assign account error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('accounts:get-assignment', async (_event, sessionId: string) => {
		try {
			return requireRegistry().getAssignment(sessionId);
		} catch (error) {
			logger.error('get assignment error', LOG_CONTEXT, { error: String(error) });
			return null;
		}
	});

	ipcMain.handle('accounts:get-all-assignments', async () => {
		try {
			return requireRegistry().getAllAssignments();
		} catch (error) {
			logger.error('get all assignments error', LOG_CONTEXT, { error: String(error) });
			return [];
		}
	});

	// --- Usage Queries ---

	ipcMain.handle('accounts:get-usage', async (_event, accountId: string, windowStart: number, windowEnd: number) => {
		try {
			const db = getStatsDB();
			return db.getAccountUsageInWindow(accountId, windowStart, windowEnd);
		} catch (error) {
			logger.error('get usage error', LOG_CONTEXT, { error: String(error) });
			return null;
		}
	});

	ipcMain.handle('accounts:get-all-usage', async () => {
		try {
			const registry = requireRegistry();
			const db = getStatsDB();
			const accounts = registry.getAll();
			const now = Date.now();
			const results: Record<string, unknown> = {};

			for (const account of accounts) {
				const windowMs = account.tokenWindowMs || 5 * 60 * 60 * 1000;
				// Align to window boundaries from midnight
				const dayStart = new Date(now);
				dayStart.setHours(0, 0, 0, 0);
				const dayStartMs = dayStart.getTime();
				const windowsSinceDayStart = Math.floor((now - dayStartMs) / windowMs);
				const windowStart = dayStartMs + windowsSinceDayStart * windowMs;
				const windowEnd = windowStart + windowMs;

				const usage = db.getAccountUsageInWindow(account.id, windowStart, windowEnd);
				const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

				results[account.id] = {
					...usage,
					totalTokens,
					usagePercent: account.tokenLimitPerWindow > 0
						? Math.min(100, (totalTokens / account.tokenLimitPerWindow) * 100)
						: null,
					windowStart,
					windowEnd,
					account,
				};
			}
			return results;
		} catch (error) {
			logger.error('get all usage error', LOG_CONTEXT, { error: String(error) });
			return {};
		}
	});

	ipcMain.handle('accounts:get-throttle-events', async (_event, accountId?: string, since?: number) => {
		try {
			const db = getStatsDB();
			return db.getThrottleEvents(accountId, since);
		} catch (error) {
			logger.error('get throttle events error', LOG_CONTEXT, { error: String(error) });
			return [];
		}
	});

	// --- Switch Configuration ---

	ipcMain.handle('accounts:get-switch-config', async () => {
		try {
			return requireRegistry().getSwitchConfig();
		} catch (error) {
			logger.error('get switch config error', LOG_CONTEXT, { error: String(error) });
			return null;
		}
	});

	ipcMain.handle('accounts:update-switch-config', async (_event, updates: Partial<AccountSwitchConfig>) => {
		try {
			const updated = requireRegistry().updateSwitchConfig(updates);
			return { success: true, config: updated };
		} catch (error) {
			logger.error('update switch config error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// --- Account Selection ---

	ipcMain.handle('accounts:get-default', async () => {
		try {
			return requireRegistry().getDefaultAccount();
		} catch (error) {
			logger.error('get default error', LOG_CONTEXT, { error: String(error) });
			return null;
		}
	});

	ipcMain.handle('accounts:select-next', async (_event, excludeIds?: string[]) => {
		try {
			return requireRegistry().selectNextAccount(excludeIds);
		} catch (error) {
			logger.error('select next error', LOG_CONTEXT, { error: String(error) });
			return null;
		}
	});

	// --- Account Setup ---

	ipcMain.handle('accounts:validate-base-dir', async () => {
		try {
			return await validateBaseClaudeDir();
		} catch (error) {
			logger.error('validate base dir error', LOG_CONTEXT, { error: String(error) });
			return { valid: false, baseDir: '', errors: [String(error)] };
		}
	});

	ipcMain.handle('accounts:discover-existing', async () => {
		try {
			return await discoverExistingAccounts();
		} catch (error) {
			logger.error('discover accounts error', LOG_CONTEXT, { error: String(error) });
			return [];
		}
	});

	ipcMain.handle('accounts:create-directory', async (_event, accountName: string) => {
		try {
			return await createAccountDirectory(accountName);
		} catch (error) {
			logger.error('create directory error', LOG_CONTEXT, { error: String(error) });
			return { success: false, configDir: '', error: String(error) };
		}
	});

	ipcMain.handle('accounts:validate-symlinks', async (_event, configDir: string) => {
		try {
			return await validateAccountSymlinks(configDir);
		} catch (error) {
			logger.error('validate symlinks error', LOG_CONTEXT, { error: String(error) });
			return { valid: false, broken: [], missing: [] };
		}
	});

	ipcMain.handle('accounts:repair-symlinks', async (_event, configDir: string) => {
		try {
			return await repairAccountSymlinks(configDir);
		} catch (error) {
			logger.error('repair symlinks error', LOG_CONTEXT, { error: String(error) });
			return { repaired: [], errors: [String(error)] };
		}
	});

	ipcMain.handle('accounts:read-email', async (_event, configDir: string) => {
		try {
			return await readAccountEmail(configDir);
		} catch (error) {
			logger.error('read email error', LOG_CONTEXT, { error: String(error) });
			return null;
		}
	});

	ipcMain.handle('accounts:get-login-command', async (_event, configDir: string) => {
		try {
			return buildLoginCommand(configDir);
		} catch (error) {
			logger.error('get login command error', LOG_CONTEXT, { error: String(error) });
			return null;
		}
	});

	ipcMain.handle('accounts:remove-directory', async (_event, configDir: string) => {
		try {
			return await removeAccountDirectory(configDir);
		} catch (error) {
			logger.error('remove directory error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('accounts:validate-remote-dir', async (_event, params: {
		sshConfig: { host: string; user?: string; port?: number };
		configDir: string;
	}) => {
		try {
			return await validateRemoteAccountDir(params.sshConfig, params.configDir);
		} catch (error) {
			logger.error('validate remote dir error', LOG_CONTEXT, { error: String(error) });
			return { exists: false, hasAuth: false, symlinksValid: false, error: String(error) };
		}
	});

	// --- Session Cleanup ---

	ipcMain.handle('accounts:cleanup-session', async (_event, sessionId: string) => {
		try {
			const registry = getAccountRegistry();
			if (registry) {
				registry.removeAssignment(sessionId);
			}
			const switcher = getAccountSwitcher?.();
			if (switcher) {
				switcher.cleanupSession(sessionId);
			}
			return { success: true };
		} catch (error) {
			logger.error('cleanup session error', LOG_CONTEXT, { error: String(error), sessionId });
			return { success: false, error: String(error) };
		}
	});

	// --- Startup Reconciliation ---

	ipcMain.handle('accounts:reconcile-sessions', async (_event, activeSessionIds: string[]) => {
		try {
			const registry = requireRegistry();
			const idSet = new Set(activeSessionIds);

			// Remove stale assignments for sessions that no longer exist
			const removed = registry.reconcileAssignments(idSet);

			// For each active session with an assignment, validate the account still exists
			// Return corrections for sessions whose accounts were removed
			const corrections: Array<{
				sessionId: string;
				accountId: string | null;
				accountName: string | null;
				configDir: string | null;
				status: 'valid' | 'removed' | 'inactive';
			}> = [];

			for (const sessionId of activeSessionIds) {
				const assignment = registry.getAssignment(sessionId);
				if (!assignment) continue;

				const account = registry.get(assignment.accountId);
				if (!account) {
					// Account was removed — clear the assignment
					registry.removeAssignment(sessionId);
					corrections.push({
						sessionId,
						accountId: null,
						accountName: null,
						configDir: null,
						status: 'removed',
					});
				} else if (account.status !== 'active') {
					// Account exists but is throttled/disabled — still usable but warn
					corrections.push({
						sessionId,
						accountId: account.id,
						accountName: account.name,
						configDir: account.configDir,
						status: 'inactive',
					});
				} else {
					corrections.push({
						sessionId,
						accountId: account.id,
						accountName: account.name,
						configDir: account.configDir,
						status: 'valid',
					});
				}
			}

			return { success: true, removed, corrections };
		} catch (error) {
			logger.error('reconcile sessions error', LOG_CONTEXT, { error: String(error) });
			return { success: false, removed: 0, corrections: [], error: String(error) };
		}
	});

	// --- Account Switching ---

	ipcMain.handle('accounts:execute-switch', async (_event, params: {
		sessionId: string;
		fromAccountId: string;
		toAccountId: string;
		reason: AccountSwitchEvent['reason'];
		automatic: boolean;
	}) => {
		try {
			const switcher = getAccountSwitcher?.();
			if (!switcher) {
				return { success: false, error: 'Account switcher not initialized' };
			}
			const result = await switcher.executeSwitch(params);
			return { success: !!result, event: result };
		} catch (error) {
			logger.error('execute switch error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});
}
