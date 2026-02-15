/**
 * Tests for AccountRecoveryPoller.
 * Validates timer-based recovery of throttled accounts,
 * IPC event broadcasting, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountRecoveryPoller } from '../../../main/accounts/account-recovery-poller';
import type { AccountRegistry } from '../../../main/accounts/account-registry';
import type { AccountProfile } from '../../../shared/account-types';

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
		tokenWindowMs: 5 * 60 * 60 * 1000, // 5 hours
		isDefault: true,
		autoSwitchEnabled: true,
		...overrides,
	};
}

describe('AccountRecoveryPoller', () => {
	let poller: AccountRecoveryPoller;
	let mockRegistry: {
		getAll: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
	};
	let mockSafeSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();

		mockRegistry = {
			getAll: vi.fn().mockReturnValue([]),
			setStatus: vi.fn(),
		};
		mockSafeSend = vi.fn();

		poller = new AccountRecoveryPoller(
			{
				accountRegistry: mockRegistry as unknown as AccountRegistry,
				safeSend: mockSafeSend,
			},
			60_000 // 1 minute interval
		);
	});

	afterEach(() => {
		poller.stop();
		vi.useRealTimers();
	});

	it('should return empty array when no throttled accounts exist', () => {
		mockRegistry.getAll.mockReturnValue([createMockAccount({ status: 'active' })]);

		const recovered = poller.poll();

		expect(recovered).toEqual([]);
		expect(mockRegistry.setStatus).not.toHaveBeenCalled();
		expect(mockSafeSend).not.toHaveBeenCalled();
	});

	it('should not recover accounts still within their throttle window', () => {
		const now = Date.now();
		const windowMs = 5 * 60 * 60 * 1000; // 5 hours

		mockRegistry.getAll.mockReturnValue([
			createMockAccount({
				id: 'acct-1',
				status: 'throttled',
				lastThrottledAt: now - (windowMs / 2), // Only halfway through window
				tokenWindowMs: windowMs,
			}),
		]);

		const recovered = poller.poll();

		expect(recovered).toEqual([]);
		expect(mockRegistry.setStatus).not.toHaveBeenCalled();
	});

	it('should recover accounts past their window + margin', () => {
		const now = Date.now();
		const windowMs = 5 * 60 * 60 * 1000; // 5 hours
		const marginMs = 30_000; // 30 seconds

		mockRegistry.getAll.mockReturnValue([
			createMockAccount({
				id: 'acct-1',
				name: 'Recovered Account',
				status: 'throttled',
				lastThrottledAt: now - windowMs - marginMs - 1000, // Past window + margin
				tokenWindowMs: windowMs,
			}),
		]);

		const recovered = poller.poll();

		expect(recovered).toEqual(['acct-1']);
		expect(mockRegistry.setStatus).toHaveBeenCalledWith('acct-1', 'active');
	});

	it('should broadcast status-changed and recovery-available events on recovery', () => {
		const now = Date.now();
		const windowMs = 5 * 60 * 60 * 1000;
		const marginMs = 30_000;

		mockRegistry.getAll.mockReturnValue([
			createMockAccount({
				id: 'acct-1',
				name: 'Recovered Account',
				status: 'throttled',
				lastThrottledAt: now - windowMs - marginMs - 1000,
				tokenWindowMs: windowMs,
			}),
		]);

		poller.poll();

		// Should send status-changed per recovered account
		expect(mockSafeSend).toHaveBeenCalledWith('account:status-changed', expect.objectContaining({
			accountId: 'acct-1',
			accountName: 'Recovered Account',
			oldStatus: 'throttled',
			newStatus: 'active',
			recoveredBy: 'poller',
		}));

		// Should send recovery-available summary event
		expect(mockSafeSend).toHaveBeenCalledWith('account:recovery-available', expect.objectContaining({
			recoveredAccountIds: ['acct-1'],
			recoveredCount: 1,
			stillThrottledCount: 0,
			totalAccounts: 1,
		}));
	});

	it('should recover multiple accounts and report correct counts', () => {
		const now = Date.now();
		const windowMs = 5 * 60 * 60 * 1000;
		const marginMs = 30_000;

		mockRegistry.getAll.mockReturnValue([
			createMockAccount({
				id: 'acct-1',
				name: 'Account 1',
				status: 'throttled',
				lastThrottledAt: now - windowMs - marginMs - 1000,
				tokenWindowMs: windowMs,
			}),
			createMockAccount({
				id: 'acct-2',
				name: 'Account 2',
				status: 'throttled',
				lastThrottledAt: now - windowMs - marginMs - 2000,
				tokenWindowMs: windowMs,
			}),
			createMockAccount({
				id: 'acct-3',
				name: 'Account 3 (still throttled)',
				status: 'throttled',
				lastThrottledAt: now - (windowMs / 2), // Still within window
				tokenWindowMs: windowMs,
			}),
		]);

		const recovered = poller.poll();

		expect(recovered).toEqual(['acct-1', 'acct-2']);
		expect(mockRegistry.setStatus).toHaveBeenCalledTimes(2);

		expect(mockSafeSend).toHaveBeenCalledWith('account:recovery-available', expect.objectContaining({
			recoveredAccountIds: ['acct-1', 'acct-2'],
			recoveredCount: 2,
			stillThrottledCount: 1,
			totalAccounts: 3,
		}));
	});

	it('should skip throttled accounts with lastThrottledAt of 0', () => {
		mockRegistry.getAll.mockReturnValue([
			createMockAccount({
				id: 'acct-1',
				status: 'throttled',
				lastThrottledAt: 0, // Never throttled (invalid state)
			}),
		]);

		const recovered = poller.poll();

		expect(recovered).toEqual([]);
		expect(mockRegistry.setStatus).not.toHaveBeenCalled();
	});

	it('should use DEFAULT_TOKEN_WINDOW_MS when tokenWindowMs is 0', () => {
		const now = Date.now();
		const defaultWindowMs = 5 * 60 * 60 * 1000; // 5 hours (DEFAULT_TOKEN_WINDOW_MS)
		const marginMs = 30_000;

		mockRegistry.getAll.mockReturnValue([
			createMockAccount({
				id: 'acct-1',
				name: 'No Window Account',
				status: 'throttled',
				lastThrottledAt: now - defaultWindowMs - marginMs - 1000,
				tokenWindowMs: 0, // Will use default
			}),
		]);

		const recovered = poller.poll();

		expect(recovered).toEqual(['acct-1']);
	});

	// --- Start/stop behavior ---

	it('should start and stop cleanly', () => {
		expect(poller.isRunning()).toBe(false);

		poller.start();
		expect(poller.isRunning()).toBe(true);

		poller.stop();
		expect(poller.isRunning()).toBe(false);
	});

	it('should be idempotent on start (no double timers)', () => {
		mockRegistry.getAll.mockReturnValue([]);

		poller.start();
		poller.start(); // Second call should be no-op

		expect(poller.isRunning()).toBe(true);

		// Advance time and verify poll is called (not doubled)
		vi.advanceTimersByTime(60_000);

		// getAll is called once on immediate poll (start), then once per interval tick
		// start() → poll() → getAll() [1st call]
		// 2nd start() → no-op
		// advanceTimersByTime(60_000) → poll() → getAll() [2nd call]
		expect(mockRegistry.getAll).toHaveBeenCalledTimes(2);
	});

	it('should stop safely when not running', () => {
		expect(() => poller.stop()).not.toThrow();
	});

	it('should run poll immediately on start', () => {
		mockRegistry.getAll.mockReturnValue([]);

		poller.start();

		// poll() is called immediately in start()
		expect(mockRegistry.getAll).toHaveBeenCalledTimes(1);
	});

	it('should poll on interval after start', () => {
		mockRegistry.getAll.mockReturnValue([]);

		poller.start();
		expect(mockRegistry.getAll).toHaveBeenCalledTimes(1); // Immediate poll

		vi.advanceTimersByTime(60_000);
		expect(mockRegistry.getAll).toHaveBeenCalledTimes(2); // First interval

		vi.advanceTimersByTime(60_000);
		expect(mockRegistry.getAll).toHaveBeenCalledTimes(3); // Second interval
	});

	it('should stop polling after stop() is called', () => {
		mockRegistry.getAll.mockReturnValue([]);

		poller.start();
		expect(mockRegistry.getAll).toHaveBeenCalledTimes(1);

		poller.stop();

		vi.advanceTimersByTime(120_000);
		expect(mockRegistry.getAll).toHaveBeenCalledTimes(1); // No more calls
	});
});
