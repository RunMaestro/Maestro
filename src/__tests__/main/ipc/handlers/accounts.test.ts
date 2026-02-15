/**
 * Tests for the Account IPC handlers
 *
 * Focused on the accounts:check-recovery handler
 * which allows manual triggering of recovery polls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerAccountHandlers } from '../../../../main/ipc/handlers/accounts';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the stats module
vi.mock('../../../../main/stats', () => ({
	getStatsDB: vi.fn(() => ({
		isReady: () => false,
		getAccountUsageInWindow: vi.fn(),
		getThrottleEvents: vi.fn().mockReturnValue([]),
		insertThrottleEvent: vi.fn(),
	})),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock account-setup module
vi.mock('../../../../main/accounts/account-setup', () => ({
	validateBaseClaudeDir: vi.fn(),
	discoverExistingAccounts: vi.fn(),
	createAccountDirectory: vi.fn(),
	validateAccountSymlinks: vi.fn(),
	repairAccountSymlinks: vi.fn(),
	readAccountEmail: vi.fn(),
	buildLoginCommand: vi.fn(),
	removeAccountDirectory: vi.fn(),
	validateRemoteAccountDir: vi.fn(),
	syncCredentialsFromBase: vi.fn(),
}));

describe('accounts IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockRecoveryPoller: { poll: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();

		// Capture registered handlers
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
			return undefined as any;
		});

		mockRecoveryPoller = {
			poll: vi.fn().mockReturnValue(['account-1', 'account-2']),
		};

		registerAccountHandlers({
			getAccountRegistry: () => ({
				getAll: vi.fn().mockReturnValue([]),
				get: vi.fn(),
				add: vi.fn(),
				update: vi.fn(),
				remove: vi.fn(),
				setStatus: vi.fn(),
				getDefaultAccount: vi.fn(),
				selectNextAccount: vi.fn(),
				getSwitchConfig: vi.fn().mockReturnValue({ enabled: false }),
				updateSwitchConfig: vi.fn(),
				assignToSession: vi.fn(),
				getAssignment: vi.fn(),
				getAllAssignments: vi.fn().mockReturnValue([]),
				removeAssignment: vi.fn(),
				reconcileAssignments: vi.fn().mockReturnValue(0),
			} as any),
			getRecoveryPoller: () => mockRecoveryPoller as any,
		});
	});

	describe('accounts:check-recovery', () => {
		it('registers the handler', () => {
			expect(handlers.has('accounts:check-recovery')).toBe(true);
		});

		it('returns recovered account IDs from poller', async () => {
			const handler = handlers.get('accounts:check-recovery')!;
			const result = await handler({});

			expect(mockRecoveryPoller.poll).toHaveBeenCalledTimes(1);
			expect(result).toEqual({ recovered: ['account-1', 'account-2'] });
		});

		it('returns empty array when no accounts recovered', async () => {
			mockRecoveryPoller.poll.mockReturnValue([]);
			const handler = handlers.get('accounts:check-recovery')!;
			const result = await handler({});

			expect(result).toEqual({ recovered: [] });
		});

		it('returns empty array when poller is not available', async () => {
			// Re-register without poller
			handlers.clear();
			registerAccountHandlers({
				getAccountRegistry: () => ({
					getAll: vi.fn().mockReturnValue([]),
					get: vi.fn(),
					add: vi.fn(),
					update: vi.fn(),
					remove: vi.fn(),
					setStatus: vi.fn(),
					getDefaultAccount: vi.fn(),
					selectNextAccount: vi.fn(),
					getSwitchConfig: vi.fn().mockReturnValue({ enabled: false }),
					updateSwitchConfig: vi.fn(),
					assignToSession: vi.fn(),
					getAssignment: vi.fn(),
					getAllAssignments: vi.fn().mockReturnValue([]),
					removeAssignment: vi.fn(),
					reconcileAssignments: vi.fn().mockReturnValue(0),
				} as any),
				// No getRecoveryPoller provided
			});

			const handler = handlers.get('accounts:check-recovery')!;
			const result = await handler({});

			expect(result).toEqual({ recovered: [] });
		});

		it('returns empty array when getRecoveryPoller returns null', async () => {
			// Re-register with poller returning null
			handlers.clear();
			registerAccountHandlers({
				getAccountRegistry: () => ({
					getAll: vi.fn().mockReturnValue([]),
					get: vi.fn(),
					add: vi.fn(),
					update: vi.fn(),
					remove: vi.fn(),
					setStatus: vi.fn(),
					getDefaultAccount: vi.fn(),
					selectNextAccount: vi.fn(),
					getSwitchConfig: vi.fn().mockReturnValue({ enabled: false }),
					updateSwitchConfig: vi.fn(),
					assignToSession: vi.fn(),
					getAssignment: vi.fn(),
					getAllAssignments: vi.fn().mockReturnValue([]),
					removeAssignment: vi.fn(),
					reconcileAssignments: vi.fn().mockReturnValue(0),
				} as any),
				getRecoveryPoller: () => null,
			});

			const handler = handlers.get('accounts:check-recovery')!;
			const result = await handler({});

			expect(result).toEqual({ recovered: [] });
		});

		it('handles errors gracefully', async () => {
			mockRecoveryPoller.poll.mockImplementation(() => {
				throw new Error('Poll failed');
			});

			const handler = handlers.get('accounts:check-recovery')!;
			const result = await handler({});

			expect(result).toEqual({ recovered: [] });
		});
	});
});
