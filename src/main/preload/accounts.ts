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
	usagePercent: number;
	totalTokens: number;
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
		add: (params: { name: string; email: string; configDir: string }): Promise<unknown> =>
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

		/** Discover existing ~/.claude-* account directories */
		discoverExisting: (): Promise<Array<{ configDir: string; name: string; email: string | null; hasAuth: boolean }>> =>
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
	};
}

/**
 * TypeScript type for the accounts API
 */
export type AccountsApi = ReturnType<typeof createAccountsApi>;
