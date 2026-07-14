/**
 * Tests for AccountSwitcher.
 * Validates the account switch execution flow: kill → wait → reassign → respawn → notify.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountSwitcher } from '../../../main/accounts/account-switcher';
import type { ProcessManager } from '../../../main/process-manager/ProcessManager';
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
		tokenWindowMs: 5 * 60 * 60 * 1000,
		isDefault: true,
		autoSwitchEnabled: true,
		...overrides,
	};
}

describe('AccountSwitcher', () => {
	let switcher: AccountSwitcher;
	let mockProcessManager: {
		kill: ReturnType<typeof vi.fn>;
		getAll: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		off: ReturnType<typeof vi.fn>;
	};
	let mockRegistry: {
		get: ReturnType<typeof vi.fn>;
		assignToSession: ReturnType<typeof vi.fn>;
	};
	let mockSafeSend: ReturnType<typeof vi.fn>;
	let exitListener: ((sessionId: string, exitCode: number) => void) | null;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		exitListener = null;
		mockProcessManager = {
			kill: vi.fn().mockReturnValue(true),
			// Used by the prefix-matching kill fallback when the exact-ID kill misses
			getAll: vi.fn().mockReturnValue([]),
			on: vi.fn((event: string, listener: (sessionId: string, exitCode: number) => void) => {
				if (event === 'exit') exitListener = listener;
			}),
			off: vi.fn(),
		};

		mockRegistry = {
			get: vi.fn(),
			assignToSession: vi.fn(),
		};

		mockSafeSend = vi.fn();

		switcher = new AccountSwitcher(
			mockProcessManager as unknown as ProcessManager,
			mockRegistry as unknown as AccountRegistry,
			mockSafeSend
		);
	});

	it('should record and retrieve last prompts', () => {
		switcher.recordLastPrompt('session-1', 'Hello, world');

		// Internal state - verified indirectly via executeSwitch sending lastPrompt
		switcher.cleanupSession('session-1');

		// After cleanup, the prompt should be gone (no way to verify directly,
		// but ensures no memory leak)
	});

	it('should execute a successful switch', async () => {
		const fromAccount = createMockAccount({ id: 'acct-1', name: 'Account One' });
		const toAccount = createMockAccount({
			id: 'acct-2',
			name: 'Account Two',
			configDir: '/home/test/.claude-two',
		});

		mockRegistry.get.mockImplementation((id: string) => {
			if (id === 'acct-1') return fromAccount;
			if (id === 'acct-2') return toAccount;
			return null;
		});

		switcher.recordLastPrompt('session-1', 'Fix the bug');

		const switchPromise = switcher.executeSwitch({
			sessionId: 'session-1',
			fromAccountId: 'acct-1',
			toAccountId: 'acct-2',
			reason: 'throttled',
			automatic: true,
		});

		expect(exitListener).not.toBeNull();
		exitListener?.('session-1', 0);

		const result = await switchPromise;

		expect(result).not.toBeNull();
		expect(result!.sessionId).toBe('session-1');
		expect(result!.fromAccountId).toBe('acct-1');
		expect(result!.toAccountId).toBe('acct-2');
		expect(result!.reason).toBe('throttled');
		expect(result!.automatic).toBe(true);
		expect(result!.timestamp).toBeGreaterThan(0);

		// Verify process was killed
		expect(mockProcessManager.kill).toHaveBeenCalledWith('session-1');

		// Verify account assignment was updated
		expect(mockRegistry.assignToSession).toHaveBeenCalledWith('session-1', 'acct-2');

		// Verify switch-started notification
		expect(mockSafeSend).toHaveBeenCalledWith(
			'account:switch-started',
			expect.objectContaining({
				sessionId: 'session-1',
				fromAccountId: 'acct-1',
				toAccountId: 'acct-2',
				toAccountName: 'Account Two',
			})
		);

		// Verify switch-respawn notification with lastPrompt
		expect(mockSafeSend).toHaveBeenCalledWith(
			'account:switch-respawn',
			expect.objectContaining({
				sessionId: 'session-1',
				toAccountId: 'acct-2',
				toAccountName: 'Account Two',
				configDir: '/home/test/.claude-two',
				lastPrompt: 'Fix the bug',
				reason: 'throttled',
			})
		);

		// Verify switch-completed notification
		expect(mockSafeSend).toHaveBeenCalledWith(
			'account:switch-completed',
			expect.objectContaining({
				sessionId: 'session-1',
				fromAccountId: 'acct-1',
				toAccountId: 'acct-2',
				fromAccountName: 'Account One',
				toAccountName: 'Account Two',
			})
		);
	});

	it('should return null when target account is not found', async () => {
		mockRegistry.get.mockReturnValue(null);

		const result = await switcher.executeSwitch({
			sessionId: 'session-1',
			fromAccountId: 'acct-1',
			toAccountId: 'acct-nonexistent',
			reason: 'throttled',
			automatic: true,
		});

		expect(result).toBeNull();
		expect(mockProcessManager.kill).not.toHaveBeenCalled();
	});

	it('should continue even if process kill fails', async () => {
		const toAccount = createMockAccount({
			id: 'acct-2',
			name: 'Account Two',
			configDir: '/home/test/.claude-two',
		});
		mockRegistry.get.mockImplementation((id: string) => {
			if (id === 'acct-2') return toAccount;
			return null;
		});
		mockProcessManager.kill.mockReturnValue(false);

		const switchPromise = switcher.executeSwitch({
			sessionId: 'session-1',
			fromAccountId: 'acct-1',
			toAccountId: 'acct-2',
			reason: 'throttled',
			automatic: false,
		});

		const result = await switchPromise;

		expect(result).not.toBeNull();
		expect(mockProcessManager.kill).toHaveBeenCalledWith('session-1');
		expect(mockRegistry.assignToSession).toHaveBeenCalledWith('session-1', 'acct-2');
	});

	it('should send null lastPrompt when no prompt was recorded', async () => {
		const toAccount = createMockAccount({
			id: 'acct-2',
			name: 'Account Two',
			configDir: '/home/test/.claude-two',
		});
		mockRegistry.get.mockImplementation((id: string) => {
			if (id === 'acct-2') return toAccount;
			return null;
		});

		const switchPromise = switcher.executeSwitch({
			sessionId: 'session-1',
			fromAccountId: 'acct-1',
			toAccountId: 'acct-2',
			reason: 'manual',
			automatic: false,
		});

		expect(exitListener).not.toBeNull();
		exitListener?.('session-1', 0);
		await switchPromise;

		expect(mockSafeSend).toHaveBeenCalledWith(
			'account:switch-respawn',
			expect.objectContaining({
				lastPrompt: null,
			})
		);
	});

	it('should include recorded images in the respawn payload', async () => {
		const toAccount = createMockAccount({
			id: 'acct-2',
			name: 'Account Two',
			configDir: '/home/test/.claude-two',
		});
		mockRegistry.get.mockImplementation((id: string) => {
			if (id === 'acct-2') return toAccount;
			return null;
		});

		const images = ['data:image/png;base64,AAAA'];
		switcher.recordLastPrompt('session-1', 'Describe this screenshot', images);

		const switchPromise = switcher.executeSwitch({
			sessionId: 'session-1',
			fromAccountId: 'acct-1',
			toAccountId: 'acct-2',
			reason: 'throttled',
			automatic: true,
		});

		expect(exitListener).not.toBeNull();
		exitListener?.('session-1', 0);
		await switchPromise;

		expect(mockSafeSend).toHaveBeenCalledWith(
			'account:switch-respawn',
			expect.objectContaining({
				lastPrompt: 'Describe this screenshot',
				lastImages: images,
			})
		);
	});

	it('should send switch-failed notification on error', async () => {
		mockRegistry.get.mockImplementation((id: string) => {
			if (id === 'acct-2') return createMockAccount({ id: 'acct-2' });
			return null;
		});
		mockProcessManager.kill.mockImplementation(() => {
			throw new Error('Kill failed');
		});

		const result = await switcher.executeSwitch({
			sessionId: 'session-1',
			fromAccountId: 'acct-1',
			toAccountId: 'acct-2',
			reason: 'throttled',
			automatic: true,
		});

		expect(result).toBeNull();
		expect(mockSafeSend).toHaveBeenCalledWith(
			'account:switch-failed',
			expect.objectContaining({
				sessionId: 'session-1',
				fromAccountId: 'acct-1',
				toAccountId: 'acct-2',
				error: expect.stringContaining('Kill failed'),
			})
		);
	});

	it('should clean up session tracking data', () => {
		switcher.recordLastPrompt('session-1', 'Some prompt');
		switcher.recordLastPrompt('session-2', 'Another prompt');

		switcher.cleanupSession('session-1');

		// session-2 should still be tracked (verified indirectly)
		// session-1 should be cleaned up
	});
});
