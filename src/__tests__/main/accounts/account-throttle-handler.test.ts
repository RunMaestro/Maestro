/**
 * Tests for AccountThrottleHandler.
 * Validates throttle detection, stats recording, account status updates,
 * and switch recommendation logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountThrottleHandler } from '../../../main/accounts/account-throttle-handler';
import type { AccountRegistry } from '../../../main/accounts/account-registry';
import type { StatsDB } from '../../../main/stats';
import type { AccountProfile, AccountSwitchConfig } from '../../../shared/account-types';

function createMockAccount(overrides: Partial<AccountProfile> = {}): AccountProfile {
	return {
		id: 'acct-1',
		name: 'Test Account',
		email: 'test@example.com',
		configDir: '/home/test/.claude-test',
		agentType: 'claude-code',
		status: 'active',
		authMethod: 'oauth',
		addedAt: Date.now(),
		lastUsedAt: Date.now(),
		lastThrottledAt: 0,
		tokenLimitPerWindow: 0,
		tokenWindowMs: 5 * 60 * 60 * 1000,
		isDefault: true,
		autoSwitchEnabled: true,
		...overrides,
	};
}

function createMockSwitchConfig(overrides: Partial<AccountSwitchConfig> = {}): AccountSwitchConfig {
	return {
		enabled: true,
		promptBeforeSwitch: true,
		autoSwitchThresholdPercent: 90,
		warningThresholdPercent: 75,
		selectionStrategy: 'round-robin',
		...overrides,
	};
}

describe('AccountThrottleHandler', () => {
	let handler: AccountThrottleHandler;
	let mockRegistry: {
		get: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
		getSwitchConfig: ReturnType<typeof vi.fn>;
		selectNextAccount: ReturnType<typeof vi.fn>;
		getAssignment: ReturnType<typeof vi.fn>;
	};
	let mockStatsDb: {
		isReady: ReturnType<typeof vi.fn>;
		getAccountUsageInWindow: ReturnType<typeof vi.fn>;
		insertThrottleEvent: ReturnType<typeof vi.fn>;
	};
	let mockSafeSend: ReturnType<typeof vi.fn>;
	let mockLogger: {
		info: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();

		mockRegistry = {
			get: vi.fn(),
			setStatus: vi.fn(),
			getSwitchConfig: vi.fn().mockReturnValue(createMockSwitchConfig()),
			selectNextAccount: vi.fn(),
			getAssignment: vi.fn(),
		};

		mockStatsDb = {
			isReady: vi.fn().mockReturnValue(true),
			getAccountUsageInWindow: vi.fn().mockReturnValue({
				inputTokens: 50000,
				outputTokens: 20000,
				cacheReadTokens: 10000,
				cacheCreationTokens: 5000,
				costUsd: 1.5,
				queryCount: 10,
			}),
			insertThrottleEvent: vi.fn().mockReturnValue('event-1'),
		};

		mockSafeSend = vi.fn();
		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
		};

		handler = new AccountThrottleHandler(
			mockRegistry as unknown as AccountRegistry,
			() => mockStatsDb as unknown as StatsDB,
			mockSafeSend,
			mockLogger,
		);
	});

	it('should record throttle event and mark account as throttled', () => {
		const account = createMockAccount();
		mockRegistry.get.mockReturnValue(account);
		mockRegistry.getSwitchConfig.mockReturnValue(createMockSwitchConfig({ enabled: false }));

		handler.handleThrottle({
			sessionId: 'session-1',
			accountId: 'acct-1',
			errorType: 'rate_limited',
			errorMessage: 'Too many requests',
		});

		expect(mockStatsDb.insertThrottleEvent).toHaveBeenCalledWith(
			'acct-1', 'session-1', 'rate_limited',
			85000, // 50000 + 20000 + 10000 + 5000
			expect.any(Number), expect.any(Number)
		);

		expect(mockRegistry.setStatus).toHaveBeenCalledWith('acct-1', 'throttled');
	});

	it('should send throttled notification when auto-switch is disabled', () => {
		const account = createMockAccount();
		mockRegistry.get.mockReturnValue(account);
		mockRegistry.getSwitchConfig.mockReturnValue(createMockSwitchConfig({ enabled: false }));

		handler.handleThrottle({
			sessionId: 'session-1',
			accountId: 'acct-1',
			errorType: 'rate_limited',
			errorMessage: 'Too many requests',
		});

		expect(mockSafeSend).toHaveBeenCalledWith('account:throttled', expect.objectContaining({
			accountId: 'acct-1',
			accountName: 'Test Account',
			autoSwitchAvailable: false,
		}));
	});

	it('should send throttled notification with noAlternatives when no accounts available', () => {
		const account = createMockAccount();
		mockRegistry.get.mockReturnValue(account);
		mockRegistry.getSwitchConfig.mockReturnValue(createMockSwitchConfig({ enabled: true }));
		mockRegistry.selectNextAccount.mockReturnValue(null);

		handler.handleThrottle({
			sessionId: 'session-1',
			accountId: 'acct-1',
			errorType: 'rate_limited',
			errorMessage: 'Too many requests',
		});

		expect(mockSafeSend).toHaveBeenCalledWith('account:throttled', expect.objectContaining({
			accountId: 'acct-1',
			noAlternatives: true,
		}));
	});

	it('should send switch-prompt when promptBeforeSwitch is true', () => {
		const account = createMockAccount();
		const nextAccount = createMockAccount({ id: 'acct-2', name: 'Second Account' });
		mockRegistry.get.mockReturnValue(account);
		mockRegistry.getSwitchConfig.mockReturnValue(createMockSwitchConfig({
			enabled: true,
			promptBeforeSwitch: true,
		}));
		mockRegistry.selectNextAccount.mockReturnValue(nextAccount);

		handler.handleThrottle({
			sessionId: 'session-1',
			accountId: 'acct-1',
			errorType: 'rate_limited',
			errorMessage: 'Too many requests',
		});

		expect(mockSafeSend).toHaveBeenCalledWith('account:switch-prompt', expect.objectContaining({
			sessionId: 'session-1',
			fromAccountId: 'acct-1',
			fromAccountName: 'Test Account',
			toAccountId: 'acct-2',
			toAccountName: 'Second Account',
			reason: 'rate_limited',
		}));
	});

	it('should send switch-execute when promptBeforeSwitch is false', () => {
		const account = createMockAccount();
		const nextAccount = createMockAccount({ id: 'acct-2', name: 'Second Account' });
		mockRegistry.get.mockReturnValue(account);
		mockRegistry.getSwitchConfig.mockReturnValue(createMockSwitchConfig({
			enabled: true,
			promptBeforeSwitch: false,
		}));
		mockRegistry.selectNextAccount.mockReturnValue(nextAccount);

		handler.handleThrottle({
			sessionId: 'session-1',
			accountId: 'acct-1',
			errorType: 'rate_limited',
			errorMessage: 'Too many requests',
		});

		expect(mockSafeSend).toHaveBeenCalledWith('account:switch-execute', expect.objectContaining({
			sessionId: 'session-1',
			fromAccountId: 'acct-1',
			toAccountId: 'acct-2',
			automatic: true,
		}));
	});

	it('should skip if account not found', () => {
		mockRegistry.get.mockReturnValue(null);

		handler.handleThrottle({
			sessionId: 'session-1',
			accountId: 'acct-unknown',
			errorType: 'rate_limited',
			errorMessage: 'Too many requests',
		});

		expect(mockStatsDb.insertThrottleEvent).not.toHaveBeenCalled();
		expect(mockRegistry.setStatus).not.toHaveBeenCalled();
	});

	it('should skip if stats DB is not ready', () => {
		const account = createMockAccount();
		mockRegistry.get.mockReturnValue(account);
		mockStatsDb.isReady.mockReturnValue(false);

		handler.handleThrottle({
			sessionId: 'session-1',
			accountId: 'acct-1',
			errorType: 'rate_limited',
			errorMessage: 'Too many requests',
		});

		expect(mockStatsDb.insertThrottleEvent).not.toHaveBeenCalled();
		expect(mockRegistry.setStatus).not.toHaveBeenCalled();
	});

	it('should catch and log errors without throwing', () => {
		mockRegistry.get.mockImplementation(() => {
			throw new Error('Test error');
		});

		expect(() => {
			handler.handleThrottle({
				sessionId: 'session-1',
				accountId: 'acct-1',
				errorType: 'rate_limited',
				errorMessage: 'Too many requests',
			});
		}).not.toThrow();

		expect(mockLogger.error).toHaveBeenCalledWith(
			'Failed to handle throttle', 'account-throttle',
			expect.objectContaining({ error: 'Error: Test error' })
		);
	});
});
