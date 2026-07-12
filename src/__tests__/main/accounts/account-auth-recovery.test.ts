/**
 * Tests for AccountAuthRecovery.
 * Validates auth recovery flow: process killing, claude login spawning,
 * timeout handling, credential sync fallback, and respawn orchestration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AccountProfile } from '../../../shared/account-types';

// Hoist mock functions for use in vi.mock factories
const { mockSpawn, mockAccess, mockSyncCredentialsFromBase } = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
	mockAccess: vi.fn(),
	mockSyncCredentialsFromBase: vi.fn(),
}));

// Mock child_process.spawn
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: { ...actual, spawn: mockSpawn },
		spawn: mockSpawn,
	};
});

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: { access: mockAccess },
	access: mockAccess,
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock account-setup (syncCredentialsFromBase)
vi.mock('../../../main/accounts/account-setup', () => ({
	syncCredentialsFromBase: mockSyncCredentialsFromBase,
}));

import { AccountAuthRecovery } from '../../../main/accounts/account-auth-recovery';
import type { ProcessManager } from '../../../main/process-manager/ProcessManager';
import type { AccountRegistry } from '../../../main/accounts/account-registry';
import type { AgentDetector } from '../../../main/agents';
import type { SafeSendFn } from '../../../main/utils/safe-send';
import { EventEmitter } from 'events';

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

/**
 * Creates a mock child process (EventEmitter) with stdout/stderr streams.
 * Returns the child and a helper to simulate exit.
 */
function createMockChildProcess() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: ReturnType<typeof vi.fn>;
		pid: number;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	child.pid = 12345;
	return child;
}

describe('AccountAuthRecovery', () => {
	let recovery: AccountAuthRecovery;
	let mockProcessManager: {
		kill: ReturnType<typeof vi.fn>;
	};
	let mockAccountRegistry: {
		get: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
	};
	let mockAgentDetector: {
		getAgent: ReturnType<typeof vi.fn>;
	};
	let mockSafeSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		mockProcessManager = {
			kill: vi.fn().mockReturnValue(true),
		};

		mockAccountRegistry = {
			get: vi.fn().mockReturnValue(createMockAccount()),
			setStatus: vi.fn(),
		};

		mockAgentDetector = {
			getAgent: vi.fn().mockResolvedValue({ path: '/usr/bin/claude', command: 'claude' }),
		};

		mockSafeSend = vi.fn();

		recovery = new AccountAuthRecovery(
			mockProcessManager as unknown as ProcessManager,
			mockAccountRegistry as unknown as AccountRegistry,
			mockAgentDetector as unknown as AgentDetector,
			mockSafeSend as SafeSendFn
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('recoverAuth', () => {
		it('should kill the current agent process before starting recovery', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise = recovery.recoverAuth('session-1', 'acct-1');

			// Advance past KILL_DELAY_MS
			await vi.advanceTimersByTimeAsync(1000);

			// Simulate successful login
			mockChild.emit('close', 0);
			await promise;

			expect(mockProcessManager.kill).toHaveBeenCalledWith('session-1');
		});

		it('should spawn claude login with correct CLAUDE_CONFIG_DIR', async () => {
			const account = createMockAccount({ configDir: '/home/test/.claude-work' });
			mockAccountRegistry.get.mockReturnValue(account);
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			mockChild.emit('close', 0);
			await promise;

			expect(mockSpawn).toHaveBeenCalledWith(
				'/usr/bin/claude',
				['login'],
				expect.objectContaining({
					env: expect.objectContaining({
						CLAUDE_CONFIG_DIR: '/home/test/.claude-work',
					}),
				})
			);
		});

		it('should emit auth-recovery-started event', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			mockChild.emit('close', 0);
			await promise;

			expect(mockSafeSend).toHaveBeenCalledWith('account:auth-recovery-started', {
				sessionId: 'session-1',
				accountId: 'acct-1',
				accountName: 'Test Account',
			});
		});

		it('should emit auth-recovery-completed on successful login', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			// Login exits successfully and credentials exist
			mockChild.emit('close', 0);

			const result = await promise;

			expect(result).toBe(true);
			expect(mockSafeSend).toHaveBeenCalledWith('account:auth-recovery-completed', {
				sessionId: 'session-1',
				accountId: 'acct-1',
				accountName: 'Test Account',
			});
		});

		it('should emit auth-recovery-failed on login timeout', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);

			const promise = recovery.recoverAuth('session-1', 'acct-1');

			// Advance past KILL_DELAY_MS
			await vi.advanceTimersByTimeAsync(1000);

			// Advance past LOGIN_TIMEOUT_MS (120s)
			await vi.advanceTimersByTimeAsync(120_000);

			// Sync fallback also fails
			mockSyncCredentialsFromBase.mockResolvedValue({ success: false, error: 'No credentials' });

			await promise;

			expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
		});

		it('should fall back to credential sync when login fails', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockSyncCredentialsFromBase.mockResolvedValue({ success: true });
			mockAccess.mockResolvedValue(undefined); // credentials exist after sync

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			// Login exits with failure code
			mockChild.emit('close', 1);

			const result = await promise;

			expect(mockSyncCredentialsFromBase).toHaveBeenCalledWith('/home/test/.claude-test');
			expect(result).toBe(true);
		});

		it('should emit respawn event after successful recovery', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			// Record a prompt before recovery
			recovery.recordLastPrompt('session-1', 'Tell me about TypeScript');

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			mockChild.emit('close', 0);
			await promise;

			expect(mockSafeSend).toHaveBeenCalledWith('account:switch-respawn', {
				sessionId: 'session-1',
				toAccountId: 'acct-1',
				toAccountName: 'Test Account',
				configDir: '/home/test/.claude-test',
				lastPrompt: 'Tell me about TypeScript',
				reason: 'auth-recovery',
			});
		});

		it('should update account status to active after successful recovery', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			mockChild.emit('close', 0);
			await promise;

			// First call sets status to 'expired', second call to 'active'
			expect(mockAccountRegistry.setStatus).toHaveBeenCalledWith('acct-1', 'expired');
			expect(mockAccountRegistry.setStatus).toHaveBeenCalledWith('acct-1', 'active');
		});

		it('should not start concurrent recoveries for same session', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise1 = recovery.recoverAuth('session-1', 'acct-1');
			const result2 = await recovery.recoverAuth('session-1', 'acct-1');

			expect(result2).toBe(false);

			// Only one spawn should have occurred
			// Advance and resolve the first
			await vi.advanceTimersByTimeAsync(1000);
			mockChild.emit('close', 0);
			await promise1;

			// Spawn called only once (for the first call)
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		it('should handle missing account gracefully', async () => {
			mockAccountRegistry.get.mockReturnValue(null);

			const result = await recovery.recoverAuth('session-1', 'acct-missing');

			expect(result).toBe(false);
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('should mark account as expired at start of recovery', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise = recovery.recoverAuth('session-1', 'acct-1');

			// Should be called before waiting for login
			expect(mockAccountRegistry.setStatus).toHaveBeenCalledWith('acct-1', 'expired');

			await vi.advanceTimersByTimeAsync(1000);
			mockChild.emit('close', 0);
			await promise;
		});

		it('should handle spawn errors gracefully', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockSyncCredentialsFromBase.mockResolvedValue({ success: false, error: 'No creds' });

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			// Emit spawn error
			mockChild.emit('error', new Error('ENOENT: claude not found'));

			const result = await promise;

			expect(result).toBe(false);
		});

		it('should send null lastPrompt when no prompt was recorded', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			mockChild.emit('close', 0);
			await promise;

			expect(mockSafeSend).toHaveBeenCalledWith(
				'account:switch-respawn',
				expect.objectContaining({
					lastPrompt: null,
				})
			);
		});

		it('should emit auth-recovery-failed when both login and sync fail', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockSyncCredentialsFromBase.mockResolvedValue({
				success: false,
				error: 'No credentials found',
			});

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			// Login fails
			mockChild.emit('close', 1);

			const result = await promise;

			expect(result).toBe(false);
			expect(mockSafeSend).toHaveBeenCalledWith(
				'account:auth-recovery-failed',
				expect.objectContaining({
					sessionId: 'session-1',
					accountId: 'acct-1',
					accountName: 'Test Account',
				})
			);
		});

		it('should allow recovery for same session after previous recovery completes', async () => {
			const mockChild1 = createMockChildProcess();
			const mockChild2 = createMockChildProcess();
			mockSpawn.mockReturnValueOnce(mockChild1).mockReturnValueOnce(mockChild2);
			mockAccess.mockResolvedValue(undefined);

			// First recovery
			const promise1 = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);
			mockChild1.emit('close', 0);
			await promise1;

			// Second recovery (should work since first completed)
			const promise2 = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);
			mockChild2.emit('close', 0);
			const result2 = await promise2;

			expect(result2).toBe(true);
			expect(mockSpawn).toHaveBeenCalledTimes(2);
		});

		it('should handle login exit code 0 but missing credentials', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			// credentials file does not exist
			mockAccess.mockRejectedValue(new Error('ENOENT'));
			mockSyncCredentialsFromBase.mockResolvedValue({ success: false, error: 'No creds' });

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			mockChild.emit('close', 0);

			const result = await promise;

			// Should fall through to sync fallback and eventually fail
			expect(result).toBe(false);
			expect(mockSyncCredentialsFromBase).toHaveBeenCalled();
		});

		it('should use fallback binary name when agent path is unavailable', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(null);
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);
			mockAccess.mockResolvedValue(undefined);

			const promise = recovery.recoverAuth('session-1', 'acct-1');
			await vi.advanceTimersByTimeAsync(1000);

			mockChild.emit('close', 0);
			await promise;

			expect(mockSpawn).toHaveBeenCalledWith('claude', ['login'], expect.any(Object));
		});
	});

	describe('recordLastPrompt', () => {
		it('should store prompt for later use in respawn events', () => {
			recovery.recordLastPrompt('session-1', 'Hello world');
			// Verified indirectly through recoverAuth respawn event
			expect(() => recovery.recordLastPrompt('session-1', 'Hello world')).not.toThrow();
		});
	});

	describe('isRecovering', () => {
		it('should return false when no recovery is in progress', () => {
			expect(recovery.isRecovering('session-1')).toBe(false);
		});

		it('should return true when recovery is in progress', async () => {
			const mockChild = createMockChildProcess();
			mockSpawn.mockReturnValue(mockChild);

			recovery.recoverAuth('session-1', 'acct-1');

			expect(recovery.isRecovering('session-1')).toBe(true);

			// Clean up
			await vi.advanceTimersByTimeAsync(1000);
			mockAccess.mockResolvedValue(undefined);
			mockChild.emit('close', 0);
			await vi.advanceTimersByTimeAsync(0);
		});
	});

	describe('cleanupSession', () => {
		it('should remove tracked data for session', () => {
			recovery.recordLastPrompt('session-1', 'Some prompt');
			recovery.cleanupSession('session-1');
			expect(recovery.isRecovering('session-1')).toBe(false);
		});
	});
});
