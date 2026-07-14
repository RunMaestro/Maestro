/**
 * @file account-reader.windows.test.ts
 * @description Windows regression tests for the CLI account reader service
 *
 * Runs the store-path resolution and filesystem-discovery logic with the
 * platform forced to win32 and a Windows-style home directory, locking in
 * the cross-platform behavior fixed in the Windows account parity work:
 * store paths resolve under %APPDATA% (honoring the env var, falling back
 * to AppData\Roaming), discovered configDir values are built with
 * path.join, and discovered accounts default to the claude-code provider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

import { readAccountsFromStore } from '../../../cli/services/account-reader';

const WIN_HOME = 'C:\\Users\\testuser';

describe('account-reader on Windows', () => {
	const originalPlatform = process.platform;
	const originalAppData = process.env.APPDATA;

	beforeEach(() => {
		vi.resetAllMocks();
		// isWindows() reads process.platform at call time; the store-path
		// resolution uses os.platform(). Force both to win32.
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		vi.mocked(os.platform).mockReturnValue('win32');
		vi.mocked(os.homedir).mockReturnValue(WIN_HOME);
		// Known-clean env state; tests that need APPDATA set it explicitly
		delete process.env.APPDATA;
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		if (originalAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = originalAppData;
		}
	});

	describe('store path resolution', () => {
		it('honors APPDATA and tries both Maestro and maestro casings', async () => {
			const appData = 'D:\\CustomProfiles\\testuser\\AppData\\Roaming';
			process.env.APPDATA = appData;

			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});
			vi.mocked(fs.promises.readdir).mockResolvedValue([]);

			await readAccountsFromStore();

			expect(fs.readFileSync).toHaveBeenNthCalledWith(
				1,
				path.join(appData, 'Maestro', 'maestro-accounts.json'),
				'utf-8'
			);
			expect(fs.readFileSync).toHaveBeenNthCalledWith(
				2,
				path.join(appData, 'maestro', 'maestro-accounts.json'),
				'utf-8'
			);
		});

		it('falls back to AppData\\Roaming under the home dir when APPDATA is not set', async () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});
			vi.mocked(fs.promises.readdir).mockResolvedValue([]);

			await readAccountsFromStore();

			const fallbackBase = path.join(WIN_HOME, 'AppData', 'Roaming');
			expect(fs.readFileSync).toHaveBeenNthCalledWith(
				1,
				path.join(fallbackBase, 'Maestro', 'maestro-accounts.json'),
				'utf-8'
			);
			expect(fs.readFileSync).toHaveBeenNthCalledWith(
				2,
				path.join(fallbackBase, 'maestro', 'maestro-accounts.json'),
				'utf-8'
			);
		});

		it('reads accounts from a store file found under APPDATA', async () => {
			const appData = path.join(WIN_HOME, 'AppData', 'Roaming');
			process.env.APPDATA = appData;

			const storeData = {
				accounts: {
					'acc-1': {
						id: 'acc-1',
						name: 'personal',
						email: 'user@example.com',
						configDir: path.join(WIN_HOME, '.claude-personal'),
						agentType: 'claude-code',
						status: 'active',
						isDefault: true,
					},
				},
				assignments: {},
			};
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData));

			const accounts = await readAccountsFromStore();

			expect(accounts).toHaveLength(1);
			expect(accounts[0]).toMatchObject({
				id: 'acc-1',
				name: 'personal',
				configDir: path.join(WIN_HOME, '.claude-personal'),
				agentType: 'claude-code',
			});
			expect(fs.readFileSync).toHaveBeenCalledWith(
				path.join(appData, 'Maestro', 'maestro-accounts.json'),
				'utf-8'
			);
		});
	});

	describe('filesystem discovery', () => {
		it('returns Windows-native configDir values built via path.join', async () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});
			vi.mocked(fs.promises.readdir).mockResolvedValue([
				{ name: '.claude-work', isDirectory: () => true } as unknown as fs.Dirent,
				{ name: '.claude-personal', isDirectory: () => true } as unknown as fs.Dirent,
				{ name: 'Documents', isDirectory: () => true } as unknown as fs.Dirent,
				{ name: 'ntuser.dat', isDirectory: () => false } as unknown as fs.Dirent,
			]);
			vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));

			const accounts = await readAccountsFromStore();

			expect(accounts).toHaveLength(2);
			expect(accounts[0]).toMatchObject({
				id: 'work',
				name: 'work',
				configDir: path.join(WIN_HOME, '.claude-work'),
				status: 'active',
			});
			expect(accounts[1]).toMatchObject({
				id: 'personal',
				name: 'personal',
				configDir: path.join(WIN_HOME, '.claude-personal'),
				status: 'active',
			});
			expect(fs.promises.readdir).toHaveBeenCalledWith(WIN_HOME, { withFileTypes: true });
		});

		it('defaults discovered accounts to the claude-code provider', async () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});
			vi.mocked(fs.promises.readdir).mockResolvedValue([
				{ name: '.claude-work', isDirectory: () => true } as unknown as fs.Dirent,
			]);
			vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));

			const accounts = await readAccountsFromStore();

			expect(accounts).toHaveLength(1);
			expect(accounts[0].agentType).toBe('claude-code');
		});
	});
});
