/**
 * Integration tests for AccountSwitcher wiring.
 *
 * Verifies that registerAccountHandlers and registerProcessHandlers
 * properly call through to the AccountSwitcher when the getter is provided,
 * and gracefully degrade when it is not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerAccountHandlers } from '../../../main/ipc/handlers/accounts';
import { registerProcessHandlers } from '../../../main/ipc/handlers/process';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the stats module
vi.mock('../../../main/stats', () => ({
	getStatsDB: vi.fn(() => ({
		isReady: () => false,
		getAccountUsageInWindow: vi.fn(),
		getThrottleEvents: vi.fn().mockReturnValue([]),
		insertThrottleEvent: vi.fn(),
	})),
}));

// Mock the logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock account-setup module (required by accounts handler)
vi.mock('../../../main/accounts/account-setup', () => ({
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

// Mock agent-args utilities (required by process handler)
vi.mock('../../../main/utils/agent-args', () => ({
	buildAgentArgs: vi.fn((_agent: unknown, opts: { baseArgs?: string[] }) => opts.baseArgs || []),
	applyAgentConfigOverrides: vi.fn((_agent: unknown, args: string[]) => ({
		args,
		modelSource: 'none' as const,
		customArgsSource: 'none' as const,
		customEnvSource: 'none' as const,
		effectiveCustomEnvVars: undefined,
	})),
	getContextWindowValue: vi.fn(() => 0),
}));

// Mock node-pty
vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

// Mock streamJsonBuilder
vi.mock('../../../main/process-manager/utils/streamJsonBuilder', () => ({
	buildStreamJsonMessage: vi.fn(),
}));

// Mock ssh-command-builder
vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommandWithStdin: vi.fn(),
}));

function createMinimalAccountRegistry() {
	return {
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
	} as any;
}

describe('AccountSwitcher wiring', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();

		// Capture registered handlers
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
			return undefined as any;
		});
	});

	describe('accounts:execute-switch', () => {
		it('should execute switch when getAccountSwitcher returns an instance', async () => {
			const mockSwitcher = {
				executeSwitch: vi.fn().mockResolvedValue({
					sessionId: 'session-1',
					fromAccountId: 'acct-1',
					toAccountId: 'acct-2',
					reason: 'manual',
					automatic: false,
					timestamp: Date.now(),
				}),
				recordLastPrompt: vi.fn(),
				cleanupSession: vi.fn(),
			};

			registerAccountHandlers({
				getAccountRegistry: () => createMinimalAccountRegistry(),
				getAccountSwitcher: () => mockSwitcher as any,
			});

			const handler = handlers.get('accounts:execute-switch')!;
			expect(handler).toBeDefined();

			const result = await handler({}, {
				sessionId: 'session-1',
				fromAccountId: 'acct-1',
				toAccountId: 'acct-2',
				reason: 'manual',
				automatic: false,
			});

			expect(result.success).toBe(true);
			expect(result.event).toBeDefined();
			expect(mockSwitcher.executeSwitch).toHaveBeenCalledWith({
				sessionId: 'session-1',
				fromAccountId: 'acct-1',
				toAccountId: 'acct-2',
				reason: 'manual',
				automatic: false,
			});
		});

		it('should return error when getAccountSwitcher returns null', async () => {
			registerAccountHandlers({
				getAccountRegistry: () => createMinimalAccountRegistry(),
				getAccountSwitcher: () => null,
			});

			const handler = handlers.get('accounts:execute-switch')!;
			const result = await handler({}, {
				sessionId: 'session-1',
				fromAccountId: 'acct-1',
				toAccountId: 'acct-2',
				reason: 'manual',
				automatic: false,
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Account switcher not initialized');
		});

		it('should return error when getAccountSwitcher is not provided', async () => {
			registerAccountHandlers({
				getAccountRegistry: () => createMinimalAccountRegistry(),
				// No getAccountSwitcher provided
			});

			const handler = handlers.get('accounts:execute-switch')!;
			const result = await handler({}, {
				sessionId: 'session-1',
				fromAccountId: 'acct-1',
				toAccountId: 'acct-2',
				reason: 'manual',
				automatic: false,
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Account switcher not initialized');
		});
	});

	describe('accounts:cleanup-session', () => {
		it('should call switcher.cleanupSession when switcher is available', async () => {
			const mockSwitcher = {
				executeSwitch: vi.fn(),
				recordLastPrompt: vi.fn(),
				cleanupSession: vi.fn(),
			};

			registerAccountHandlers({
				getAccountRegistry: () => createMinimalAccountRegistry(),
				getAccountSwitcher: () => mockSwitcher as any,
			});

			const handler = handlers.get('accounts:cleanup-session')!;
			expect(handler).toBeDefined();

			const result = await handler({}, 'session-1');

			expect(result.success).toBe(true);
			expect(mockSwitcher.cleanupSession).toHaveBeenCalledWith('session-1');
		});
	});

	describe('process:write recordLastPrompt', () => {
		it('should record last prompt on process:write when switcher available', async () => {
			const mockSwitcher = {
				executeSwitch: vi.fn(),
				recordLastPrompt: vi.fn(),
				cleanupSession: vi.fn(),
			};

			const mockProcessManager = {
				write: vi.fn().mockReturnValue(true),
				spawn: vi.fn(),
				kill: vi.fn(),
				interrupt: vi.fn(),
				resize: vi.fn(),
				getActiveProcesses: vi.fn().mockReturnValue([]),
			};

			registerProcessHandlers({
				getProcessManager: () => mockProcessManager as any,
				getAgentDetector: () => null,
				agentConfigsStore: { get: vi.fn().mockReturnValue({}), set: vi.fn(), onDidChange: vi.fn() } as any,
				settingsStore: { get: vi.fn().mockReturnValue({}), set: vi.fn(), onDidChange: vi.fn() } as any,
				getMainWindow: () => null,
				sessionsStore: { get: vi.fn().mockReturnValue({ sessions: [] }), set: vi.fn(), onDidChange: vi.fn() } as any,
				getAccountSwitcher: () => mockSwitcher as any,
				safeSend: vi.fn(),
			});

			const handler = handlers.get('process:write')!;
			expect(handler).toBeDefined();

			await handler({}, 'session-1', 'Hello, fix the bug');

			expect(mockSwitcher.recordLastPrompt).toHaveBeenCalledWith('session-1', 'Hello, fix the bug');
			expect(mockProcessManager.write).toHaveBeenCalledWith('session-1', 'Hello, fix the bug');
		});

		it('should not fail on process:write when switcher is not available', async () => {
			const mockProcessManager = {
				write: vi.fn().mockReturnValue(true),
				spawn: vi.fn(),
				kill: vi.fn(),
				interrupt: vi.fn(),
				resize: vi.fn(),
				getActiveProcesses: vi.fn().mockReturnValue([]),
			};

			registerProcessHandlers({
				getProcessManager: () => mockProcessManager as any,
				getAgentDetector: () => null,
				agentConfigsStore: { get: vi.fn().mockReturnValue({}), set: vi.fn(), onDidChange: vi.fn() } as any,
				settingsStore: { get: vi.fn().mockReturnValue({}), set: vi.fn(), onDidChange: vi.fn() } as any,
				getMainWindow: () => null,
				sessionsStore: { get: vi.fn().mockReturnValue({ sessions: [] }), set: vi.fn(), onDidChange: vi.fn() } as any,
				// No getAccountSwitcher provided
				safeSend: vi.fn(),
			});

			const handler = handlers.get('process:write')!;
			const result = await handler({}, 'session-1', 'Hello');

			// Should succeed without error — graceful degradation
			expect(result).toBe(true);
			expect(mockProcessManager.write).toHaveBeenCalledWith('session-1', 'Hello');
		});
	});
});
