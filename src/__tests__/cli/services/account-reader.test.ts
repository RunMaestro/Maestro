/**
 * @file account-reader.test.ts
 * @description Tests for the CLI account reader service
 *
 * Tests reading account data from the electron-store JSON file,
 * filesystem discovery fallback, and account lookup helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import type { AccountProfile } from '../../../shared/account-types';

// Mock the fs module
vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	promises: {
		readdir: vi.fn(),
		readFile: vi.fn(),
		stat: vi.fn(),
	},
}));

// Mock the os module
vi.mock('os', () => ({
	platform: vi.fn(),
	homedir: vi.fn(),
}));

import {
	readAccountsFromStore,
	getDefaultAccount,
	getAccountByIdOrName,
} from '../../../cli/services/account-reader';

// Helper to build a mock AccountProfile
function mockProfile(overrides: Partial<AccountProfile> = {}): AccountProfile {
	return {
		id: 'acc-1',
		name: 'personal',
		email: 'user@example.com',
		configDir: '/home/testuser/.claude-personal',
		agentType: 'claude-code',
		status: 'active',
		authMethod: 'oauth',
		addedAt: 1000,
		lastUsedAt: 2000,
		lastThrottledAt: 0,
		tokenLimitPerWindow: 0,
		tokenWindowMs: 18000000,
		isDefault: true,
		autoSwitchEnabled: false,
		...overrides,
	};
}

describe('account-reader', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(os.platform).mockReturnValue('linux');
		vi.mocked(os.homedir).mockReturnValue('/home/testuser');
	});

	describe('readAccountsFromStore', () => {
		it('reads accounts from the store JSON file', async () => {
			const profile1 = mockProfile({ id: 'acc-1', name: 'personal', isDefault: true });
			const profile2 = mockProfile({
				id: 'acc-2',
				name: 'work',
				email: 'work@corp.com',
				configDir: '/home/testuser/.claude-work',
				isDefault: false,
			});

			const storeData = {
				accounts: {
					'acc-1': profile1,
					'acc-2': profile2,
				},
				assignments: {},
				switchConfig: {},
				rotationOrder: [],
				rotationIndex: 0,
			};

			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const accounts = await readAccountsFromStore();

			expect(accounts).toHaveLength(2);
			expect(accounts.find((a) => a.id === 'acc-1')).toMatchObject({
				id: 'acc-1',
				name: 'personal',
				email: 'user@example.com',
				isDefault: true,
				status: 'active',
			});
			expect(accounts.find((a) => a.id === 'acc-2')).toMatchObject({
				id: 'acc-2',
				name: 'work',
				email: 'work@corp.com',
				isDefault: false,
			});
		});

		it('returns empty array when store has no accounts', async () => {
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({ accounts: {}, assignments: {} })
			);

			const accounts = await readAccountsFromStore();
			expect(accounts).toHaveLength(0);
		});

		it('falls back to filesystem discovery when store file missing', async () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});

			vi.mocked(fs.promises.readdir).mockResolvedValue([
				{ name: '.claude-personal', isDirectory: () => true } as unknown as fs.Dirent,
				{ name: '.bashrc', isDirectory: () => false } as unknown as fs.Dirent,
				{ name: 'Documents', isDirectory: () => true } as unknown as fs.Dirent,
			]);

			vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));

			const accounts = await readAccountsFromStore();
			expect(accounts).toHaveLength(1);
			expect(accounts[0]).toMatchObject({
				id: 'personal',
				name: 'personal',
				configDir: '/home/testuser/.claude-personal',
				status: 'active',
			});
		});

		it('reads email from .claude.json during filesystem discovery', async () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});

			vi.mocked(fs.promises.readdir).mockResolvedValue([
				{ name: '.claude-work', isDirectory: () => true } as unknown as fs.Dirent,
			]);

			vi.mocked(fs.promises.readFile).mockResolvedValue(
				JSON.stringify({ email: 'dev@company.com' })
			);

			const accounts = await readAccountsFromStore();
			expect(accounts[0].email).toBe('dev@company.com');
		});

		it('handles macOS store path', async () => {
			vi.mocked(os.platform).mockReturnValue('darwin');

			const storeData = {
				accounts: { 'acc-1': mockProfile() },
				assignments: {},
			};
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const accounts = await readAccountsFromStore();
			expect(accounts).toHaveLength(1);

			// Should try macOS path first
			expect(fs.readFileSync).toHaveBeenCalledWith(
				'/home/testuser/Library/Application Support/Maestro/maestro-accounts.json',
				'utf-8'
			);
		});
	});

	describe('getDefaultAccount', () => {
		it('returns the default active account', async () => {
			const storeData = {
				accounts: {
					'acc-1': mockProfile({ id: 'acc-1', isDefault: false }),
					'acc-2': mockProfile({ id: 'acc-2', isDefault: true }),
				},
			};
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const account = await getDefaultAccount();
			expect(account?.id).toBe('acc-2');
		});

		it('returns first active account when no default set', async () => {
			const storeData = {
				accounts: {
					'acc-1': mockProfile({ id: 'acc-1', isDefault: false }),
				},
			};
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const account = await getDefaultAccount();
			expect(account?.id).toBe('acc-1');
		});

		it('skips throttled accounts when looking for default', async () => {
			const storeData = {
				accounts: {
					'acc-1': mockProfile({ id: 'acc-1', isDefault: true, status: 'throttled' }),
					'acc-2': mockProfile({ id: 'acc-2', isDefault: false, status: 'active' }),
				},
			};
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const account = await getDefaultAccount();
			expect(account?.id).toBe('acc-2');
		});

		it('returns null when no accounts exist', async () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ accounts: {} }));

			const account = await getDefaultAccount();
			expect(account).toBeNull();
		});
	});

	describe('getAccountByIdOrName', () => {
		const storeData = {
			accounts: {
				'acc-1': mockProfile({ id: 'acc-1', name: 'personal' }),
				'acc-2': mockProfile({ id: 'acc-2', name: 'work' }),
			},
		};

		it('finds by ID', async () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const account = await getAccountByIdOrName('acc-2');
			expect(account?.name).toBe('work');
		});

		it('finds by name', async () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const account = await getAccountByIdOrName('personal');
			expect(account?.id).toBe('acc-1');
		});

		it('returns null when not found', async () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const account = await getAccountByIdOrName('nonexistent');
			expect(account).toBeNull();
		});
	});
});
