/**
 * Tests for injectAccountEnv.
 * Validates account injection, statsDB passthrough to selectNextAccount,
 * and fallback behavior when statsDB is unavailable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccountProfile } from '../../../shared/account-types';
import type {
	AccountRegistry,
	AccountUsageStatsProvider,
} from '../../../main/accounts/account-registry';

// Hoist mocks
const { mockExistsSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
}));

vi.mock('fs', () => ({
	existsSync: mockExistsSync,
	default: { existsSync: mockExistsSync },
}));

vi.mock('../../../main/accounts/account-setup', () => ({
	syncCredentialsFromBase: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

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
		lastUsedAt: 0,
		lastThrottledAt: 0,
		tokenLimitPerWindow: 0,
		tokenWindowMs: 5 * 60 * 60 * 1000,
		isDefault: false,
		autoSwitchEnabled: true,
		...overrides,
	};
}

describe('injectAccountEnv', () => {
	let mockRegistry: {
		getAll: ReturnType<typeof vi.fn>;
		get: ReturnType<typeof vi.fn>;
		getAssignment: ReturnType<typeof vi.fn>;
		getDefaultAccount: ReturnType<typeof vi.fn>;
		selectNextAccount: ReturnType<typeof vi.fn>;
		assignToSession: ReturnType<typeof vi.fn>;
	};
	let mockSafeSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(true);

		mockRegistry = {
			getAll: vi.fn().mockReturnValue([createMockAccount()]),
			get: vi.fn().mockReturnValue(createMockAccount()),
			getAssignment: vi.fn().mockReturnValue(null),
			getDefaultAccount: vi.fn().mockReturnValue(null),
			selectNextAccount: vi.fn().mockReturnValue(createMockAccount()),
			assignToSession: vi
				.fn()
				.mockReturnValue({ sessionId: 'sess-1', accountId: 'acct-1', assignedAt: Date.now() }),
		};

		mockSafeSend = vi.fn();
	});

	async function loadInjector() {
		// Dynamic import to get fresh module after mocks are set up
		const mod = await import('../../../main/accounts/account-env-injector');
		return mod.injectAccountEnv;
	}

	it('should return null for non-claude-code agents', async () => {
		const injectAccountEnv = await loadInjector();
		const env: Record<string, string | undefined> = {};
		const result = injectAccountEnv(
			'sess-1',
			'terminal',
			env,
			mockRegistry as unknown as AccountRegistry
		);
		expect(result).toBeNull();
	});

	it('should respect existing CLAUDE_CONFIG_DIR in env', async () => {
		const injectAccountEnv = await loadInjector();
		const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: '/custom/dir' };
		const result = injectAccountEnv(
			'sess-1',
			'claude-code',
			env,
			mockRegistry as unknown as AccountRegistry
		);
		expect(result).toBeNull();
		expect(env.CLAUDE_CONFIG_DIR).toBe('/custom/dir');
	});

	it('should return null when no active accounts exist', async () => {
		const injectAccountEnv = await loadInjector();
		mockRegistry.getAll.mockReturnValue([]);
		const env: Record<string, string | undefined> = {};
		const result = injectAccountEnv(
			'sess-1',
			'claude-code',
			env,
			mockRegistry as unknown as AccountRegistry
		);
		expect(result).toBeNull();
	});

	it('should use provided accountId when specified', async () => {
		const injectAccountEnv = await loadInjector();
		const env: Record<string, string | undefined> = {};
		const result = injectAccountEnv(
			'sess-1',
			'claude-code',
			env,
			mockRegistry as unknown as AccountRegistry,
			'acct-1'
		);
		expect(result).toBe('acct-1');
		expect(env.CLAUDE_CONFIG_DIR).toBe('/home/test/.claude-test');
		expect(mockRegistry.selectNextAccount).not.toHaveBeenCalled();
	});

	it('should call selectNextAccount without statsDB when getStatsDB is not provided', async () => {
		const injectAccountEnv = await loadInjector();
		mockRegistry.getDefaultAccount.mockReturnValue(null);
		const env: Record<string, string | undefined> = {};

		const result = injectAccountEnv(
			'sess-1',
			'claude-code',
			env,
			mockRegistry as unknown as AccountRegistry,
			undefined,
			mockSafeSend
		);

		expect(result).toBe('acct-1');
		expect(mockRegistry.selectNextAccount).toHaveBeenCalledWith([], undefined, 'claude-code');
	});

	it('should pass statsDB to selectNextAccount when getStatsDB is provided', async () => {
		const injectAccountEnv = await loadInjector();
		mockRegistry.getDefaultAccount.mockReturnValue(null);
		const env: Record<string, string | undefined> = {};

		const mockStatsDB: AccountUsageStatsProvider = {
			getAccountUsageInWindow: vi.fn(),
			isReady: vi.fn().mockReturnValue(true),
		};

		const result = injectAccountEnv(
			'sess-1',
			'claude-code',
			env,
			mockRegistry as unknown as AccountRegistry,
			undefined,
			mockSafeSend,
			() => mockStatsDB
		);

		expect(result).toBe('acct-1');
		expect(mockRegistry.selectNextAccount).toHaveBeenCalledWith([], mockStatsDB, 'claude-code');
	});

	it('should pass undefined to selectNextAccount when getStatsDB returns null', async () => {
		const injectAccountEnv = await loadInjector();
		mockRegistry.getDefaultAccount.mockReturnValue(null);
		const env: Record<string, string | undefined> = {};

		const result = injectAccountEnv(
			'sess-1',
			'claude-code',
			env,
			mockRegistry as unknown as AccountRegistry,
			undefined,
			mockSafeSend,
			() => null
		);

		expect(result).toBe('acct-1');
		expect(mockRegistry.selectNextAccount).toHaveBeenCalledWith([], undefined, 'claude-code');
	});

	it('should skip selectNextAccount when default account exists', async () => {
		const injectAccountEnv = await loadInjector();
		const defaultAccount = createMockAccount({ id: 'default-1', name: 'Default' });
		mockRegistry.getDefaultAccount.mockReturnValue(defaultAccount);
		mockRegistry.get.mockReturnValue(defaultAccount);
		const env: Record<string, string | undefined> = {};

		const result = injectAccountEnv(
			'sess-1',
			'claude-code',
			env,
			mockRegistry as unknown as AccountRegistry,
			undefined,
			mockSafeSend
		);

		expect(result).toBe('default-1');
		expect(mockRegistry.selectNextAccount).not.toHaveBeenCalled();
	});

	it('should notify renderer via safeSend when account is assigned', async () => {
		const injectAccountEnv = await loadInjector();
		const env: Record<string, string | undefined> = {};

		injectAccountEnv(
			'sess-1',
			'claude-code',
			env,
			mockRegistry as unknown as AccountRegistry,
			'acct-1',
			mockSafeSend
		);

		expect(mockSafeSend).toHaveBeenCalledWith('account:assigned', {
			sessionId: 'sess-1',
			accountId: 'acct-1',
			accountName: 'Test Account',
		});
	});

	describe('provider parity', () => {
		it('should inject CODEX_HOME for codex accounts', async () => {
			const injectAccountEnv = await loadInjector();
			const codexAccount = createMockAccount({
				id: 'codex-1',
				agentType: 'codex',
				configDir: '/home/test/.codex-work',
			});
			mockRegistry.getAll.mockReturnValue([codexAccount]);
			mockRegistry.get.mockReturnValue(codexAccount);
			const env: Record<string, string | undefined> = {};

			const result = injectAccountEnv(
				'sess-1',
				'codex',
				env,
				mockRegistry as unknown as AccountRegistry,
				'codex-1'
			);

			expect(result).toBe('codex-1');
			expect(env.CODEX_HOME).toBe('/home/test/.codex-work');
			expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
		});

		it('should inject XDG_DATA_HOME for opencode accounts', async () => {
			const injectAccountEnv = await loadInjector();
			const ocAccount = createMockAccount({
				id: 'oc-1',
				agentType: 'opencode',
				configDir: '/home/test/.opencode-work',
			});
			mockRegistry.getAll.mockReturnValue([ocAccount]);
			mockRegistry.get.mockReturnValue(ocAccount);
			const env: Record<string, string | undefined> = {};

			const result = injectAccountEnv(
				'sess-1',
				'opencode',
				env,
				mockRegistry as unknown as AccountRegistry,
				'oc-1'
			);

			expect(result).toBe('oc-1');
			expect(env.XDG_DATA_HOME).toBe('/home/test/.opencode-work');
		});

		it('should respect existing CODEX_HOME in env', async () => {
			const injectAccountEnv = await loadInjector();
			const env: Record<string, string | undefined> = { CODEX_HOME: '/custom/codex' };
			const result = injectAccountEnv(
				'sess-1',
				'codex',
				env,
				mockRegistry as unknown as AccountRegistry
			);
			expect(result).toBeNull();
			expect(env.CODEX_HOME).toBe('/custom/codex');
		});

		it('should return null for providers without a config-dir env var', async () => {
			const injectAccountEnv = await loadInjector();
			const env: Record<string, string | undefined> = {};
			for (const agentType of ['gemini-cli', 'factory-droid']) {
				expect(
					injectAccountEnv('sess-1', agentType, env, mockRegistry as unknown as AccountRegistry)
				).toBeNull();
			}
			expect(env).toEqual({});
		});

		it('should not route a claude session to a codex account', async () => {
			const injectAccountEnv = await loadInjector();
			const codexAccount = createMockAccount({
				id: 'codex-1',
				agentType: 'codex',
				configDir: '/home/test/.codex-work',
			});
			mockRegistry.getAll.mockReturnValue([codexAccount]);
			mockRegistry.getDefaultAccount.mockReturnValue(null);
			mockRegistry.selectNextAccount.mockReturnValue(null);
			const env: Record<string, string | undefined> = {};

			const result = injectAccountEnv(
				'sess-1',
				'claude-code',
				env,
				mockRegistry as unknown as AccountRegistry
			);

			expect(result).toBeNull();
			expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
			expect(env.CODEX_HOME).toBeUndefined();
		});

		it('should ignore an existing assignment pointing at another provider', async () => {
			const injectAccountEnv = await loadInjector();
			const claudeAccount = createMockAccount();
			const codexAccount = createMockAccount({
				id: 'codex-1',
				agentType: 'codex',
				configDir: '/home/test/.codex-work',
			});
			mockRegistry.getAll.mockReturnValue([claudeAccount, codexAccount]);
			mockRegistry.getAssignment.mockReturnValue({
				sessionId: 'sess-1',
				accountId: 'codex-1',
				assignedAt: Date.now(),
			});
			mockRegistry.get.mockImplementation((id: string) =>
				id === 'codex-1' ? codexAccount : claudeAccount
			);
			mockRegistry.getDefaultAccount.mockReturnValue(claudeAccount);
			const env: Record<string, string | undefined> = {};

			const result = injectAccountEnv(
				'sess-1',
				'claude-code',
				env,
				mockRegistry as unknown as AccountRegistry
			);

			expect(result).toBe('acct-1');
			expect(env.CLAUDE_CONFIG_DIR).toBe('/home/test/.claude-test');
		});
	});
});
