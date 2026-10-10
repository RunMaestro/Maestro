/**
 * Tests for path-prober.ts
 *
 * Tests the platform-specific binary detection logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock dependencies before importing the module
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../shared/pathUtils', () => ({
	expandTilde: vi.fn((p: string) => p.replace(/^~/, '/Users/testuser')),
	detectNodeVersionManagerBinPaths: vi.fn(() => []),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Import after mocking
import {
	getExpandedEnv,
	checkCustomPath,
	checkBinaryExists,
	probeWindowsPaths,
	probeUnixPaths,
	findAllBinaryPaths,
	type BinaryDetectionResult,
} from '../../../main/agents';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';

describe('path-prober', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('getExpandedEnv', () => {
		it('should return environment with PATH', () => {
			const env = getExpandedEnv();
			expect(env.PATH).toBeDefined();
			expect(typeof env.PATH).toBe('string');
		});

		it('should include common Unix paths on non-Windows', () => {
			const originalPlatform = process.platform;
			const originalPath = process.env.PATH;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			// Pin the inherited PATH: on a dev machine the real PATH already carries
			// these dirs, which would make the assertions pass even if getExpandedEnv
			// stopped adding them.
			process.env.PATH = '/inherited/only';

			try {
				const env = getExpandedEnv();
				expect(env.PATH).toContain('/opt/homebrew/bin');
				expect(env.PATH).toContain('/usr/local/bin');
				// ~/.bun/bin is where the bun-based omp binary installs; without it
				// consumers of getExpandedEnv() cannot resolve omp even though the
				// detection probe finds it there.
				expect(env.PATH).toContain(`${os.homedir()}/.bun/bin`);
			} finally {
				process.env.PATH = originalPath;
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should include nvm4w and npm paths on Windows', () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				const env = getExpandedEnv();
				// Check for nvm4w paths (OpenCode commonly installed here)
				expect(env.PATH).toContain('C:\\nvm4w\\nodejs');
				// Check for npm global paths
				expect(env.PATH).toMatch(/AppData[\\\/](npm|Roaming[\\\/]npm)/);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should preserve existing PATH entries', () => {
			const originalPath = process.env.PATH;
			const testPath = '/test/custom/path';
			process.env.PATH = testPath;

			try {
				const env = getExpandedEnv();
				expect(env.PATH).toContain(testPath);
			} finally {
				process.env.PATH = originalPath;
			}
		});
	});

	describe('checkCustomPath', () => {
		let statMock: ReturnType<typeof vi.spyOn>;
		let accessMock: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			statMock = vi.spyOn(fs.promises, 'stat');
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			statMock.mockRestore();
			accessMock.mockRestore();
		});

		it('should return exists: true for valid executable path on Unix', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				statMock.mockResolvedValue({ isFile: () => true } as fs.Stats);
				accessMock.mockResolvedValue(undefined);

				const result = await checkCustomPath('/usr/local/bin/claude');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('/usr/local/bin/claude');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should return exists: false for non-executable file on Unix', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				statMock.mockResolvedValue({ isFile: () => true } as fs.Stats);
				accessMock.mockRejectedValue(new Error('EACCES'));

				const result = await checkCustomPath('/path/to/non-executable');
				expect(result.exists).toBe(false);
				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining('not executable'),
					'PathProber'
				);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should return exists: false for non-existent path', async () => {
			statMock.mockRejectedValue(new Error('ENOENT'));

			const result = await checkCustomPath('/non/existent/path');
			expect(result.exists).toBe(false);
		});

		it('should expand tilde in path', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				statMock.mockResolvedValue({ isFile: () => true } as fs.Stats);
				accessMock.mockResolvedValue(undefined);

				const result = await checkCustomPath('~/.local/bin/claude');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('/Users/testuser/.local/bin/claude');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should try .exe extension on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				// First call (exact path) returns false, second call (.exe) returns true
				statMock
					.mockRejectedValueOnce(new Error('ENOENT'))
					.mockResolvedValueOnce({ isFile: () => true } as fs.Stats);

				const result = await checkCustomPath('C:\\custom\\claude');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('C:\\custom\\claude.exe');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should try .cmd extension on Windows if .exe not found', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				// First call (exact), second (.exe) return false, third (.cmd) returns true
				statMock
					.mockRejectedValueOnce(new Error('ENOENT'))
					.mockRejectedValueOnce(new Error('ENOENT'))
					.mockResolvedValueOnce({ isFile: () => true } as fs.Stats);

				const result = await checkCustomPath('C:\\custom\\claude');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('C:\\custom\\claude.cmd');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should skip executable check on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				statMock.mockResolvedValue({ isFile: () => true } as fs.Stats);
				// Don't mock access - it shouldn't be called for X_OK on Windows

				const result = await checkCustomPath('C:\\custom\\claude.exe');
				expect(result.exists).toBe(true);
				// access should not be called with X_OK on Windows
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should recover a rotated Codex Desktop executable path', async () => {
			const originalPlatform = process.platform;
			const originalLocalAppData = process.env.LOCALAPPDATA;
			const readdirMock = vi.spyOn(fs.promises, 'readdir');
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';

			const stalePath = path.win32.join(
				process.env.LOCALAPPDATA,
				'OpenAI',
				'Codex',
				'bin',
				'old-version',
				'codex.exe'
			);
			const olderPath = path.win32.join(
				process.env.LOCALAPPDATA,
				'OpenAI',
				'Codex',
				'bin',
				'older-version',
				'codex.exe'
			);
			const currentPath = path.win32.join(
				process.env.LOCALAPPDATA,
				'OpenAI',
				'Codex',
				'bin',
				'current-version',
				'codex.exe'
			);

			try {
				readdirMock.mockResolvedValue([
					{ name: 'older-version', isDirectory: () => true },
					{ name: 'current-version', isDirectory: () => true },
				] as any);
				statMock.mockImplementation(async (filePath) => {
					if (filePath === stalePath) throw new Error('ENOENT');
					if (filePath === olderPath) {
						return { isFile: () => true, birthtimeMs: 100, mtimeMs: 300 } as fs.Stats;
					}
					if (filePath === currentPath) {
						return { isFile: () => true, birthtimeMs: 200, mtimeMs: 100 } as fs.Stats;
					}
					throw new Error('ENOENT');
				});

				const result = await checkCustomPath(stalePath);
				expect(result).toEqual({ exists: true, path: currentPath });
				expect(logger.info).toHaveBeenCalledWith(
					'Recovered rotated Codex Desktop path',
					'PathProber',
					expect.objectContaining({ original: stalePath, resolved: currentPath })
				);
			} finally {
				readdirMock.mockRestore();
				if (originalLocalAppData === undefined) {
					delete process.env.LOCALAPPDATA;
				} else {
					process.env.LOCALAPPDATA = originalLocalAppData;
				}
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});

		it('should report unexpected errors while discovering Codex Desktop executables', async () => {
			const originalPlatform = process.platform;
			const originalLocalAppData = process.env.LOCALAPPDATA;
			const readdirMock = vi.spyOn(fs.promises, 'readdir');
			const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';

			const stalePath = path.win32.join(
				process.env.LOCALAPPDATA,
				'OpenAI',
				'Codex',
				'bin',
				'old-version',
				'codex.exe'
			);

			try {
				readdirMock.mockResolvedValue([
					{ name: 'current-version', isDirectory: () => true },
				] as any);
				statMock.mockRejectedValue(permissionError);

				expect(await checkCustomPath(stalePath)).toEqual({ exists: false });
				expect(captureException).toHaveBeenCalledWith(permissionError);
			} finally {
				readdirMock.mockRestore();
				if (originalLocalAppData === undefined) {
					delete process.env.LOCALAPPDATA;
				} else {
					process.env.LOCALAPPDATA = originalLocalAppData;
				}
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});

		it('should not redirect an arbitrary missing custom path', async () => {
			const originalPlatform = process.platform;
			const readdirMock = vi.spyOn(fs.promises, 'readdir');
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				statMock.mockRejectedValue(new Error('ENOENT'));

				expect(await checkCustomPath('C:\\custom\\missing-codex.exe')).toEqual({
					exists: false,
				});
				expect(readdirMock).not.toHaveBeenCalled();
			} finally {
				readdirMock.mockRestore();
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});
	});

	describe('probeWindowsPaths', () => {
		let accessMock: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			accessMock.mockRestore();
		});

		it('should return null for unknown binary', async () => {
			accessMock.mockRejectedValue(new Error('ENOENT'));

			const result = await probeWindowsPaths('unknown-binary');
			expect(result).toBeNull();
		});

		it('should probe known paths for claude binary', async () => {
			// All paths fail - binary not found
			accessMock.mockRejectedValue(new Error('ENOENT'));

			const result = await probeWindowsPaths('claude');
			// Should return null since all probes fail
			expect(result).toBeNull();
			// Should have tried multiple paths
			expect(accessMock).toHaveBeenCalled();
		});

		it.each(['hermes', 'pi'])('should probe known Windows paths for %s', async (binaryName) => {
			accessMock.mockRejectedValue(new Error('ENOENT'));

			expect(await probeWindowsPaths(binaryName)).toBeNull();
			expect(accessMock).toHaveBeenCalled();
		});

		it('leads with the WinGet install for copilot, over an npm shim', async () => {
			// Regression guard for the Windows half of the key fix: this table was
			// keyed `'copilot-cli'` (the agent id) while it is looked up with
			// `agentDef.binaryName`, which is `copilot`, so none of its candidates
			// were reachable. Both paths exist here, so this pins the order too,
			// not just that the entry can be reached at all.
			const home = os.homedir();
			const wingetPath = path.join(
				process.env.ProgramFiles || 'C:\\Program Files',
				'GitHub Copilot CLI',
				'copilot.exe'
			);
			const npmShim = path.join(
				process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
				'npm',
				'copilot.cmd'
			);
			accessMock.mockImplementation(async (probePath) => {
				const candidate = String(probePath);
				if (candidate === wingetPath || candidate === npmShim) return undefined;
				throw new Error('ENOENT');
			});

			expect(await probeWindowsPaths('copilot')).toBe(wingetPath);
		});

		it('should probe the current Codex Desktop executable', async () => {
			const originalLocalAppData = process.env.LOCALAPPDATA;
			const readdirMock = vi.spyOn(fs.promises, 'readdir');
			const statMock = vi.spyOn(fs.promises, 'stat');
			process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
			const currentPath = path.win32.join(
				process.env.LOCALAPPDATA,
				'OpenAI',
				'Codex',
				'bin',
				'current-version',
				'codex.exe'
			);

			try {
				readdirMock.mockResolvedValue([
					{ name: 'current-version', isDirectory: () => true },
				] as any);
				statMock.mockResolvedValue({ isFile: () => true, birthtimeMs: 200 } as fs.Stats);
				accessMock.mockImplementation(async (filePath) => {
					if (filePath !== currentPath) throw new Error('ENOENT');
				});

				expect(await probeWindowsPaths('codex')).toBe(currentPath);
			} finally {
				readdirMock.mockRestore();
				statMock.mockRestore();
				if (originalLocalAppData === undefined) {
					delete process.env.LOCALAPPDATA;
				} else {
					process.env.LOCALAPPDATA = originalLocalAppData;
				}
			}
		});
	});

	describe('probeUnixPaths', () => {
		let accessMock: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			accessMock.mockRestore();
		});

		it.each(['hermes', 'pi'])('should probe known Unix paths for %s', async (binaryName) => {
			accessMock.mockRejectedValue(new Error('ENOENT'));

			expect(await probeUnixPaths(binaryName)).toBeNull();
			expect(accessMock).toHaveBeenCalled();
		});

		it('should return null for unknown binary', async () => {
			accessMock.mockRejectedValue(new Error('ENOENT'));

			const result = await probeUnixPaths('unknown-binary');
			expect(result).toBeNull();
		});

		it('should probe known paths for claude binary', async () => {
			// All paths fail - binary not found
			accessMock.mockRejectedValue(new Error('ENOENT'));

			const result = await probeUnixPaths('claude');
			// Should return null since all probes fail
			expect(result).toBeNull();
			// Should have tried multiple paths
			expect(accessMock).toHaveBeenCalled();
		});
	});

	/**
	 * The known-path table is what finds an agent installed off PATH, and each
	 * agent's order encodes where its own installer puts things. The tests above
	 * reject every candidate and assert `null`, which passes whatever the table
	 * says; these pin the candidates and their order, on a platform where
	 * Homebrew has two roots and the installers do not agree on one location.
	 *
	 * Named for macOS because these are the macOS install locations, not because
	 * the code branches: `getUnixKnownPaths` never reads `process.platform`. The
	 * platform stub below only keeps the suite honest if that ever changes.
	 */
	describe('probeUnixPaths on macOS', () => {
		// The real homedir, deliberately: the candidate table builds its paths
		// with `os.homedir()`, not the `expandTilde` this file mocks to
		// /Users/testuser (that one only serves `checkCustomPath`).
		const home = os.homedir();
		let accessMock: ReturnType<typeof vi.spyOn>;
		let originalPlatform: NodeJS.Platform;

		/** Resolve only for these paths, as `access(F_OK | X_OK)` would. */
		const onlyExecutable = (...existing: string[]) => {
			accessMock.mockImplementation(async (probePath) => {
				if (existing.includes(String(probePath))) return undefined;
				throw new Error('ENOENT');
			});
		};

		beforeEach(() => {
			originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			accessMock.mockRestore();
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});

		it("prefers Claude's own install location over everything else", async () => {
			onlyExecutable(
				path.join(home, '.claude', 'local', 'claude'),
				path.join(home, '.local', 'bin', 'claude'),
				'/opt/homebrew/bin/claude',
				'/usr/local/bin/claude'
			);

			expect(await probeUnixPaths('claude')).toBe(path.join(home, '.claude', 'local', 'claude'));
		});

		it('falls to ~/.local/bin when Claude has no local install', async () => {
			onlyExecutable(
				path.join(home, '.local', 'bin', 'claude'),
				'/opt/homebrew/bin/claude',
				'/usr/local/bin/claude'
			);

			expect(await probeUnixPaths('claude')).toBe(path.join(home, '.local', 'bin', 'claude'));
		});

		it('prefers the Apple Silicon Homebrew root over the Intel one', async () => {
			onlyExecutable('/opt/homebrew/bin/claude', '/usr/local/bin/claude');

			expect(await probeUnixPaths('claude')).toBe('/opt/homebrew/bin/claude');
		});

		it('still finds an Intel Homebrew install on its own', async () => {
			onlyExecutable('/usr/local/bin/claude');

			expect(await probeUnixPaths('claude')).toBe('/usr/local/bin/claude');
		});

		it('passes X_OK to access, so a non-executable candidate cannot match', async () => {
			// Note the limit of this assertion: F_OK is 0, so `F_OK | X_OK` IS
			// `X_OK`. It catches the probe dropping X_OK; it cannot catch X_OK
			// being widened. A non-executable file is also indistinguishable from
			// a missing one through a mocked `access`, so the flags are the only
			// observable part.
			onlyExecutable('/opt/homebrew/bin/claude');

			expect(await probeUnixPaths('claude')).toBe('/opt/homebrew/bin/claude');
			expect(accessMock).toHaveBeenCalledWith(
				path.join(home, '.claude', 'local', 'claude'),
				fs.constants.X_OK
			);
		});

		it('leads with Homebrew for copilot, its primary macOS install', async () => {
			// Regression guard: this table was keyed `'copilot-cli'` (the agent id)
			// while it is looked up with `agentDef.binaryName`, which is `copilot`.
			// Every candidate below was therefore unreachable on both platforms and
			// only which/where ever found Copilot.
			onlyExecutable('/opt/homebrew/bin/copilot', path.join(home, '.local', 'bin', 'copilot'));

			expect(await probeUnixPaths('copilot')).toBe('/opt/homebrew/bin/copilot');
		});

		it("leads with OpenCode's own installer location over a Go install", async () => {
			onlyExecutable(
				path.join(home, '.opencode', 'bin', 'opencode'),
				path.join(home, 'go', 'bin', 'opencode')
			);

			expect(await probeUnixPaths('opencode')).toBe(
				path.join(home, '.opencode', 'bin', 'opencode')
			);
		});
	});

	describe('checkBinaryExists', () => {
		let accessMock: ReturnType<typeof vi.spyOn>;
		const execMock = vi.mocked(execFileNoThrow);

		beforeEach(() => {
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			accessMock.mockRestore();
		});

		it('should try direct probe first on Unix', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Direct probe finds the binary (first path in the list exists)
				accessMock.mockResolvedValueOnce(undefined);

				const result = await checkBinaryExists('claude');
				expect(result.exists).toBe(true);
				expect(result.path).toContain('claude');
				// which should not be called if direct probe succeeds
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should fall back to which on Unix if probe fails', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Direct probe fails
				accessMock.mockRejectedValue(new Error('ENOENT'));

				// which succeeds
				execMock.mockResolvedValue({
					exitCode: 0,
					stdout: '/usr/local/bin/test-binary\n',
					stderr: '',
				});

				const result = await checkBinaryExists('test-binary');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('/usr/local/bin/test-binary');
				expect(execMock).toHaveBeenCalledWith(
					'which',
					['test-binary'],
					undefined,
					expect.any(Object)
				);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should use where on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				// Direct probe fails
				accessMock.mockRejectedValue(new Error('ENOENT'));

				// where succeeds
				execMock.mockResolvedValue({
					exitCode: 0,
					stdout: 'C:\\Users\\Test\\AppData\\Roaming\\npm\\test.cmd\r\n',
					stderr: '',
				});

				const result = await checkBinaryExists('test');
				expect(result.exists).toBe(true);
				expect(execMock).toHaveBeenCalledWith('where', ['test'], undefined, expect.any(Object));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should return exists: false if binary not found', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Direct probe fails
				accessMock.mockRejectedValue(new Error('ENOENT'));

				// which fails
				execMock.mockResolvedValue({
					exitCode: 1,
					stdout: '',
					stderr: 'not found',
				});

				const result = await checkBinaryExists('non-existent');
				expect(result.exists).toBe(false);
				expect(result.path).toBeUndefined();
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should prefer .exe over .cmd on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				// Direct probe fails
				accessMock.mockRejectedValue(new Error('ENOENT'));

				// where returns both .exe and .cmd
				execMock.mockResolvedValue({
					exitCode: 0,
					stdout: 'C:\\path\\to\\binary.cmd\r\nC:\\path\\to\\binary.exe\r\n',
					stderr: '',
				});

				const result = await checkBinaryExists('binary');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('C:\\path\\to\\binary.exe');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should handle Windows CRLF line endings', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				accessMock.mockRejectedValue(new Error('ENOENT'));

				execMock.mockResolvedValue({
					exitCode: 0,
					stdout: 'C:\\path\\to\\binary.exe\r\n',
					stderr: '',
				});

				const result = await checkBinaryExists('binary');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('C:\\path\\to\\binary.exe');
				// Path should not contain \r
				expect(result.path).not.toContain('\r');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});
	});

	describe('findAllBinaryPaths', () => {
		let accessMock: ReturnType<typeof vi.spyOn>;
		let realpathMock: ReturnType<typeof vi.spyOn>;
		const mockedExec = execFileNoThrow as ReturnType<typeof vi.fn>;

		beforeEach(() => {
			accessMock = vi.spyOn(fs.promises, 'access');
			realpathMock = vi.spyOn(fs.promises, 'realpath');
			// Default: realpath returns the input unchanged (no symlinks)
			realpathMock.mockImplementation(async (p: any) => String(p));
			mockedExec.mockReset();
		});

		afterEach(() => {
			accessMock.mockRestore();
			realpathMock.mockRestore();
		});

		it('returns every existing direct probe match in priority order', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Two homebrew probe locations exist for codex (both are absolute and don't depend on $HOME)
				accessMock.mockImplementation(async (probePath) => {
					const s = String(probePath);
					if (s === '/opt/homebrew/bin/codex' || s === '/usr/local/bin/codex') {
						return undefined;
					}
					throw new Error('ENOENT');
				});
				// `which -a` reports a wrapper script as an additional alternative
				mockedExec.mockResolvedValue({
					exitCode: 0,
					stdout: '/opt/homebrew/bin/codex\n/usr/local/bin/codex-multi-auth-codex\n',
					stderr: '',
				});

				const result = await findAllBinaryPaths('codex');

				expect(result).toContain('/opt/homebrew/bin/codex');
				expect(result).toContain('/usr/local/bin/codex');
				expect(result).toContain('/usr/local/bin/codex-multi-auth-codex');
				// Probed paths come before which-only results
				expect(result.indexOf('/opt/homebrew/bin/codex')).toBeLessThan(
					result.indexOf('/usr/local/bin/codex-multi-auth-codex')
				);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('de-duplicates paths that resolve to the same canonical target', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Probe finds homebrew copy
				accessMock.mockImplementation(async (probePath) => {
					if (String(probePath) === '/opt/homebrew/bin/codex') return undefined;
					throw new Error('ENOENT');
				});
				// `which -a` finds a symlinked alias that resolves to the same real path
				mockedExec.mockResolvedValue({
					exitCode: 0,
					stdout: '/opt/homebrew/bin/codex\n/usr/local/bin/codex\n',
					stderr: '',
				});
				realpathMock.mockImplementation(async (p: any) => {
					// Both paths resolve to the same canonical file
					if (String(p) === '/opt/homebrew/bin/codex' || String(p) === '/usr/local/bin/codex') {
						return '/opt/homebrew/Cellar/codex/1.0.0/bin/codex';
					}
					return String(p);
				});

				const result = await findAllBinaryPaths('codex');

				// Symlinked duplicate is collapsed
				expect(result).toHaveLength(1);
				// Direct-probed path wins (it's first in priority order)
				expect(result[0]).toBe('/opt/homebrew/bin/codex');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('returns empty array when no installations are found', async () => {
			accessMock.mockRejectedValue(new Error('ENOENT'));
			mockedExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

			const result = await findAllBinaryPaths('unknown-binary');
			expect(result).toEqual([]);
		});

		it('still returns probed paths when which command throws', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				accessMock.mockImplementation(async (probePath) => {
					if (String(probePath) === '/opt/homebrew/bin/codex') return undefined;
					throw new Error('ENOENT');
				});
				mockedExec.mockRejectedValue(new Error('spawn ENOENT'));

				const result = await findAllBinaryPaths('codex');
				expect(result).toEqual(['/opt/homebrew/bin/codex']);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});
	});

	describe('BinaryDetectionResult type', () => {
		it('should allow exists: true with path', () => {
			const result: BinaryDetectionResult = {
				exists: true,
				path: '/usr/local/bin/claude',
			};
			expect(result.exists).toBe(true);
			expect(result.path).toBeDefined();
		});

		it('should allow exists: false without path', () => {
			const result: BinaryDetectionResult = {
				exists: false,
			};
			expect(result.exists).toBe(false);
			expect(result.path).toBeUndefined();
		});
	});
});
