/**
 * Preload API for account multiplexing
 *
 * Provides the window.maestro.accounts namespace for:
 * - Account CRUD operations (list, get, add, update, remove)
 * - Session-to-account assignments
 * - Usage queries (windowed token consumption)
 * - Throttle event queries (capacity planning)
 * - Switch configuration management
 * - Account selection (default, next available)
 * - Real-time account usage updates
 * - Account limit warnings and reached notifications
 */

import { ipcRenderer } from 'electron';

/**
 * Account usage update data broadcast from the account usage listener
 */
export interface AccountUsageUpdate {
	accountId: string;
	usagePercent: number | null;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	limitTokens: number;
	windowStart: number;
	windowEnd: number;
	queryCount: number;
	costUsd: number;
}

/**
 * Account limit warning/reached data
 */
export interface AccountLimitEvent {
	accountId: string;
	accountName: string;
	usagePercent: number;
	sessionId: string;
}

/**
 * Creates the accounts API object for preload exposure
 */
export function createAccountsApi() {
	return {
		// --- Account CRUD ---

		/** List all registered accounts */
		list: (): Promise<unknown[]> => ipcRenderer.invoke('accounts:list'),

		/** Get a single account by ID */
		get: (id: string): Promise<unknown> => ipcRenderer.invoke('accounts:get', id),

		/** Add a new account */
		add: (params: { name: string; email: string; configDir: string; agentType?: string }): Promise<unknown> =>
			ipcRenderer.invoke('accounts:add', params),

		/** Update an existing account */
		update: (id: string, updates: Record<string, unknown>): Promise<unknown> =>
			ipcRenderer.invoke('accounts:update', id, updates),

		/** Remove an account */
		remove: (id: string): Promise<unknown> => ipcRenderer.invoke('accounts:remove', id),

		/** Set an account as the default */
		setDefault: (id: string): Promise<unknown> => ipcRenderer.invoke('accounts:set-default', id),

		// --- Assignments ---

		/** Assign an account to a session */
		assign: (sessionId: string, accountId: string): Promise<unknown> =>
			ipcRenderer.invoke('accounts:assign', sessionId, accountId),

		/** Get the account assigned to a session */
		getAssignment: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke('accounts:get-assignment', sessionId),

		/** Get all current session-to-account assignments */
		getAllAssignments: (): Promise<unknown[]> => ipcRenderer.invoke('accounts:get-all-assignments'),

		// --- Usage Queries ---

		/** Get usage for an account within a specific time window */
		getUsage: (accountId: string, windowStart: number, windowEnd: number): Promise<unknown> =>
			ipcRenderer.invoke('accounts:get-usage', accountId, windowStart, windowEnd),

		/** Get usage for all accounts in their current windows */
		getAllUsage: (): Promise<unknown> => ipcRenderer.invoke('accounts:get-all-usage'),

		/** Get throttle events for capacity planning */
		getThrottleEvents: (accountId?: string, since?: number): Promise<unknown[]> =>
			ipcRenderer.invoke('accounts:get-throttle-events', accountId, since),

		/** Get daily usage aggregation for an account */
		getDailyUsage: (accountId: string, days?: number): Promise<unknown[]> =>
			ipcRenderer.invoke('accounts:get-daily-usage', accountId, days),

		/** Get monthly usage aggregation for an account */
		getMonthlyUsage: (accountId: string, months?: number): Promise<unknown[]> =>
			ipcRenderer.invoke('accounts:get-monthly-usage', accountId, months),

		/** Get billing window history for an account (for P90 predictions) */
		getWindowHistory: (accountId: string, windowCount?: number): Promise<unknown[]> =>
			ipcRenderer.invoke('accounts:get-window-history', accountId, windowCount),

		// --- Switch Configuration ---

		/** Get the current account switching configuration */
		getSwitchConfig: (): Promise<unknown> => ipcRenderer.invoke('accounts:get-switch-config'),

		/** Update account switching configuration */
		updateSwitchConfig: (updates: Record<string, unknown>): Promise<unknown> =>
			ipcRenderer.invoke('accounts:update-switch-config', updates),

		// --- Account Selection ---

		/** Get the default account */
		getDefault: (): Promise<unknown> => ipcRenderer.invoke('accounts:get-default'),

		/** Select the next available account (for auto-switching) */
		selectNext: (excludeIds?: string[]): Promise<unknown> =>
			ipcRenderer.invoke('accounts:select-next', excludeIds),

		// --- Account Setup ---

		/** Validate that the base ~/.claude directory exists */
		validateBaseDir: (): Promise<{ valid: boolean; baseDir: string; errors: string[] }> =>
			ipcRenderer.invoke('accounts:validate-base-dir'),

		/** Discover existing provider account directories */
		discoverExisting: (): Promise<Array<{ configDir: string; name: string; email: string | null; hasAuth: boolean; agentType: string }>> =>
			ipcRenderer.invoke('accounts:discover-existing'),

		/** Create a new account directory with symlinks */
		createDirectory: (name: string): Promise<{ success: boolean; configDir: string; error?: string }> =>
			ipcRenderer.invoke('accounts:create-directory', name),

		/** Validate symlinks in an account directory */
		validateSymlinks: (configDir: string): Promise<{ valid: boolean; broken: string[]; missing: string[] }> =>
			ipcRenderer.invoke('accounts:validate-symlinks', configDir),

		/** Repair broken or missing symlinks */
		repairSymlinks: (configDir: string): Promise<{ repaired: string[]; errors: string[] }> =>
			ipcRenderer.invoke('accounts:repair-symlinks', configDir),

		/** Read the email from an account's .claude.json */
		readEmail: (configDir: string): Promise<string | null> =>
			ipcRenderer.invoke('accounts:read-email', configDir),

		/** Get the login command string for an account */
		getLoginCommand: (configDir: string): Promise<string | null> =>
			ipcRenderer.invoke('accounts:get-login-command', configDir),

		/** Remove an account directory */
		removeDirectory: (configDir: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('accounts:remove-directory', configDir),

		/** Validate an account directory on a remote SSH host */
		validateRemoteDir: (params: { sshConfig: { host: string; user?: string; port?: number }; configDir: string }): Promise<{ exists: boolean; hasAuth: boolean; symlinksValid: boolean; error?: string }> =>
			ipcRenderer.invoke('accounts:validate-remote-dir', params),

		/** Sync credentials from base ~/.claude to an account directory */
		syncCredentials: (configDir: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('accounts:sync-credentials', configDir),

		// --- Event Listeners ---

		/**
		 * Subscribe to real-time account usage updates
		 * @param handler - Callback with usage data
		 * @returns Cleanup function to unsubscribe
		 */
		onUsageUpdate: (handler: (data: AccountUsageUpdate) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: AccountUsageUpdate) =>
				handler(data);
			ipcRenderer.on('account:usage-update', wrappedHandler);
			return () => ipcRenderer.removeListener('account:usage-update', wrappedHandler);
		},

		/**
		 * Subscribe to account limit warning events (usage approaching threshold)
		 * @param handler - Callback with limit event data
		 * @returns Cleanup function to unsubscribe
		 */
		onLimitWarning: (handler: (data: AccountLimitEvent) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: AccountLimitEvent) =>
				handler(data);
			ipcRenderer.on('account:limit-warning', wrappedHandler);
			return () => ipcRenderer.removeListener('account:limit-warning', wrappedHandler);
		},

		/**
		 * Subscribe to account limit reached events (auto-switch threshold exceeded)
		 * @param handler - Callback with limit event data
		 * @returns Cleanup function to unsubscribe
		 */
		onLimitReached: (handler: (data: AccountLimitEvent) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: AccountLimitEvent) =>
				handler(data);
			ipcRenderer.on('account:limit-reached', wrappedHandler);
			return () => ipcRenderer.removeListener('account:limit-reached', wrappedHandler);
		},

		/**
		 * Subscribe to account throttled events (rate limit detected)
		 * @param handler - Callback with throttle data
		 * @returns Cleanup function to unsubscribe
		 */
		onThrottled: (handler: (data: Record<string, unknown>) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
				handler(data);
			ipcRenderer.on('account:throttled', wrappedHandler);
			return () => ipcRenderer.removeListener('account:throttled', wrappedHandler);
		},

		/**
		 * Subscribe to account switch prompt events (user confirmation needed)
		 * @param handler - Callback with switch prompt data
		 * @returns Cleanup function to unsubscribe
		 */
		onSwitchPrompt: (handler: (data: Record<string, unknown>) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
				handler(data);
			ipcRenderer.on('account:switch-prompt', wrappedHandler);
			return () => ipcRenderer.removeListener('account:switch-prompt', wrappedHandler);
		},

		/**
		 * Subscribe to automatic account switch events (no confirmation needed)
		 * @param handler - Callback with switch execution data
		 * @returns Cleanup function to unsubscribe
		 */
		onSwitchExecute: (handler: (data: Record<string, unknown>) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
				handler(data);
			ipcRenderer.on('account:switch-execute', wrappedHandler);
			return () => ipcRenderer.removeListener('account:switch-execute', wrappedHandler);
		},

		/**
		 * Subscribe to account status change events (e.g., throttled -> active recovery)
		 * @param handler - Callback with status change data
		 * @returns Cleanup function to unsubscribe
		 */
		onStatusChanged: (handler: (data: Record<string, unknown>) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
				handler(data);
			ipcRenderer.on('account:status-changed', wrappedHandler);
			return () => ipcRenderer.removeListener('account:status-changed', wrappedHandler);
		},

		/**
		 * Subscribe to account assignment events (when a session is assigned an account during spawn)
		 * @param handler - Callback with assignment data
		 * @returns Cleanup function to unsubscribe
		 */
		onAssigned: (handler: (data: { sessionId: string; accountId: string; accountName: string }) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; accountId: string; accountName: string }) =>
				handler(data);
			ipcRenderer.on('account:assigned', wrappedHandler);
			return () => ipcRenderer.removeListener('account:assigned', wrappedHandler);
		},

		// --- Session Reconciliation ---

		/** Reconcile account assignments after session restore on startup.
		 * Removes stale assignments and returns account validation for sessions with accountId. */
		reconcileSessions: (activeSessionIds: string[]): Promise<{
			success: boolean;
			removed: number;
			corrections: Array<{
				sessionId: string;
				accountId: string | null;
				accountName: string | null;
				configDir: string | null;
				status: 'valid' | 'removed' | 'inactive';
			}>;
			error?: string;
		}> => ipcRenderer.invoke('accounts:reconcile-sessions', activeSessionIds),

		// --- Session Cleanup ---

		/** Clean up account data when a session is closed */
		cleanupSession: (sessionId: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('accounts:cleanup-session', sessionId),

		// --- Account Switching ---

		/** Execute an account switch for a session */
		executeSwitch: (params: {
			sessionId: string;
			fromAccountId: string;
			toAccountId: string;
			reason: string;
			automatic: boolean;
		}): Promise<{ success: boolean; event?: unknown; error?: string }> =>
			ipcRenderer.invoke('accounts:execute-switch', params),

		/** Subscribe to switch-started events */
		onSwitchStarted: (handler: (data: Record<string, unknown>) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
				handler(data);
			ipcRenderer.on('account:switch-started', wrappedHandler);
			return () => ipcRenderer.removeListener('account:switch-started', wrappedHandler);
		},

		/** Subscribe to switch-respawn events (renderer must respawn the agent) */
		onSwitchRespawn: (handler: (data: {
			sessionId: string;
			toAccountId: string;
			toAccountName: string;
			configDir: string;
			lastPrompt: string | null;
			reason: string;
		}) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: any) =>
				handler(data);
			ipcRenderer.on('account:switch-respawn', wrappedHandler);
			return () => ipcRenderer.removeListener('account:switch-respawn', wrappedHandler);
		},

		/** Subscribe to switch-completed events */
		onSwitchCompleted: (handler: (data: Record<string, unknown>) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
				handler(data);
			ipcRenderer.on('account:switch-completed', wrappedHandler);
			return () => ipcRenderer.removeListener('account:switch-completed', wrappedHandler);
		},

		/** Subscribe to switch-failed events */
		onSwitchFailed: (handler: (data: Record<string, unknown>) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
				handler(data);
			ipcRenderer.on('account:switch-failed', wrappedHandler);
			return () => ipcRenderer.removeListener('account:switch-failed', wrappedHandler);
		},

		// --- Auth Recovery ---

		/** Manually trigger auth recovery for a session */
		triggerAuthRecovery: (sessionId: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('accounts:trigger-auth-recovery', sessionId),

		/** Subscribe to auth recovery started events */
		onAuthRecoveryStarted: (handler: (data: {
			sessionId: string;
			accountId: string;
			accountName: string;
		}) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: any) =>
				handler(data);
			ipcRenderer.on('account:auth-recovery-started', wrappedHandler);
			return () => ipcRenderer.removeListener('account:auth-recovery-started', wrappedHandler);
		},

		/** Subscribe to auth recovery completed events */
		onAuthRecoveryCompleted: (handler: (data: {
			sessionId: string;
			accountId: string;
			accountName: string;
		}) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: any) =>
				handler(data);
			ipcRenderer.on('account:auth-recovery-completed', wrappedHandler);
			return () => ipcRenderer.removeListener('account:auth-recovery-completed', wrappedHandler);
		},

		/** Subscribe to auth recovery failed events */
		onAuthRecoveryFailed: (handler: (data: {
			sessionId: string;
			accountId: string;
			accountName?: string;
			error: string;
		}) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: any) =>
				handler(data);
			ipcRenderer.on('account:auth-recovery-failed', wrappedHandler);
			return () => ipcRenderer.removeListener('account:auth-recovery-failed', wrappedHandler);
		},

		// --- Recovery Poller ---

		/** Subscribe to account recovery available events (throttled accounts recovered by timer) */
		onRecoveryAvailable: (handler: (data: {
			recoveredAccountIds: string[];
			recoveredCount: number;
			stillThrottledCount: number;
			totalAccounts: number;
		}) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: any) =>
				handler(data);
			ipcRenderer.on('account:recovery-available', wrappedHandler);
			return () => ipcRenderer.removeListener('account:recovery-available', wrappedHandler);
		},

		/** Manually trigger a recovery check (e.g., from a "Check Now" button) */
		checkRecovery: (): Promise<{ recovered: string[] }> =>
			ipcRenderer.invoke('accounts:check-recovery'),
	};
}

/**
 * TypeScript type for the accounts API
 */
export type AccountsApi = ReturnType<typeof createAccountsApi>;
