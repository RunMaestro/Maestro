import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// Hoist mock functions so they can be used in vi.mock factories
const {
	TEST_HOME,
	mockStat, mockAccess, mockReadFile, mockReaddir,
	mockMkdir, mockLstat, mockSymlink, mockUnlink, mockRm,
	mockExecFile,
} = vi.hoisted(() => ({
	TEST_HOME: '/home/testuser',
	mockStat: vi.fn(),
	mockAccess: vi.fn(),
	mockReadFile: vi.fn(),
	mockReaddir: vi.fn(),
	mockMkdir: vi.fn(),
	mockLstat: vi.fn(),
	mockSymlink: vi.fn(),
	mockUnlink: vi.fn(),
	mockRm: vi.fn(),
	mockExecFile: vi.fn(),
}));

// Mock fs/promises module
vi.mock('fs/promises', () => ({
	default: {
		stat: mockStat,
		access: mockAccess,
		readFile: mockReadFile,
		readdir: mockReaddir,
		mkdir: mockMkdir,
		lstat: mockLstat,
		symlink: mockSymlink,
		unlink: mockUnlink,
		rm: mockRm,
	},
	stat: mockStat,
	access: mockAccess,
	readFile: mockReadFile,
	readdir: mockReaddir,
	mkdir: mockMkdir,
	lstat: mockLstat,
	symlink: mockSymlink,
	unlink: mockUnlink,
	rm: mockRm,
}));

// Mock os module
vi.mock('os', () => ({
	default: {
		homedir: vi.fn().mockReturnValue(TEST_HOME),
	},
	homedir: vi.fn().mockReturnValue(TEST_HOME),
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

// Mock child_process for SSH validation
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: {
			...actual,
			execFile: mockExecFile,
		},
		execFile: mockExecFile,
	};
});

// Mock util.promisify for execFile
vi.mock('util', async (importOriginal) => {
	const actual = await importOriginal<typeof import('util')>();
	return {
		...actual,
		default: {
			...actual,
			promisify: (fn: any) => {
				if (fn === mockExecFile) {
					return async (...args: any[]) => {
						return new Promise((resolve, reject) => {
							mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
								if (error) reject(error);
								else resolve({ stdout, stderr });
							});
						});
					};
				}
				return actual.promisify(fn);
			},
		},
		promisify: (fn: any) => {
			if (fn === mockExecFile) {
				return async (...args: any[]) => {
					return new Promise((resolve, reject) => {
						mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
							if (error) reject(error);
							else resolve({ stdout, stderr });
						});
					});
				};
			}
			return actual.promisify(fn);
		},
	};
});

import {
	validateBaseClaudeDir,
	discoverExistingAccounts,
	readAccountEmail,
	createAccountDirectory,
	validateAccountSymlinks,
	repairAccountSymlinks,
	buildLoginCommand,
	removeAccountDirectory,
	validateRemoteAccountDir,
} from '../../../main/accounts/account-setup';

describe('account-setup', () => {
	const baseDir = path.join(TEST_HOME, '.claude');

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('validateBaseClaudeDir', () => {
		it('should return valid when .claude dir and .claude.json exist', async () => {
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockAccess.mockResolvedValue(undefined);

			const result = await validateBaseClaudeDir();
			expect(result.valid).toBe(true);
			expect(result.baseDir).toBe(baseDir);
			expect(result.errors).toHaveLength(0);
		});

		it('should return errors when .claude dir does not exist', async () => {
			mockStat.mockRejectedValue(new Error('ENOENT'));
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			const result = await validateBaseClaudeDir();
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain('does not exist');
		});

		it('should report missing .claude.json', async () => {
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			const result = await validateBaseClaudeDir();
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('No .claude.json found — Claude Code may not be authenticated.');
		});
	});

	describe('readAccountEmail', () => {
		it('should extract email from .claude.json', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify({ email: 'user@example.com' }));
			const email = await readAccountEmail('/fake/.claude-test');
			expect(email).toBe('user@example.com');
		});

		it('should try alternative field names', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify({ accountEmail: 'alt@example.com' }));
			const email = await readAccountEmail('/fake/.claude-test');
			expect(email).toBe('alt@example.com');
		});

		it('should return null for unreadable file', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT'));
			const email = await readAccountEmail('/fake/.claude-test');
			expect(email).toBeNull();
		});

		it('should return null for invalid JSON', async () => {
			mockReadFile.mockResolvedValue('not-json');
			const email = await readAccountEmail('/fake/.claude-test');
			expect(email).toBeNull();
		});

		it('should extract nested email from oauthAccount', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify({
				oauthAccount: { email: 'nested@example.com' },
			}));
			const email = await readAccountEmail('/fake/.claude-test');
			expect(email).toBe('nested@example.com');
		});
	});

	describe('buildLoginCommand', () => {
		it('should build command with default binary', () => {
			const cmd = buildLoginCommand('/home/user/.claude-work');
			expect(cmd).toBe('CLAUDE_CONFIG_DIR="/home/user/.claude-work" claude login');
		});

		it('should build command with custom binary path', () => {
			const cmd = buildLoginCommand('/home/user/.claude-work', '/usr/local/bin/claude');
			expect(cmd).toBe('CLAUDE_CONFIG_DIR="/home/user/.claude-work" /usr/local/bin/claude login');
		});
	});

	describe('createAccountDirectory', () => {
		it('should fail if directory already exists', async () => {
			mockAccess.mockResolvedValue(undefined);

			const result = await createAccountDirectory('test');
			expect(result.success).toBe(false);
			expect(result.error).toContain('already exists');
		});

		it('should fail if base dir validation fails', async () => {
			mockAccess.mockRejectedValue(new Error('ENOENT'));
			mockStat.mockRejectedValue(new Error('ENOENT'));

			const result = await createAccountDirectory('test');
			expect(result.success).toBe(false);
			expect(result.error).toContain('does not exist');
		});

		it('should create directory and symlinks when base dir is valid', async () => {
			mockAccess.mockImplementation(async (p: string) => {
				const pStr = String(p);
				if (pStr.endsWith('.claude-newacct')) {
					throw new Error('ENOENT');
				}
				return undefined;
			});
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockMkdir.mockResolvedValue(undefined);
			mockLstat.mockRejectedValue(new Error('ENOENT'));
			mockSymlink.mockResolvedValue(undefined);

			const result = await createAccountDirectory('newacct');
			expect(result.success).toBe(true);
			expect(result.configDir).toBe(path.join(TEST_HOME, '.claude-newacct'));
			expect(mockMkdir).toHaveBeenCalled();
			expect(mockSymlink).toHaveBeenCalled();
		});
	});

	describe('validateAccountSymlinks', () => {
		it('should report valid when all symlinks are intact', async () => {
			mockLstat.mockResolvedValue({ isSymbolicLink: () => true });
			mockStat.mockResolvedValue({});

			const result = await validateAccountSymlinks('/fake/.claude-test');
			expect(result.valid).toBe(true);
			expect(result.broken).toHaveLength(0);
			expect(result.missing).toHaveLength(0);
		});

		it('should report broken symlinks', async () => {
			mockLstat.mockResolvedValue({ isSymbolicLink: () => true });
			mockStat.mockRejectedValue(new Error('ENOENT'));

			const result = await validateAccountSymlinks('/fake/.claude-test');
			expect(result.valid).toBe(false);
			expect(result.broken.length).toBeGreaterThan(0);
		});

		it('should report missing symlinks when source exists', async () => {
			mockLstat.mockRejectedValue(new Error('ENOENT'));
			mockAccess.mockResolvedValue(undefined);

			const result = await validateAccountSymlinks('/fake/.claude-test');
			expect(result.valid).toBe(false);
			expect(result.missing.length).toBeGreaterThan(0);
		});
	});

	describe('removeAccountDirectory', () => {
		it('should reject non-.claude- directories', async () => {
			const result = await removeAccountDirectory('/home/user/important-stuff');
			expect(result.success).toBe(false);
			expect(result.error).toContain('Safety check');
		});

		it('should remove valid .claude- directories', async () => {
			mockRm.mockResolvedValue(undefined);

			const result = await removeAccountDirectory(path.join(TEST_HOME, '.claude-test'));
			expect(result.success).toBe(true);
		});

		it('should handle rm errors gracefully', async () => {
			mockRm.mockRejectedValue(new Error('Permission denied'));

			const result = await removeAccountDirectory(path.join(TEST_HOME, '.claude-test'));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});
	});

	describe('discoverExistingAccounts', () => {
		it('should find .claude-* directories', async () => {
			mockReaddir.mockResolvedValue([
				{ name: '.claude-work', isDirectory: () => true, isSymbolicLink: () => false },
				{ name: '.claude-personal', isDirectory: () => true, isSymbolicLink: () => false },
				{ name: '.bashrc', isDirectory: () => false, isSymbolicLink: () => false },
				{ name: 'Documents', isDirectory: () => true, isSymbolicLink: () => false },
			]);

			mockReadFile.mockImplementation(async (p: string) => {
				if (String(p).includes('.claude-work')) {
					return JSON.stringify({ email: 'work@example.com' });
				}
				throw new Error('ENOENT');
			});

			const accounts = await discoverExistingAccounts();
			expect(accounts).toHaveLength(2);
			expect(accounts[0].name).toBe('work');
			expect(accounts[0].email).toBe('work@example.com');
			expect(accounts[0].hasAuth).toBe(true);
			expect(accounts[1].name).toBe('personal');
			expect(accounts[1].email).toBeNull();
			expect(accounts[1].hasAuth).toBe(false);
		});
	});

	describe('repairAccountSymlinks', () => {
		it('should repair broken and missing symlinks', async () => {
			mockLstat.mockImplementation(async (p: string) => {
				const pStr = String(p);
				if (pStr.endsWith('/commands')) {
					return { isSymbolicLink: () => true };
				}
				throw new Error('ENOENT');
			});
			mockStat.mockRejectedValue(new Error('ENOENT'));
			mockAccess.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockSymlink.mockResolvedValue(undefined);

			const result = await repairAccountSymlinks('/fake/.claude-test');
			expect(result.errors).toHaveLength(0);
			expect(result.repaired.length).toBeGreaterThan(0);
		});
	});

	describe('validateRemoteAccountDir', () => {
		it('should validate existing remote directory', async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, args: string[], _opts: any, callback: any) => {
					const command = args[args.length - 1];
					if (command.includes('DIR_EXISTS')) {
						callback(null, 'DIR_EXISTS\n', '');
					} else if (command.includes('AUTH_EXISTS')) {
						callback(null, 'AUTH_EXISTS\n', '');
					} else if (command.includes('SYMLINKS_OK')) {
						callback(null, 'SYMLINKS_OK\n', '');
					}
				},
			);

			const result = await validateRemoteAccountDir(
				{ host: 'example.com', user: 'dev' },
				'~/.claude-work',
			);

			expect(result.exists).toBe(true);
			expect(result.hasAuth).toBe(true);
			expect(result.symlinksValid).toBe(true);
		});

		it('should detect missing remote directory', async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, callback: any) => {
					callback(null, 'DIR_MISSING\n', '');
				},
			);

			const result = await validateRemoteAccountDir(
				{ host: 'example.com' },
				'~/.claude-work',
			);

			expect(result.exists).toBe(false);
			expect(result.hasAuth).toBe(false);
			expect(result.symlinksValid).toBe(false);
		});

		it('should handle SSH connection errors', async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, callback: any) => {
					callback(new Error('Connection refused'), '', '');
				},
			);

			const result = await validateRemoteAccountDir(
				{ host: 'example.com', user: 'dev', port: 2222 },
				'~/.claude-work',
			);

			expect(result.exists).toBe(false);
			expect(result.error).toContain('Connection refused');
		});

		it('should include port in SSH args', async () => {
			mockExecFile.mockImplementation(
				(_cmd: string, args: string[], _opts: any, callback: any) => {
					expect(args).toContain('-p');
					expect(args).toContain('2222');
					callback(null, 'DIR_MISSING\n', '');
				},
			);

			await validateRemoteAccountDir(
				{ host: 'example.com', port: 2222 },
				'~/.claude-work',
			);
		});
	});
});
